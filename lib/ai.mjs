import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendEvent, atomicJson, digest, journal, readJson } from './files.mjs';
import { OUTPUT_SCHEMA, validateRecords } from './data.mjs';

export function usageCost(body, prices, api, requireCacheWrites = false) {
  const usage = body.usage;
  if (!usage) throw new Error('Provider omitted usage; reserved cost remains charged');
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

export function requestBody(cfg, prompt, input) {
  // Provider-native endpoints take the OpenAI model name, without "openai/".
  const model = cfg.model;
  const format = { name: 'sapo_phonetic_population', strict: true, schema: OUTPUT_SCHEMA };
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
  const input = Buffer.byteLength(JSON.stringify(body), 'utf8') + 8192;
  if (input > 64000) throw new Error('Batch is too large; decrease --batch-size');
  const tokens = input + cfg.outputTokens;
  return { input, tokens, cost: input * Math.max(cfg.prices.input, cfg.prices.cached, cfg.prices.write) +
    cfg.outputTokens * cfg.prices.output };
}

export function ledgerTotals(events) {
  const requests = new Map();
  for (const event of events) {
    if (event.type === 'reserve') {
      if (![event.cost, event.input, event.tokens, event.at].every((n) => Number.isSafeInteger(n) && n >= 0)) {
        throw new Error('Invalid reservation counters in ledger');
      }
      if (requests.has(event.id)) throw new Error('Duplicate reservation in ledger');
      requests.set(event.id, { ...event, settlement: null });
    } else if (event.type === 'settle') {
      const request = requests.get(event.id);
      if (!request || request.settlement) throw new Error('Invalid settlement in ledger');
      if (!['cost', 'input', 'output', 'cached', 'written', 'reasoning'].every((key) =>
        Number.isSafeInteger(event.usage?.[key]) && event.usage[key] >= 0)) throw new Error('Invalid settlement counters in ledger');
      request.settlement = event;
    } else throw new Error('Unknown ledger event');
  }
  let known = 0, uncertain = 0;
  const usage = { input: 0, output: 0, cached: 0, written: 0, reasoning: 0 };
  for (const request of requests.values()) {
    if (request.settlement) {
      known += request.settlement.usage.cost;
      for (const name of Object.keys(usage)) usage[name] += request.settlement.usage[name];
    } else uncertain += request.cost;
  }
  if (!Number.isSafeInteger(known + uncertain)) throw new Error('Ledger totals exceed integer range');
  return { requests, known, uncertain, committed: known + uncertain, usage };
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
  const ledgerPath = resolve(cfg.stateDir, 'usage.jsonl');
  const events = journal(ledgerPath);
  const total = ledgerTotals(events);
  const recentReservations = events.filter((e) => e.type === 'reserve' && e.at > now() - 60000);
  const prompts = Object.fromEntries(['ipa', 'respell'].map((task) =>
    [task, readFileSync(new URL(`../prompts/${task}.md`, import.meta.url), 'utf8')]));

  function record(event) {
    appendEvent(ledgerPath, event);
    if (event.type === 'reserve') {
      total.requests.set(event.id, { ...event, settlement: null });
      total.uncertain += event.cost;
      recentReservations.push(event);
    } else {
      const request = total.requests.get(event.id);
      request.settlement = event;
      total.uncertain -= request.cost;
      total.known += event.usage.cost;
      for (const key of Object.keys(total.usage)) total.usage[key] += event.usage[key];
    }
    total.committed = total.known + total.uncertain;
  }
  function totals() { return total; }
  function settle(request, artifact) {
    const usage = usageCost(artifact.body, request.prices, request.api, request.requireCacheWrites);
    record({ type: 'settle', id: request.id, at: now(), usage, responseId: artifact.body.id ?? null });
    if (usage.cost > request.cost || usage.input > request.input) {
      throw new Error('Provider exceeded reserved bounds; stop and reconcile usage before continuing');
    }
  }

  // A response saved before a process crash can be accounted for without a call.
  for (const request of totals().requests.values()) {
    if (request.settlement && (request.settlement.usage.cost > request.cost || request.settlement.usage.input > request.input)) {
      throw new Error('A previous request exceeded its reservation; reconcile before continuing');
    }
    const artifact = readJson(resolve(cfg.stateDir, 'attempts', `${request.id}.json`));
    if (!artifact) continue;
    if (!request.settlement && artifact.body?.usage) settle(request, artifact);
    if (artifact.status === 200 && artifact.body?.usage) {
      const path = resolve(cfg.stateDir, 'responses', `${request.digest}.json`);
      if (!readJson(path)) atomicJson(path, artifact.body);
    }
  }

  async function pace(tokens) {
    if (tokens > cfg.tpm) throw new Error('Batch token reservation exceeds limits.tokensPerMinute');
    while (true) {
      while (recentReservations.length && recentReservations[0].at <= now() - 60000) recentReservations.shift();
      if (recentReservations.length < cfg.rpm && recentReservations.reduce((sum, e) => sum + e.tokens, 0) + tokens <= cfg.tpm) return;
      await wait(Math.max(1, recentReservations[0].at + 60001 - now()));
    }
  }

  async function obtain(body) {
    const hash = digest([url, body]);
    const responsePath = resolve(cfg.stateDir, 'responses', `${hash}.json`);
    const cached = readJson(responsePath);
    if (cached) return cached;
    const bound = reservation(body, cfg);
    for (let attempt = 0; attempt < cfg.attempts; attempt++) {
      await pace(bound.tokens);
      if (totals().committed + bound.cost > cfg.budget) {
        throw new Error(`Budget exhausted: $${(totals().committed / 1e9).toFixed(6)} committed; next attempt reserves $${(bound.cost / 1e9).toFixed(6)}`);
      }
      const id = randomUUID();
      const request = { type: 'reserve', id, digest: hash, at: now(), ...bound, prices: cfg.prices,
        api: cfg.api, model: cfg.model, provider: cfg.provider,
        requireCacheWrites: cfg.prices.write !== cfg.prices.input };
      record(request); // Durable reservation BEFORE sending any billable request.
      let response, text;
      try {
        response = await fetchFn(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeout),
          // No provider Authorization header: AI Gateway injects its stored key.
          headers: { 'cf-aig-authorization': `Bearer ${cfg.token}`,
            'Content-Type': 'application/json', 'cf-aig-no-wholesale': 'true',
            'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
            'cf-aig-request-timeout': String(cfg.timeout),
            'cf-aig-metadata': JSON.stringify({ task: 'sapo-phonetics', environment: 'development', request: id }),
          }, body: JSON.stringify(body),
        });
        text = await response.text();
      } catch (error) {
        log(`Attempt ${id}: network/timeout error; full reservation remains charged.`);
        if (attempt + 1 === cfg.attempts) throw new Error(`AI transport failed (${error.name}); uncertain costs retained`);
        await wait(retryDelay(null, attempt, now()));
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      // Provider errors may echo API keys. Keep only billing fields from errors,
      // never their messages; successful response artifacts retain the output.
      const artifact = { status: response.status, body: response.ok ? parsed : parsed?.usage ? {
        id: parsed.id ?? null, usage: parsed.usage, service_tier: parsed.service_tier,
      } : null, receivedAt: now() };
      atomicJson(resolve(cfg.stateDir, 'attempts', `${id}.json`), artifact);
      if (parsed?.usage) settle(request, artifact);
      else log(`Attempt ${id}: usage unavailable; full reservation remains charged.`);
      if (response.ok) {
        if (!parsed?.usage) throw new Error('Missing usage; no database writes, reconcile gateway logs');
        atomicJson(responsePath, parsed);
        return parsed;
      }
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable || attempt + 1 === cfg.attempts) throw new Error(`AI Gateway HTTP ${response.status}; costs retained`);
      await wait(retryDelay(response.headers.get('retry-after'), attempt, now()));
    }
  }

  async function generate(task, jobs, source, target = null) {
    const prompt = prompts[task];
    const signature = { task, prompt, schema: OUTPUT_SCHEMA, source, target,
      model: cfg.model, provider: cfg.provider, effort: cfg.effort, api: cfg.api };
    const paths = new Map(jobs.map((job) => [job.key,
      resolve(cfg.stateDir, 'results', `${digest([cfg.identity.url, signature, job])}.json`)]));
    const results = new Map();
    for (const job of jobs) {
      const cached = readJson(paths.get(job.key));
      if (cached) {
        validateRecords({ records: [cached.record] }, [job], task, target);
        results.set(job.key, cached.record);
      }
    }
    const missing = jobs.filter((job) => !results.has(job.key));
    for (let offset = 0; offset < missing.length; offset += cfg.batchSize) {
      const batch = missing.slice(offset, offset + cfg.batchSize);
      const body = requestBody(cfg, prompt, { source, ...(target ? { target } : {}), words: batch });
      const response = await obtain(body);
      const rows = validateRecords(JSON.parse(outputText(response, cfg.api)), batch, task, target);
      for (const row of rows) {
        atomicJson(paths.get(row.key), { record: row, task, job: batch.find((job) => job.key === row.key), source, target });
        results.set(row.key, row);
      }
      log(`${task}: ${rows.length} generated; ${rows.filter((r) => r.status === 'review').length} need review`);
    }
    return results;
  }
  return { generate, totals };
}
