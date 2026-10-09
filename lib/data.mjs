import { digest } from './files.mjs';

const DIALECTS = {
  en: 'General American English', es: 'neutral Latin American Spanish',
  fr: 'standard metropolitan French', de: 'Standard German', ru: 'Standard Russian',
  ar: 'Modern Standard Arabic', ja: 'standard Tokyo Japanese, segmental pronunciation',
  zh: 'Beijing-based Standard Mandarin, Simplified Chinese', pt: 'Brazilian Portuguese',
};
const SCRIPTS = { Latn: 'Latin', Cyrl: 'Cyrillic', Arab: 'Arabic', Jpan: 'Japanese',
  Hans: 'Han', Hant: 'Han', Kore: 'Hangul', Grek: 'Greek', Hebr: 'Hebrew',
  Deva: 'Devanagari', Thai: 'Thai', Beng: 'Bengali', Armn: 'Armenian', Geor: 'Georgian' };

export function languagePolicy(language, overrides = {}) {
  let script;
  try { script = SCRIPTS[new Intl.Locale(language.language_code).maximize().script]; }
  catch { /* A user-supplied policy can support a non-BCP47 database code. */ }
  const override = overrides[language.language_code] ?? {};
  if (!override || typeof override !== 'object' || Array.isArray(override) || Object.entries(override).some(([key, value]) =>
    !['dialect', 'script'].includes(key) || typeof value !== 'string' || !value.trim() || value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value))) {
    throw new Error(`Invalid language policy for ${language.language_code}; only dialect/script strings are allowed`);
  }
  const policy = { code: language.language_code, name: language.name,
    dialect: DIALECTS[language.language_code] ?? `most widely understood standard variety of ${language.name}`,
    script, ...override };
  if (policy.script && policy.script !== 'Japanese') new RegExp(`\\p{Script_Extensions=${policy.script}}`, 'u');
  return policy;
}

export function choosePair(languages, randomInt) {
  if (new Set(languages.map((l) => l.language_code)).size !== languages.length) {
    throw new Error('Duplicate language codes; fix the database before selecting a pair');
  }
  const sources = languages.filter((l) => l.hasEntries && languages.some((t) => t.language_code !== l.language_code));
  if (!sources.length) throw new Error('Need at least two distinct languages and a source containing entries');
  const source = sources[randomInt(sources.length)];
  const targets = languages.filter((l) => l.language_code !== source.language_code);
  return { source, target: targets[randomInt(targets.length)] };
}

export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: { records: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['key', 'status', 'value', 'note'],
    properties: { key: { type: 'string' }, status: { type: 'string', enum: ['ready', 'review'] },
      value: { type: ['string', 'null'] }, note: { type: 'string' } },
  } } },
};

export function validIpa(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^\/[^/\r\n]+\/$/u.test(value)) return false;
  const body = value.slice(1, -1);
  return /[\p{L}]/u.test(body) && /^[\p{Script=Latin}\p{Script=Greek}\p{M} .ˈˌːˑ˥˦˧˨˩ꜛꜜʰʲʷˠˤⁿˡʱʼʔʕ͜͡]+$/u.test(body);
}

export function validRespelling(value, policy) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 ||
      /[\p{Cc}\p{Cf}\u0250-\u02af/\[\]<>]/u.test(value)) return false;
  if (!policy.script) throw new Error(`No script policy for target ${policy.code}; configure languagePolicies in YAML`);
  const scripts = policy.script === 'Japanese' ? ['Hiragana', 'Katakana', 'Han'] : [policy.script];
  const letters = new RegExp(`^[${scripts.map((s) => `\\p{Script_Extensions=${s}}`).join('')}\\p{M} '\u2019\u2010\u2011\u30fc-]+$`, 'u');
  return /\p{L}/u.test(value) && letters.test(value);
}

export function validateRecords(output, jobs, task, target) {
  if (!output || Object.keys(output).join() !== 'records' || !Array.isArray(output.records)) throw new Error('Invalid structured output');
  const expected = new Set(jobs.map((j) => j.key));
  const keys = new Set(expected);
  if (keys.size !== jobs.length || output.records.length !== jobs.length) throw new Error('Incorrect record count');
  for (const [index, row] of output.records.entries()) {
    if (!row || Array.isArray(row) || Object.keys(row).sort().join() !== 'key,note,status,value' || typeof row.key !== 'string') {
      throw new Error(`Malformed record at index ${index}: expected key, note, status, value`);
    }
    if (!expected.has(row.key)) throw new Error(`Unknown key at index ${index}: ${JSON.stringify(row.key)}`);
    if (!keys.delete(row.key)) throw new Error(`Duplicate key at index ${index}: ${JSON.stringify(row.key)}`);
    if (typeof row.note !== 'string' || row.note.length > 500) throw new Error('Invalid review note');
    if (row.status === 'review') {
      if (row.value !== null || !row.note.trim()) throw new Error('Review records require null and a note');
    } else if (row.status !== 'ready' || row.note !== '' ||
        !(task === 'ipa' ? validIpa(row.value) : validRespelling(row.value, target))) {
      throw new Error(`Invalid ${task} value for ${row.key}`);
    }
  }
  return output.records;
}

export const pronunciationKey = (entryId, ipa) => digest([entryId, ipa]);
