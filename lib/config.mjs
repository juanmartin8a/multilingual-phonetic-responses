import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export const help = (task) => `Usage: bun [--env-file=.env.local] populate-${task}.mjs [options]
  (no flags)           Read-only plan, first page only; no AI requests or writes
  --generate          Allow paid AI generation; save results locally
  --write             Also insert missing records (requires --generate)
  --budget USD        Cumulative maximum across BOTH scripts and all resumes
  --config PATH       YAML settings; default <script-dir>/config/${task}.yml
  --model NAME        Default: gpt-6.1-sol
  --provider NAME     Only openai (provider-native AI Gateway)
  --batch-size N      Words per AI call, 1-50; default 20
  --max-pages N       Stop after N database pages; 0 = all
  --state-dir PATH    Shared ledger/cache/checkpoints; default <script-dir>/.state
  --rescan            Scan again from the start; keep pair, results, and spending
  --project PATH      SAPO checkout; default ~/development/react-native/sapo
  --help              This help
See README.md and config/${task}.yml. Environment variables supply credentials only.
No deployment, production, or arbitrary URL flags.`;

export function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

// Integer nano-USD avoids accumulation and budget-comparison rounding errors.
export function usd(value) {
  if (!/^\d+(\.\d{1,9})?$/.test(String(value))) throw new Error('Invalid USD amount');
  const [whole, fraction = ''] = String(value).split('.');
  return integer(Number(whole) * 1e9 + Number(fraction.padEnd(9, '0')), 'USD', 0, 1e15);
}

function rate(value, name) {
  if (!/^\d+(\.\d{1,3})?$/.test(String(value))) throw new Error(`${name}: use up to 3 decimal places`);
  const [whole, fraction = ''] = String(value).split('.');
  return integer(Number(whole) * 1000 + Number(fraction.padEnd(3, '0')), name, 0, 1e9);
}

export function developmentIdentity(project, key, read = readFileSync) {
  // Never trust CONVEX_URL or CONVEX_DEPLOYMENT inherited from a production shell.
  const local = parseEnv(read(resolve(project, '.env.local'), 'utf8'));
  const match = /^dev:([a-z0-9-]+)(?:\s|$)/.exec(local.CONVEX_DEPLOYMENT ?? '');
  if (!match) throw new Error('SAPO .env.local must name a hosted dev: deployment');
  const name = match[1];
  const url = `https://${name}.convex.cloud`;
  if (local.EXPO_PUBLIC_CONVEX_URL !== url) throw new Error('Development URL/name mismatch');
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('CONVEX_KEY is missing; load credentials with bun --env-file=.env.local or use bun run transcriptions/respellings');
  }
  if (typeof key !== 'string' || !key.startsWith(`dev:${name}|`) || key.length <= `dev:${name}|`.length) {
    throw new Error('CONVEX_KEY must be a dev deploy key for SAPO .env.local');
  }
  let production;
  try { production = parseEnv(read(resolve(project, '.env.production.local'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (production && Object.values(production).some((value) => value === url || value === `dev:${name}`)) {
    throw new Error('Development target also appears in production configuration');
  }
  return { name, url, key };
}

const CONFIG_SCHEMA = {
  project: 'string', stateDir: 'string', batchSize: 'number', maxPages: 'number',
  ai: {
    provider: 'string', model: 'string', api: 'string', reasoningEffort: 'string', maxOutputTokens: 'number',
    pricesUsdPerMillion: { input: 'string', cachedInput: 'string', cacheWrite: 'string', output: 'string' },
  },
  limits: {
    maxUsd: 'string', requestsPerMinute: 'number', tokensPerMinute: 'number', maxAttempts: 'number', timeoutMs: 'number',
  },
  cloudflare: { accountId: 'string', gatewayId: 'string' },
  languagePolicies: 'policies',
};

function validateSettings(value, schema, path = 'config') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a mapping`);
  for (const [key, item] of Object.entries(value)) {
    const field = `${path}.${key}`;
    if (!Object.hasOwn(schema, key)) throw new Error(`Unknown setting: ${field}`);
    const type = schema[key];
    if (typeof type === 'object') validateSettings(item, type, field);
    else if (type === 'policies') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field} must be a mapping`);
      for (const [code, policy] of Object.entries(item)) {
        validateSettings(policy, { dialect: 'string', script: 'string' }, `${field}.${code}`);
        for (const text of Object.values(policy)) {
          if (text.length > 200 || /[\p{Cc}\p{Cf}]/u.test(text)) throw new Error(`Invalid policy: ${field}.${code}`);
        }
        if (policy.script && policy.script !== 'Japanese') new RegExp(`\\p{Script_Extensions=${policy.script}}`, 'u');
      }
    } else if (typeof item !== type || (type === 'string' && !item.trim()) ||
        (type === 'number' && !Number.isSafeInteger(item))) {
      throw new Error(`${field} must be ${type === 'number' ? 'an integer' : 'a nonempty string (quote monetary values)'}`);
    }
  }
}

function configPath(value, base) {
  return resolve(base, value === '~' ? homedir() : value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value);
}

export function configuration(task, argv = process.argv.slice(2), env = process.env, read = readFileSync) {
  if (!['transcriptions', 'respellings'].includes(task)) throw new Error('Unknown population task');
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, generate: { type: 'boolean' }, write: { type: 'boolean' }, rescan: { type: 'boolean' },
    budget: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' },
    'batch-size': { type: 'string' }, 'max-pages': { type: 'string' },
    'state-dir': { type: 'string' }, project: { type: 'string' }, config: { type: 'string' },
  } });
  if (values.help) return { help: true };
  if (values.write && !values.generate) throw new Error('--write requires --generate');
  const path = values.config ? resolve(values.config) : fileURLToPath(new URL(`../config/${task}.yml`, import.meta.url));
  const text = read(path, 'utf8');
  let settings;
  try { settings = Bun.YAML.parse(text); }
  catch { throw new Error(`Invalid YAML in ${path}`); }
  validateSettings(settings, CONFIG_SCHEMA);
  const ai = settings.ai ?? {}, limits = settings.limits ?? {}, cloudflare = settings.cloudflare ?? {};
  const model = values.model ?? ai.model ?? 'gpt-6.1-sol';
  const provider = values.provider ?? ai.provider ?? 'openai';
  if (!/^[a-z0-9-]+$/.test(provider) || !/^[a-zA-Z0-9._:-]+$/.test(model)) {
    throw new Error('Invalid provider/model; use a native OpenAI model name without a provider prefix');
  }
  if (provider !== 'openai') throw new Error('This gateway integration supports only openai with a stored provider key');
  const api = ai.api ?? 'responses';
  if (!['responses', 'chat'].includes(api)) throw new Error('ai.api must be responses or chat');
  const effort = ai.reasoningEffort ?? 'high';
  if (!['omit', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Invalid reasoning effort');
  const builtIn = provider === 'openai' && model === 'gpt-6.1-sol';
  if (builtIn && ['none', 'omit'].includes(effort)) throw new Error('GPT-6.1 Sol requires low, medium, high, xhigh, or max effort');
  const names = ['input', 'cachedInput', 'cacheWrite', 'output'];
  const configuredPrices = ai.pricesUsdPerMillion ?? {};
  if (Object.keys(configuredPrices).length &&
      (model !== (ai.model ?? 'gpt-6.1-sol') || provider !== (ai.provider ?? 'openai'))) {
    throw new Error('Model/provider override does not match YAML token prices; select a matching --config');
  }
  if (!builtIn && names.some((name) => configuredPrices[name] === undefined)) {
    throw new Error('Changing models/providers requires all four explicit token prices');
  }
  const prices = Object.fromEntries(['input', 'cached', 'write', 'output'].map((name, i) =>
    [name, rate(configuredPrices[names[i]] ?? ['2', '0.1', '2.5', '10'][i], `ai.pricesUsdPerMillion.${names[i]}`)]));
  const account = cloudflare.accountId;
  const gateway = cloudflare.gatewayId;
  if (account !== undefined && !/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid cloudflare.accountId');
  if (gateway !== undefined && !/^[a-zA-Z0-9_-]+$/.test(gateway)) throw new Error('Invalid cloudflare.gatewayId');
  if (values.generate && (!account || !gateway || !env.CLOUDFLARE_API_TOKEN)) {
    throw new Error('Generation requires Cloudflare account ID, gateway ID, and API token');
  }
  const budget = usd(values.budget ?? limits.maxUsd ?? '0');
  if (values.generate && !budget) throw new Error('Generation requires a positive --budget or limits.maxUsd');
  return {
    project: values.project ? resolve(values.project) : configPath(settings.project ?? '~/development/react-native/sapo', dirname(path)),
    stateDir: values['state-dir'] ? resolve(values['state-dir']) : settings.stateDir ? configPath(settings.stateDir, dirname(path)) :
      fileURLToPath(new URL('../.state', import.meta.url)),
    generate: values.generate ?? false, write: values.write ?? false,
    rescan: values.rescan ?? false,
    budget, model, provider, api, effort, prices, account, gateway,
    token: env.CLOUDFLARE_API_TOKEN,
    devKey: env.CONVEX_KEY,
    batchSize: integer(values['batch-size'] ?? settings.batchSize ?? 20, 'batch size', 1, 50),
    maxPages: integer(values['max-pages'] ?? settings.maxPages ?? (values.generate ? 0 : 1), 'max pages', 0, 1e9),
    outputTokens: integer(ai.maxOutputTokens ?? 25000, 'output tokens', 256, 128000),
    rpm: integer(limits.requestsPerMinute ?? 10, 'RPM', 1, 1000),
    tpm: integer(limits.tokensPerMinute ?? 200000, 'TPM', 1000, 1e9),
    attempts: integer(limits.maxAttempts ?? 3, 'attempts', 1, 5),
    timeout: integer(limits.timeoutMs ?? 300000, 'timeout', 1000, 900000),
    languagePolicies: settings.languagePolicies ?? {},
    builtIn,
  };
}
