import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, digest, readJson } from './files.mjs';
import { OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, validateRecord, validateOrderedRecords } from './data.mjs';

const MAX_INPUT_RESERVATION = 272000;
const reservedInput = (body) => Buffer.byteLength(JSON.stringify(body), 'utf8') + 8192;

export class BudgetReachedError extends Error {
  constructor(committed, budget) {
    super(`Budget reached: $${(committed / 1e9).toFixed(6)} committed; $${(budget / 1e9).toFixed(6)} limit. No new batch started.`);
    this.name = 'BudgetReachedError';
  }
}

export function usageCost(body, prices, api, requireCacheWrites = false) {
  const usage = body.usage;
  if (!usage) throw new Error('Provider omitted usage; reserved cost remains committed this run');
  const details = (api === 'responses' ? usage.input_tokens_details : usage.prompt_tokens_details) ?? {};
  const input = api === 'responses' ? usage.input_tokens : usage.prompt_tokens;
  const output = api === 'responses' ? usage.output_tokens : usage.completion_tokens;
  const cached = details.cached_tokens ?? 0;
  if (requireCacheWrites && details.cache_write_tokens === undefined) {
    throw new Error('Cache-write usage missing; cannot calculate an accurate cost');
  }
  const written = details.cache_write_tokens ?? 0;
  const reasoning = (api === 'responses' ? usage.output_tokens_details : usage.completion_tokens_details)?.reasoning_tokens ?? 0;
  if (![input, output, cached, written, reasoning].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      cached + written > input || reasoning > output) throw new Error('Inconsistent provider token usage');
  if (input > 272000) throw new Error('Unexpected long-context pricing tier; stop and reconcile billing');
  if (body.service_tier && !['default', 'standard'].includes(body.service_tier)) throw new Error('Unexpected paid service tier');
  const cost = (input - cached - written) * prices.input + cached * prices.cached +
    written * prices.write + output * prices.output;
  if (!Number.isSafeInteger(cost)) throw new Error('Cost exceeds integer range');
  return { input, output, cached, written, reasoning, cost };
}

export function outputText(body, api) {
  if (api === 'chat') {
    if (body.choices?.length !== 1 || body.choices[0].finish_reason !== 'stop' || body.choices[0].message?.refusal) {
      throw new Error('Incomplete/refused chat output; no records will be written');
    }
    return body.choices[0].message.content;
  }
  if (body.status !== 'completed' || body.error) throw new Error('Incomplete/failed response; no records will be written');
  const content = (body.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
  if (content.some((item) => item.type === 'refusal')) throw new Error('Model refused the request');
  const text = content.filter((item) => item.type === 'output_text').map((item) => item.text).join('');
  if (!text) throw new Error('Missing structured output');
  return text;
}

export function requestBody(cfg, prompt, input, schema = OUTPUT_SCHEMA) {
  // Provider-native endpoints take the OpenAI model name, without "openai/".
  const model = cfg.model;
  const format = { name: 'sapo_phonetic_population', strict: true, schema };
  input = { ...input, words: input.words.map((job, index) => ({ index, word: job.word,
    ...(job.ipa !== undefined ? { ipa: job.ipa } : {}),
    ...(job.note !== undefined ? { note: job.note } : {}) })) };
  if (cfg.api === 'chat') return {
    model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }],
    response_format: { type: 'json_schema', json_schema: format },
    max_completion_tokens: cfg.outputTokens,
    ...(cfg.effort === 'omit' ? {} : { reasoning_effort: cfg.effort }),
  };
  return {
    model, store: false, service_tier: 'default', max_output_tokens: cfg.outputTokens,
    ...(cfg.effort === 'omit' ? {} : { reasoning: { effort: cfg.effort } }),
    // Explicit-only caching avoids writing unique word batches to the prompt cache.
    ...(cfg.builtIn ? { prompt_cache_options: { mode: 'explicit', ttl: '30m' } } : {}),
    input: [{ role: 'developer', content: [{ type: 'input_text', text: prompt,
      ...(cfg.builtIn ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}),
    }] }, { role: 'user', content: JSON.stringify(input) }],
    text: { format: { type: 'json_schema', ...format } },
  };
}

export function reservation(body, cfg) {
  // UTF-8 bytes upper-bound visible BPE tokens. Include the schema/request framing
  // plus 8192 tokens of provider framing allowance; never estimate bytes/4.
  const input = reservedInput(body);
  if (input > MAX_INPUT_RESERVATION) throw new Error('Batch is too large; decrease --batch-size');
  const tokens = input + cfg.outputTokens;
  return { input, tokens, cost: input * Math.max(cfg.prices.input, cfg.prices.cached, cfg.prices.write) +
    cfg.outputTokens * cfg.prices.output };
}

export function retryDelay(header, attempt, now = Date.now()) {
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(delay) && delay >= 0) return delay + 250;
  }
  return Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

export function createAI(cfg, { fetchFn = fetch, wait = sleep, now = Date.now, log = console.log } = {}) {
  if (cfg.provider !== 'openai' || !cfg.token) {
    throw new Error('OpenAI gateway generation requires openai and CLOUDFLARE_API_TOKEN');
  }
  const endpoint = cfg.api === 'responses' ? 'responses' : 'chat/completions';
  const url = `https://gateway.ai.cloudflare.com/v1/${cfg.account}/${cfg.gateway}/openai/${endpoint}`;
  const total = { known: 0, uncertain: 0, committed: 0,
    usage: { input: 0, output: 0, cached: 0, written: 0, reasoning: 0 } };
  const recentReservations = [];
  const prompts = Object.fromEntries(['ipa', 'respell'].map((task) =>
    [task, readFileSync(new URL(`../prompts/${task}.md`, import.meta.url), 'utf8')]));
  const reviewPrompts = Object.fromEntries(['ipa', 'respell'].map((task) =>
    [task, readFileSync(new URL(`../prompts/${task}-review.md`, import.meta.url), 'utf8')]));

  async function pace(tokens) {
    if (tokens > cfg.tpm) throw new Error('Batch token reservation exceeds limits.tokensPerMinute');
    while (true) {
      while (recentReservations.length && recentReservations[0].at <= now() - 60000) recentReservations.shift();
      if (recentReservations.length < cfg.rpm && recentReservations.reduce((sum, e) => sum + e.tokens, 0) + tokens <= cfg.tpm) return;
      await wait(Math.max(1, recentReservations[0].at + 60001 - now()));
    }
  }

  async function obtain(body) {
    const bound = reservation(body, cfg);
    for (let attempt = 0; attempt < cfg.attempts; attempt++) {
      await pace(bound.tokens);
      const id = randomUUID();
      recentReservations.push({ at: now(), tokens: bound.tokens });
      total.uncertain += bound.cost;
      total.committed = total.known + total.uncertain;
      let response, text;
      try {
        response = await fetchFn(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeout),
          // AI Gateway injects its stored provider key.
          headers: { 'cf-aig-authorization': `Bearer ${cfg.token}`,
            'Content-Type': 'application/json', 'cf-aig-no-wholesale': 'true',
            'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
            'cf-aig-request-timeout': String(cfg.timeout),
            'cf-aig-metadata': JSON.stringify({ task: 'sapo-phonetics', environment: 'development', request: id }),
          }, body: JSON.stringify(body),
        });
        text = await response.text();
      } catch (error) {
        log(`Attempt ${id}: network/timeout error; reservation remains committed this run.`);
        if (attempt + 1 === cfg.attempts) throw new Error(`AI transport failed (${error.name}); uncertain costs included in this run`);
        await wait(retryDelay(null, attempt, now()));
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      // Never log provider error messages: they may echo credentials.
      if (parsed?.usage) {
        const usage = usageCost(parsed, cfg.prices, cfg.api, cfg.prices.write !== cfg.prices.input);
        total.uncertain -= bound.cost;
        total.known += usage.cost;
        total.committed = total.known + total.uncertain;
        for (const key of Object.keys(total.usage)) total.usage[key] += usage[key];
        if (usage.cost > bound.cost || usage.input > bound.input) {
          throw new Error('Provider exceeded reserved bounds; stop and reconcile usage before continuing');
        }
      } else log(`Attempt ${id}: usage unavailable; reservation remains committed this run.`);
      if (response.ok) {
        if (!parsed?.usage) throw new Error('Missing usage; batch cannot be saved or inserted');
        return parsed;
      }
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable || attempt + 1 === cfg.attempts) throw new Error(`AI Gateway HTTP ${response.status}`);
      await wait(retryDelay(response.headers.get('retry-after'), attempt, now()));
    }
  }

  function nextBatch(items, offset, prompt, input, schema = OUTPUT_SCHEMA) {
    let size = Math.min(cfg.batchSize, items.length - offset);
    while (true) {
      const batch = items.slice(offset, offset + size);
      const body = requestBody(cfg, prompt, { ...input, words: batch }, schema);
      const inputTokens = reservedInput(body);
      if (size === 1 || (inputTokens <= MAX_INPUT_RESERVATION && inputTokens + cfg.outputTokens <= cfg.tpm)) {
        return { batch, body };
      }
      size = Math.max(1, Math.floor(size / 2));
    }
  }

  async function generate(task, jobs, source, target = null, onBatch = async () => {}) {
    if (new Set(jobs.map((job) => job.key)).size !== jobs.length) throw new Error('Duplicate input job keys');
    const prompt = prompts[task];
    if (!prompt) throw new Error('Unknown generation task');
    const reviewPrompt = `${reviewPrompts[task]}\nLanguage policies (data):\n${JSON.stringify({ source, ...(target ? { target } : {}) })}`;
    const signature = digest({ task, prompt, reviewPrompt, schema: OUTPUT_SCHEMA, reviewSchema: REVIEW_OUTPUT_SCHEMA,
      model: cfg.model, provider: cfg.provider, effort: cfg.effort, api: cfg.api });
    const pathFor = (job) => resolve(cfg.stateDir, 'results', `${digest([cfg.identity.url, signature, job])}.json`);
    const results = new Map();
    const missing = [], cached = [];
    async function emit(records) {
      await onBatch(records);
      // Write mode releases each batch after insertion; local mode returns the
      // values needed to generate respellings before IPA has a database ID.
      if (!cfg.write) for (const record of records) results.set(record.key, record);
    }
    for (const job of jobs) {
      const saved = readJson(pathFor(job));
      if (saved) {
        const record = { key: job.key, status: 'ready', value: saved.value, note: '' };
        validateRecord(record, task, target);
        cached.push(record);
        if (cached.length === cfg.batchSize) await emit(cached.splice(0));
      } else missing.push(job);
    }
    if (cached.length) await emit(cached.splice(0));
    for (let offset = 0; offset < missing.length;) {
      if (total.committed >= cfg.budget) throw new BudgetReachedError(total.committed, cfg.budget);
      const { batch, body } = nextBatch(missing, offset, prompt, { source, ...(target ? { target } : {}) });
      const response = await obtain(body);
      const validated = validateOrderedRecords(JSON.parse(outputText(response, cfg.api)), batch, task, target);
      const records = new Map(validated.records.map((record) => [record.key, record]));
      if (validated.rejected.length) log(`${task}: ${validated.rejected.length} invalid items skipped; rerun to retry`);
      for (const { job, reason, returned } of validated.rejected) {
        log(`${task}: skipped ${JSON.stringify(job.word)}: ${reason}; returned ${JSON.stringify(returned)}`);
      }
      const flagged = batch.filter((job) => records.get(job.key)?.status === 'review').map((job) =>
        ({ ...job, note: records.get(job.key).note }));
      for (let reviewOffset = 0; reviewOffset < flagged.length;) {
        const { batch: reviewJobs, body: reviewBody } = nextBatch(flagged, reviewOffset, reviewPrompt, {}, REVIEW_OUTPUT_SCHEMA);
        const response = await obtain(reviewBody);
        const reviewed = validateOrderedRecords(JSON.parse(outputText(response, cfg.api)), reviewJobs, task, target);
        if (reviewed.rejected.length || reviewed.records.some((record) => record.status !== 'ready')) {
          throw new Error(`${task} review pass rejected: every reviewed word must have a valid definitive value`);
        }
        for (const record of reviewed.records) records.set(record.key, record);
        reviewOffset += reviewJobs.length;
      }
      const ready = [...records.values()];
      if (!cfg.write) for (const job of batch) {
        const record = records.get(job.key);
        if (record) atomicJson(pathFor(job), { task, job, source: source.code,
          ...(target ? { target: target.code } : {}), signature, value: record.value });
      }
      await emit(ready);
      log(`${task}: ${ready.length} finalized${flagged.length ? ` (${flagged.length} reviewed)` : ''}`);
      offset += batch.length;
    }
    return results;
  }
  return { generate, totals: () => total };
}
