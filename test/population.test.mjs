import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, developmentIdentity, usd } from '../lib/config.mjs';
import { atomicJson, readJson, journal, lockState } from '../lib/files.mjs';
import { validIpa, validRespelling, validateRecords, choosePair, languagePolicy } from '../lib/data.mjs';
import { createAI, usageCost, requestBody, reservation, ledgerTotals, outputText, retryDelay } from '../lib/ai.mjs';
import { populate } from '../lib/run.mjs';
import { connect } from '../lib/db.mjs';

const identity = { url: 'https://test-dev.convex.cloud' };
const languages = [
  { _id: 'en-id', language_code: 'en', name: 'English', hasEntries: true },
  { _id: 'es-id', language_code: 'es', name: 'Spanish', hasEntries: true },
];
const source = languagePolicy(languages[0]);
const target = languagePolicy(languages[1]);

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(extra = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sapo-phonetics-'));
  temporaryDirectories.push(stateDir);
  const cfg = { ...configured(['--generate', '--budget', '10'], {
    CLOUDFLARE_API_TOKEN: 'fake-gateway-token',
  }, { cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'test' } }), stateDir, identity, ...extra };
  return cfg;
}

function configured(argv = [], env = {}, settings = {}) {
  return configuration('transcriptions', argv, env, () => typeof settings === 'string' ? settings : JSON.stringify(settings));
}

function assertNoCredentials(cfg, directory = cfg.stateDir) {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) assertNoCredentials(cfg, path);
    else {
      const text = readFileSync(path, 'utf8');
      assert.equal(text.includes('fake-openai-key'), false, `OpenAI key leaked to ${file.name}`);
      assert.equal(text.includes(cfg.token), false, `Gateway token leaked to ${file.name}`);
    }
  }
}

function answer(records, extra = {}) {
  return { id: 'response-1', status: 'completed', service_tier: 'default',
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 },
      output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 } },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ records }) }] }], ...extra };
}

const row = (key, value = '/həˈloʊ/') => ({ key, status: 'ready', value, note: '' });

function fakeFetch(counter, transform) {
  return async (url, options) => {
    counter.calls++;
    assert.equal(url, `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/test/openai/responses`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['cf-aig-max-attempts'], '1');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.headers['cf-aig-authorization'], 'Bearer fake-gateway-token');
    assert.equal(options.headers['cf-aig-no-wholesale'], 'true');
    assert.equal(options.headers['cf-aig-gateway-id'], undefined);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.temperature, undefined);
    const input = JSON.parse(body.input[1].content);
    const records = input.words.map((job) => input.target ? row(job.key, 'jelóu') : row(job.key));
    return new Response(JSON.stringify(transform ? transform(records) : answer(records)), { status: 200 });
  };
}

function fakeDatabase(entries, pageSize = 50) {
  const calls = { pages: 0, ipa: 0, respell: 0 };
  let next = 1;
  const db = {
    calls, entries,
    languages: async () => structuredClone(languages),
    page: async ({ languageCode, cursor, targetLanguageCode }) => {
      calls.pages++;
      const all = entries.filter((e) => e.language_code === languageCode);
      const offset = Number(cursor ?? 0);
      const page = all.slice(offset, offset + pageSize).map((entry) => ({ ...structuredClone(entry),
        transcriptions: entry.transcriptions.map((ipa) => ({ ...ipa,
          hasRespelling: (ipa.targets ?? []).includes(targetLanguageCode) })),
      }));
      return { page, continueCursor: String(offset + page.length), isDone: offset + page.length >= all.length };
    },
    insertTranscriptions: async (rows) => {
      calls.ipa++;
      for (const row of rows) {
        const entry = entries.find((e) => e._id === row.entry_id);
        if (!entry.transcriptions.length) entry.transcriptions.push({ _id: `ipa-${next++}`, transcription: row.transcription, targets: [] });
      }
    },
    insertRespellings: async (rows) => {
      calls.respell++;
      for (const row of rows) {
        const ipa = entries.flatMap((e) => e.transcriptions).find((t) => t._id === row.phonetic_transcription_id);
        assert.ok(ipa, 'Respelling must reference a real IPA database ID');
        if (!ipa.targets.includes('es')) ipa.targets.push('es');
      }
    },
  };
  return db;
}

const entry = (id, code = 'en', transcriptions = []) => ({ _id: id, language_id: `${code}-id`,
  language_code: code, orthographic_form: `word-${id}`, transcriptions });

test('production, project, preview, legacy and wrong-development keys fail closed', () => {
  const read = (path) => {
    if (path.endsWith('.env.local')) return 'CONVEX_DEPLOYMENT=dev:test-dev\nEXPO_PUBLIC_CONVEX_URL=https://test-dev.convex.cloud\n';
    return 'EXPO_PUBLIC_CONVEX_URL=https://production.convex.cloud\n';
  };
  for (const key of ['prod:test-dev|secret', 'project:foo|secret', 'preview:foo|secret', 'secret', 'dev:wrong|secret', 'dev:test-dev|']) {
    assert.throws(() => developmentIdentity('/project', key, read));
  }
  assert.equal(developmentIdentity('/project', 'dev:test-dev|secret', read).url, identity.url);
  assert.throws(() => developmentIdentity('/project', 'dev:test-dev|secret', () =>
    'CONVEX_DEPLOYMENT=prod:test-dev\nEXPO_PUBLIC_CONVEX_URL=https://test-dev.convex.cloud'));
  assert.throws(() => developmentIdentity('/project', 'dev:test-dev|secret', () =>
    'CONVEX_DEPLOYMENT=dev:test-dev\nEXPO_PUBLIC_CONVEX_URL=https://test-dev.convex.cloud'));
});

test('configuration is safe by default and custom models require explicit prices', () => {
  const cfg = configured();
  assert.equal(cfg.generate, false);
  assert.equal(cfg.write, false);
  assert.equal(cfg.budget, 0);
  assert.equal(cfg.maxPages, 1);
  assert.throws(() => configured(['--write']));
  assert.throws(() => configured(['--provider', 'anthropic']));
  assert.throws(() => configured(['--batch-size', '0']));
  assert.throws(() => configured(['--prod']));
  assert.throws(() => configured(['--model', 'openai/gpt-6.1-sol']), /native OpenAI/);
  assert.equal(usd('0.123456789'), 123456789);
  assert.throws(() => usd('-1'));
  assert.equal(configured([], {}, { ai: { pricesUsdPerMillion: { input: '1.001' } } }).prices.input, 1001);
  assert.throws(() => configured([], {}, { ai: { reasoningEffort: 'none' } }));
  assert.throws(() => languagePolicy(languages[0], { en: { code: 'es' } }));
  assert.throws(() => languagePolicy(languages[0], { en: { script: 'invalid-script' } }));
});

test('YAML settings, CLI overrides, and credential-only environment variables', () => {
  const cfg = configured(['--budget', '0.123456789', '--batch-size', '5', '--max-pages', '2'], {
    SAPO_CONVEX_DEV_KEY: 'dev:test-dev|fake', CLOUDFLARE_API_TOKEN: 'fake', OPENAI_API_KEY: 'fake-openai-key',
    AI_PROVIDER: 'ignored', AI_MODEL: 'ignored', AI_API: 'ignored', AI_REASONING_EFFORT: 'none',
    AI_INPUT_USD_PER_M: '999', SAPO_MAX_USD: '999', AI_MAX_OUTPUT_TOKENS: '1',
    AI_REQUESTS_PER_MINUTE: '999', AI_TOKENS_PER_MINUTE: '1', AI_MAX_ATTEMPTS: '999', AI_TIMEOUT_MS: '1',
    CLOUDFLARE_ACCOUNT_ID: 'ignored', CLOUDFLARE_AI_GATEWAY_ID: 'ignored', SAPO_LANGUAGE_POLICY_FILE: '/ignored',
  }, `
batchSize: 10
maxPages: 3
ai:
  provider: openai
  model: gpt-6.1-sol
  api: responses
  reasoningEffort: low
  maxOutputTokens: 1000
  pricesUsdPerMillion:
    input: "1.001"
    cachedInput: "0.1"
    cacheWrite: "2.5"
    output: "10"
limits:
  maxUsd: "0.5"
  requestsPerMinute: 2
  tokensPerMinute: 10000
  maxAttempts: 2
  timeoutMs: 5000
cloudflare:
  accountId: "${'a'.repeat(32)}"
  gatewayId: test
languagePolicies:
  es:
    dialect: Castilian Spanish
    script: Latin
`);
  assert.equal(cfg.budget, 123456789);
  assert.equal(cfg.batchSize, 5);
  assert.equal(cfg.maxPages, 2);
  assert.equal(cfg.model, 'gpt-6.1-sol');
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.api, 'responses');
  assert.equal(cfg.effort, 'low');
  assert.equal(cfg.outputTokens, 1000);
  assert.equal(cfg.rpm, 2);
  assert.equal(cfg.tpm, 10000);
  assert.equal(cfg.attempts, 2);
  assert.equal(cfg.timeout, 5000);
  assert.equal(cfg.prices.input, 1001);
  assert.equal(cfg.account, 'a'.repeat(32));
  assert.equal(cfg.gateway, 'test');
  assert.equal(cfg.token, 'fake');
  assert.equal(cfg.openaiKey, undefined);
  assert.equal(cfg.devKey, 'dev:test-dev|fake');
  assert.equal(cfg.generate, false);
  assert.equal(cfg.write, false);
  assert.equal(languagePolicy(languages[1], cfg.languagePolicies).dialect, 'Castilian Spanish');
});

test('YAML rejects unknown settings, invalid types, invalid policies, and unsafe limits', () => {
  for (const settings of [
    { generate: true }, { write: true }, { token: 'secret' }, { cloudflare: { apiToken: 'secret' } },
    { ai: { apiKey: 'secret' } }, { openaiKey: 'secret' },
    { ai: { modle: 'typo' } }, { limits: { maxUsd: 1 } }, { ai: { pricesUsdPerMillion: { input: 2 } } },
    { batchSize: true }, { batchSize: null }, { batchSize: 1.5 }, { batchSize: 0 },
    { ai: [] }, { ai: { model: '' } }, { ai: { api: 'invalid' } },
    { ai: { maxOutputTokens: 0 } }, { limits: { requestsPerMinute: 0 } },
    { limits: { tokensPerMinute: 1 } }, { limits: { maxAttempts: 6 } }, { limits: { timeoutMs: 1 } },
    { cloudflare: { accountId: 'wrong' } }, { cloudflare: { gatewayId: 'invalid/path' } },
    { languagePolicies: [] }, { languagePolicies: { es: { code: 'en' } } },
    { languagePolicies: { es: { script: 'invalid-script' } } },
    { languagePolicies: { es: { dialect: 'bad\npolicy' } } },
  ]) assert.throws(() => configured([], {}, settings), JSON.stringify(settings));
  for (const text of ['', 'null', '[]', 'ai: [']) assert.throws(() => configured([], {}, text));
  assert.throws(() => configured([], {}, 'batchSize: .nan'));
  assert.throws(() => configured(['--generate', '--budget', '1']), /Cloudflare/);
  assert.throws(() => configured(['--generate'], { CLOUDFLARE_API_TOKEN: 'fake', OPENAI_API_KEY: 'fake-openai-key' }, {
    cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'test' },
  }), /positive/);
});

test('alternate YAML models require complete prices and cannot reuse another model price table', () => {
  const ai = { provider: 'openai', model: 'test-model', api: 'chat', reasoningEffort: 'omit',
    pricesUsdPerMillion: { input: '1', cachedInput: '1', cacheWrite: '1', output: '2' } };
  assert.equal(configured([], {}, { ai }).api, 'chat');
  for (const name of Object.keys(ai.pricesUsdPerMillion)) {
    const prices = { ...ai.pricesUsdPerMillion };
    delete prices[name];
    assert.throws(() => configured([], {}, { ai: { ...ai, pricesUsdPerMillion: prices } }), /four explicit/);
  }
  assert.throws(() => configured(['--model', 'different-model'], {}, { ai }), /does not match/);
  assert.throws(() => configured(['--provider', 'other'], {}, { ai }), /only openai/);
});

test('generation needs only gateway credentials and ignores local OpenAI keys', () => {
  const settings = { cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'test' } };
  for (const key of [undefined, '', '   ', 'fake-openai-key']) {
    const cfg = configured(['--generate', '--budget', '1'], {
      CLOUDFLARE_API_TOKEN: 'fake', OPENAI_API_KEY: key,
    }, settings);
    assert.equal(cfg.generate, true);
    assert.equal(cfg.openaiKey, undefined);
  }
  assert.throws(() => configured(['--generate', '--budget', '1'], {
    OPENAI_API_KEY: 'fake-openai-key',
  }, settings), /Cloudflare/);
  assert.equal(configured([], {}, settings).generate, false);
  for (const provider of ['anthropic', 'workers-ai']) {
    assert.throws(() => configured([], {}, { ai: { provider } }), /only openai/);
    assert.throws(() => createAI(fixture({ provider })), /OpenAI gateway/);
  }
  assert.ok(createAI(fixture()));
  assert.throws(() => createAI(fixture({ token: undefined })), /CLOUDFLARE_API_TOKEN/);
});

test('config files are selected explicitly and YAML paths resolve relative to the selected file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sapo-config-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'settings.yml');
  writeFileSync(path, 'project: ./checkout\nstateDir: ./state\nlimits:\n  maxUsd: "0.25"\n');
  const cfg = configuration('transcriptions', ['--config', path], {});
  assert.equal(cfg.project, join(directory, 'checkout'));
  assert.equal(cfg.stateDir, join(directory, 'state'));
  assert.equal(cfg.budget, 250000000);
  assert.equal(cfg.generate, false);
  const overridden = configuration('transcriptions', ['--config', path, '--project', directory, '--state-dir', directory], {});
  assert.equal(overridden.project, directory);
  assert.equal(overridden.stateDir, directory);
  assert.throws(() => configuration('transcriptions', ['--config', join(directory, 'missing.yml')], {}), /ENOENT/);
  assert.deepEqual(configuration('transcriptions', ['--help', '--config', '/missing'], {}), { help: true });
  for (const task of ['transcriptions', 'respellings']) {
    const defaultPath = new URL(`../config/${task}.yml`, import.meta.url);
    const defaults = configuration(task, [], {}, (selected, encoding) => {
      assert.equal(selected, defaultPath.pathname);
      return readFileSync(defaultPath, encoding);
    });
    assert.equal(defaults.budget, 1e9);
    assert.equal(defaults.project, join(homedir(), 'development/react-native/sapo'));
    assert.equal(defaults.generate, false);
    assert.equal(defaults.write, false);
    const custom = configuration(task, ['--config', path], {});
    assert.equal(custom.budget, 250000000);
    assert.equal(custom.stateDir, join(directory, 'state'));
  }
});

test('script defaults load only their own settings while preserving the shared ledger', () => {
  const settings = { transcriptions: 'batchSize: 5', respellings: 'batchSize: 10' };
  const configs = Object.entries(settings).map(([task, text]) => configuration(task, [], {}, (selected) => {
    assert.equal(selected, new URL(`../config/${task}.yml`, import.meta.url).pathname);
    return text;
  }));
  assert.equal(configs[0].batchSize, 5);
  assert.equal(configs[1].batchSize, 10);
  assert.equal(configs[0].stateDir, configs[1].stateDir);
  assert.throws(() => configuration('unknown', [], {}), /Unknown population task/);
});

test('Bun only loads explicitly selected environment files, even with NODE_ENV=production', () => {
  const cfg = fixture();
  writeFileSync(join(cfg.stateDir, 'bunfig.toml'), readFileSync(new URL('../bunfig.toml', import.meta.url)));
  writeFileSync(join(cfg.stateDir, '.env'), 'SAPO_BUN_ENV_TEST=explicit\n');
  writeFileSync(join(cfg.stateDir, '.env.production'), 'SAPO_BUN_ENV_TEST=production\n');
  writeFileSync(join(cfg.stateDir, '.env.local'), 'SAPO_BUN_ENV_TEST=local\n');
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.SAPO_BUN_ENV_TEST;
  const code = 'console.log(process.env.SAPO_BUN_ENV_TEST ?? "unset")';
  const run = (args) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, ...args, '-e', code], cwd: cfg.stateDir, env });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  assert.equal(run([]), 'unset');
  assert.equal(run(['--env-file=.env']), 'explicit');
});

test('the existing Convex client resolves under Bun and uses the guarded development URL', async () => {
  const cfg = fixture({ identity: { ...identity, key: 'dev:test-dev|fake' } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, `${identity.url}/api/query`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Convex dev:test-dev|fake');
    const body = JSON.parse(options.body);
    assert.equal(body.path, 'phoneticPopulation:languages');
    assert.equal(body.args[0].expectedUrl, identity.url);
    return new Response(JSON.stringify({ status: 'success', value: languages, logLines: [] }));
  };
  try {
    assert.deepEqual(await connect(cfg).languages(), languages);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exact integer costs include cache writes and do not double count reasoning', () => {
  const cost = usageCost(answer([]), { input: 2000, cached: 100, write: 2500, output: 10000 }, 'responses', true);
  assert.equal(cost.cost, 7150000); // 900 uncached + 1000 cached + 100 writes + 500 output
  assert.equal(cost.reasoning, 400);
  assert.throws(() => usageCost({ usage: { input_tokens: 1, output_tokens: 1 } }, {}, 'responses', true));
  assert.throws(() => usageCost(answer([], { service_tier: 'ultrafast' }), {}, 'responses'));
  assert.throws(() => usageCost(answer([], { usage: { input_tokens: 1, output_tokens: 0,
    input_tokens_details: { cached_tokens: 2 } } }), {}, 'responses'));
  const chat = usageCost({ usage: { prompt_tokens: 100, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 30 } } },
  { input: 2000, cached: 100, write: 2500, output: 10000 }, 'chat');
  assert.equal(chat.cost, 662000);
});

test('structured output rejects invented IDs, duplicates, counts and invalid scripts', () => {
  const jobs = [{ key: '1' }, { key: '2' }];
  assert.throws(() => validateRecords({ records: [row('1'), row('1')] }, jobs, 'ipa'));
  assert.throws(() => validateRecords({ records: [row('1'), row('3')] }, jobs, 'ipa'));
  assert.throws(() => validateRecords({ records: [row('1')] }, jobs, 'ipa'));
  assert.throws(() => validateRecords({ records: [{ ...row('1'), extra: 1 }] }, [jobs[0]], 'ipa'));
  assert.throws(() => validateRecords({ records: [{ key: '1', status: 'review', value: '/a/', note: 'uncertain' }] }, [jobs[0]], 'ipa'));
  assert.ok(validIpa('/həˈloʊ/'));
  assert.ok(validIpa('/ni˧˥/'));
  assert.equal(validIpa('/你好/'), false);
  assert.equal(validIpa('/a1/'), false);
  assert.ok(validRespelling('jelóu', target));
  assert.equal(validRespelling('həˈloʊ', target), false);
  assert.equal(validRespelling('こんにちは', target), false);
  assert.ok(validRespelling('ハロー', { code: 'ja', script: 'Japanese' }));
  assert.ok(validRespelling('你好', { code: 'zh', script: 'Han' }));
  assert.equal(validRespelling('ni hao', { code: 'zh', script: 'Han' }), false);
});

test('random pair has a populated source and distinct target; duplicate codes fail', () => {
  const pair = choosePair([{ ...languages[0], hasEntries: false }, languages[1]], () => 0);
  assert.equal(pair.source.language_code, 'es');
  assert.equal(pair.target.language_code, 'en');
  assert.throws(() => choosePair([languages[0]], () => 0));
  assert.throws(() => choosePair([languages[0], languages[0]], () => 0));
});

test('a refused/incomplete response cannot become a database result', () => {
  assert.throws(() => outputText(answer([], { status: 'incomplete' }), 'responses'));
  assert.throws(() => outputText(answer([], { output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), 'responses'));
  assert.throws(() => outputText({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 'chat'));
  assert.equal(retryDelay('2', 0, 0), 2250);
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:10 GMT', 0, 0), 10250);
});

test('no request can be sent when its maximum reservation exceeds budget', async () => {
  const cfg = fixture({ budget: 1 });
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), /Budget exhausted/);
  assert.equal(count.calls, 0);
  assert.equal(ai.totals().committed, 0);
});

test('successful output is cached per item and billed once across restart and batch-size changes', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const jobs = [{ key: '1', word: 'hello' }, { key: '2', word: 'hello' }];
  let ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await ai.generate('ipa', jobs, source);
  assert.equal(count.calls, 1);
  assert.equal(ai.totals().known, 7150000);
  assert.equal(ai.totals().uncertain, 0);
  ai = createAI({ ...cfg, batchSize: 1 }, { fetchFn: fakeFetch(count), log: () => {} });
  await ai.generate('ipa', jobs, source);
  assert.equal(count.calls, 1);
  const saved = readJson(join(cfg.stateDir, 'results', readdirSync(join(cfg.stateDir, 'results'))[0]));
  assert.ok(saved.job.word);
  assert.equal(saved.source.code, 'en');
  assertNoCredentials(cfg);
});

test('saved request artifact recovers a crash before settlement without a second AI request', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  const [reserved] = journal(join(cfg.stateDir, 'usage.jsonl'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(cfg.stateDir, 'usage.jsonl'), `${JSON.stringify(reserved)}\n`);
  unlinkSync(join(cfg.stateDir, 'responses', `${reserved.digest}.json`));
  for (const file of readdirSync(join(cfg.stateDir, 'results'))) unlinkSync(join(cfg.stateDir, 'results', file));
  const resumed = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await resumed.generate('ipa', [{ key: '1', word: 'hello' }], source);
  assert.equal(count.calls, 1);
  assert.equal(resumed.totals().known, ai.totals().known);
  assert.equal(resumed.totals().uncertain, 0);
});

test('unknown billing survives restart and prevents a retry from exceeding budget', async () => {
  const cfg = fixture();
  const body = requestBody(cfg, readFileSync(new URL('../prompts/ipa.md', import.meta.url), 'utf8'),
    { source, words: [{ key: '1', word: 'hello' }] });
  cfg.budget = reservation(body, cfg).cost;
  let calls = 0;
  const ai = createAI(cfg, { fetchFn: async () => { calls++; throw new TypeError('network'); }, wait: async () => {}, log: () => {} });
  await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), /Budget exhausted/);
  assert.equal(calls, 1);
  assert.equal(ai.totals().uncertain, cfg.budget);
  assert.equal(createAI(cfg, { log: () => {} }).totals().uncertain, cfg.budget);
});

test('429 retries honor Retry-After, record uncertain cost, and settle the next attempt', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const success = fakeFetch(count);
  let rejected = false;
  const delays = [];
  const ai = createAI(cfg, { fetchFn: async (...args) => {
    if (!rejected) { rejected = true; return new Response('{}', { status: 429, headers: { 'retry-after': '2' } }); }
    return success(...args);
  }, wait: async (ms) => delays.push(ms), log: () => {} });
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  assert.ok(delays.includes(2250));
  assert.equal(ai.totals().requests.size, 2);
  assert.ok(ai.totals().uncertain > 0);
  assert.equal(ai.totals().known, 7150000);
});

test('persistent rolling RPM rate limiting survives process restart', async () => {
  const cfg = fixture({ rpm: 1 });
  const count = { calls: 0 };
  let clock = 100000;
  const waits = [];
  const options = { fetchFn: fakeFetch(count), now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; }, log: () => {} };
  await createAI(cfg, options).generate('ipa', [{ key: '1', word: 'hello' }], source);
  await createAI(cfg, options).generate('ipa', [{ key: '2', word: 'hello' }], source);
  assert.equal(waits[0], 60001);
  assert.equal(count.calls, 2);
});

test('alternate OpenAI chat models use the provider-native gateway and settle usage', async () => {
  const cfg = fixture({ model: 'test-model', builtIn: false,
    api: 'chat', effort: 'omit', prices: { input: 1000, cached: 1000, write: 1000, output: 2000 } });
  let calls = 0;
  const ai = createAI(cfg, { fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, `https://gateway.ai.cloudflare.com/v1/${cfg.account}/${cfg.gateway}/openai/chat/completions`);
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.headers['cf-aig-authorization'], `Bearer ${cfg.token}`);
    assert.equal(options.headers['cf-aig-no-wholesale'], 'true');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.response_format.json_schema.strict, true);
    const input = JSON.parse(body.messages[1].content);
    return new Response(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records: input.words.map((j) => row(j.key)) }) } }] }));
  }, log: () => {} });
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  assert.equal(calls, 1);
  assert.equal(ai.totals().known, 200000);
  assertNoCredentials(cfg);
});

test('stored-key failures and redirects never fall back or persist echoed credentials', async () => {
  for (const status of [400, 401, 403, 302]) {
    const cfg = fixture();
    let calls = 0;
    const logs = [];
    const ai = createAI(cfg, { log: (text) => logs.push(text), fetchFn: async (url, options) => {
      calls++;
      assert.equal(url, `https://gateway.ai.cloudflare.com/v1/${cfg.account}/${cfg.gateway}/openai/responses`);
      assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).has('authorization'), false);
      assert.equal(options.headers['cf-aig-no-wholesale'], 'true');
      return new Response(JSON.stringify({
        error: { message: `Invalid credentials: fake-openai-key ${cfg.token}` },
        ...(status === 401 ? { usage: answer([]).usage, service_tier: 'default' } : {}),
      }), { status, headers: { Location: 'https://api.openai.com/v1/responses' } });
    } });
    await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.equal(ai.totals().known, status === 401 ? 7150000 : 0);
    assertNoCredentials(cfg);
    assert.equal(logs.join().includes('fake-openai-key'), false);
    assert.equal(logs.join().includes(cfg.token), false);
  }
});

test('the same ledger cap applies to IPA and respelling tasks', async () => {
  const cfg = fixture();
  const body = requestBody(cfg, readFileSync(new URL('../prompts/respell.md', import.meta.url), 'utf8'),
    { source, target, words: [{ key: '2', word: 'hello', ipa: '/həˈloʊ/' }] });
  cfg.budget = reservation(body, cfg).cost;
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  await assert.rejects(ai.generate('respell', [{ key: '2', word: 'hello', ipa: '/həˈloʊ/' }], source, target), /Budget exhausted/);
  assert.equal(count.calls, 1);
});

test('missing usage and malformed model output stop before result caching', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count, (rows) => answer(rows, { usage: undefined })), log: () => {} });
  await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), /Missing usage/);
  assert.ok(ai.totals().uncertain > 0);
  const other = fixture();
  const wrong = createAI(other, { fetchFn: fakeFetch(count, () => answer([row('invented')])), log: () => {} });
  await assert.rejects(wrong.generate('ipa', [{ key: '1', word: 'hello' }], source), /key/);
  assert.equal(wrong.totals().known, 7150000);
  await assert.rejects(wrong.generate('ipa', [{ key: '1', word: 'hello' }], source), /key/);
  assert.equal(count.calls, 2, 'Malformed responses are not automatically regenerated');
});

test('read-only planning makes no generation or mutation calls', async () => {
  const cfg = fixture({ generate: false, write: false, maxPages: 1 });
  const db = fakeDatabase([entry('1')]);
  await populate('transcriptions', cfg, db, null, { log: () => {} });
  assert.equal(db.calls.ipa, 0);
  assert.equal(db.calls.respell, 0);
  assert.equal(db.calls.pages, 1);
});

test('IPA population covers all languages, preserves existing variants and caches reviewed words', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1'), entry('2', 'en', [{ _id: 'old', transcription: '/old/', targets: [] }]), entry('3', 'es')]);
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await populate('transcriptions', cfg, db, ai, { log: () => {} });
  assert.equal(db.entries[1].transcriptions[0].transcription, '/old/');
  assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
  assert.equal(count.calls, 2);
  await populate('transcriptions', { ...cfg, rescan: true }, db, ai, { log: () => {} });
  assert.equal(count.calls, 2);
  assert.equal(db.entries[1].transcriptions.length, 1);
});

test('generation-only respellings include missing IPA; applying reuses results with real links', async () => {
  const cfg = fixture({ write: false });
  const db = fakeDatabase([entry('1'), entry('2', 'en', [
    { _id: 'old-1', transcription: '/a/', targets: ['es'] },
    { _id: 'old-2', transcription: '/b/', targets: [] },
  ])]);
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  const options = { select: () => 0, log: () => {} };
  await populate('respellings', cfg, db, ai, options);
  assert.equal(db.calls.ipa, 0);
  assert.equal(db.calls.respell, 0);
  assert.equal(count.calls, 2);
  const pair = readJson(join(cfg.stateDir, 'respelling-pair.json'));
  await populate('respellings', { ...cfg, write: true }, db, ai, { ...options, select: () => { throw new Error('Must not reselect'); } });
  assert.equal(count.calls, 2, 'Temporary and real IPA IDs share stable item cache keys');
  assert.ok(db.entries.flatMap((e) => e.transcriptions).every((ipa) => ipa.targets.includes('es')));
  assert.deepEqual(readJson(join(cfg.stateDir, 'respelling-pair.json')), pair);
  await populate('respellings', { ...cfg, write: true, rescan: true }, db, ai, options);
  assert.equal(count.calls, 2);
});

test('pagination resumes at the committed boundary after a limited write run', async () => {
  const cfg = fixture({ write: true, maxPages: 1 });
  const db = fakeDatabase([entry('1'), entry('2')], 1);
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await populate('transcriptions', cfg, db, ai, { log: () => {} });
  assert.equal(db.entries[0].transcriptions.length, 1);
  assert.equal(db.entries[1].transcriptions.length, 0);
  const saved = readJson(join(cfg.stateDir, 'transcriptions.write.json'));
  assert.equal(saved.cursor, '1');
  await populate('transcriptions', cfg, db, ai, { log: () => {} });
  assert.equal(db.entries[1].transcriptions.length, 1);
  assert.equal(count.calls, 2);
});

test('a mutation that commits before a network failure is safe to resume without paid regeneration', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1')]);
  const insert = db.insertRespellings;
  let failed = false;
  db.insertRespellings = async (rows) => {
    await insert(rows);
    if (!failed) { failed = true; throw new Error('network after commit'); }
  };
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  const options = { select: () => 0, log: () => {} };
  await assert.rejects(populate('respellings', cfg, db, ai, options), /network/);
  await populate('respellings', cfg, db, ai, options);
  assert.equal(count.calls, 2);
  assert.equal(db.entries[0].transcriptions.length, 1);
  assert.deepEqual(db.entries[0].transcriptions[0].targets, ['es']);
});

test('ambiguous review items remain local and never become rows', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1')]);
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count, (rows) => answer(rows.map((r) =>
    ({ key: r.key, status: 'review', value: null, note: 'Ambiguous without context' })))), log: () => {} });
  await populate('transcriptions', cfg, db, ai, { log: () => {} });
  assert.equal(db.calls.ipa, 0);
  await populate('transcriptions', { ...cfg, rescan: true }, db, ai, { log: () => {} });
  assert.equal(count.calls, 1);
});

test('exclusive locks, deployment isolation and corrupt journals fail closed', async () => {
  const cfg = fixture();
  const unlock = lockState(cfg.stateDir);
  assert.throws(() => lockState(cfg.stateDir), /locked/);
  unlock();
  atomicJson(join(cfg.stateDir, 'deployment.json'), { url: 'https://other.convex.cloud' });
  await assert.rejects(populate('transcriptions', cfg, fakeDatabase([]), null, { log: () => {} }), /another deployment/);
  assert.throws(() => ledgerTotals([{ type: 'settle', id: 'absent', usage: { cost: 0 } }]));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(cfg.stateDir, 'usage.jsonl'), '{"type":"reserve"');
  assert.throws(() => createAI(cfg), /incomplete/);
});
