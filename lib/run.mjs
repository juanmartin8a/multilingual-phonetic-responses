import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { configuration, developmentIdentity, HELP } from './config.mjs';
import { atomicJson, readJson, lockState } from './files.mjs';
import { choosePair, languagePolicy, pronunciationKey } from './data.mjs';
import { connect } from './db.mjs';
import { createAI } from './ai.mjs';

export async function processPage(cfg, db, ai, pageArgs, source, target, log = console.log) {
  let result = await db.page(pageArgs);
  const missing = result.page.filter((entry) => entry.transcriptions.length === 0);
  const pendingRespellings = result.page.reduce((sum, entry) => sum +
    entry.transcriptions.filter((t) => !t.hasRespelling).length, 0);
  log(`${source.code}: ${result.page.length} words, ${missing.length} missing IPA` +
    (target ? `, ${pendingRespellings} missing ${target.code} respellings (+ words needing IPA)` : ''));
  if (!cfg.generate) return result;
  const ipa = await ai.generate('ipa', missing.map((entry) => ({ key: entry._id, word: entry.orthographic_form })), source);
  const ready = missing.filter((entry) => ipa.get(entry._id)?.status === 'ready');
  if (cfg.write) {
    for (let offset = 0; offset < ready.length; offset += 50) {
      await db.insertTranscriptions(ready.slice(offset, offset + 50).map((entry) => ({
        entry_id: entry._id, orthographic_form: entry.orthographic_form,
        language_id: entry.language_id, language_code: source.code, transcription: ipa.get(entry._id).value,
      })));
    }
  }
  if (!target) return result;
  if (cfg.write) {
    // Resolve real IDs after insertion, honoring concurrent inserts and removals.
    // Keep the original pagination boundary for the checkpoint.
    const refreshed = await db.page(pageArgs);
    if (refreshed.continueCursor !== result.continueCursor || refreshed.isDone !== result.isDone) {
      throw new Error('Entries changed during this page; rerun to refresh before generating respellings');
    }
    result = refreshed;
  } else {
    // Generation-only can still produce respellings before IPA has a database ID.
    result = { ...result, page: result.page.map((entry) => ({ ...entry,
      transcriptions: entry.transcriptions.length ? entry.transcriptions :
        ipa.get(entry._id)?.status === 'ready' ? [{ transcription: ipa.get(entry._id).value, hasRespelling: false }] : [],
    })) };
  }
  const candidates = result.page.flatMap((entry) => entry.transcriptions.filter((t) => !t.hasRespelling)
    .map((transcription) => ({ entry, transcription,
      key: pronunciationKey(entry._id, transcription.transcription) })));
  // Duplicate IPA documents can share generated text, but each gets its own link.
  const jobs = [...new Map(candidates.map(({ key, entry, transcription }) => [key, {
    key, word: entry.orthographic_form, ipa: transcription.transcription,
  }])).values()];
  const respellings = await ai.generate('respell', jobs, source, target);
  if (cfg.write) {
    const rows = candidates.filter((candidate) => respellings.get(candidate.key)?.status === 'ready');
    for (let offset = 0; offset < rows.length; offset += 50) {
      await db.insertRespellings(rows.slice(offset, offset + 50).map(({ key, entry, transcription }) => ({
        phonetic_transcription_id: transcription._id, transcription: transcription.transcription,
        orthographic_form: entry.orthographic_form, source_language_code: source.code,
        target_language_id: cfg.targetId, target_language_code: target.code,
        respelling: respellings.get(key).value,
      })));
    }
  }
  return result;
}

export async function populate(task, cfg, db, ai, { log = console.log, select = randomInt } = {}) {
  const scopePath = resolve(cfg.stateDir, 'deployment.json');
  const scope = readJson(scopePath);
  if (scope && scope.url !== cfg.identity.url) throw new Error('State directory belongs to another deployment');
  if (!scope) atomicJson(scopePath, { url: cfg.identity.url });
  const languages = (await db.languages()).sort((a, b) => a.language_code.localeCompare(b.language_code));
  if (new Set(languages.map((l) => l.language_code)).size !== languages.length) throw new Error('Duplicate language codes');
  const overrides = cfg.languagePolicies ?? {};
  let target = null, selected;
  if (task === 'respellings') {
    const pairPath = resolve(cfg.stateDir, 'respelling-pair.json');
    selected = readJson(pairPath);
    if (!selected) { selected = choosePair(languages, select); atomicJson(pairPath, selected); }
    const source = languages.find((l) => l._id === selected.source._id && l.language_code === selected.source.language_code);
    const targetLanguage = languages.find((l) => l._id === selected.target._id && l.language_code === selected.target.language_code);
    if (!source || !targetLanguage || source.language_code === targetLanguage.language_code) throw new Error('Saved language pair no longer exists');
    selected = { source, target: targetLanguage };
    cfg.targetId = targetLanguage._id;
    target = languagePolicy(targetLanguage, overrides);
    if (!target.script) throw new Error(`Configure a native script policy for randomly selected target ${target.code}`);
    log(`Saved language pair: ${source.language_code} -> ${targetLanguage.language_code}`);
  }
  const ordered = selected ? [selected.source] : languages.filter((l) => l.hasEntries);
  const stage = cfg.write ? 'write' : 'generate';
  const checkpointPath = resolve(cfg.stateDir, `${task}.${stage}.json`);
  const checkpoint = cfg.rescan ? { completed: [], language: null, cursor: null } :
    readJson(checkpointPath, { completed: [], language: null, cursor: null });
  let pages = 0;
  for (const language of ordered) {
    if (cfg.generate && checkpoint.completed.includes(language.language_code)) continue;
    let cursor = cfg.generate && checkpoint.language === language.language_code ? checkpoint.cursor : null;
    while (true) {
      const args = { languageCode: language.language_code, cursor, numItems: 50,
        ...(target ? { targetLanguageCode: target.code } : {}) };
      const result = await processPage(cfg, db, ai, args, languagePolicy(language, overrides), target, log);
      if (!result.isDone && result.continueCursor === cursor) throw new Error('Pagination did not advance');
      cursor = result.continueCursor;
      pages++;
      if (cfg.generate) {
        checkpoint.language = result.isDone ? null : language.language_code;
        checkpoint.cursor = result.isDone ? null : cursor;
        if (result.isDone) checkpoint.completed.push(language.language_code);
        atomicJson(checkpointPath, checkpoint);
      }
      if (cfg.maxPages && pages >= cfg.maxPages) { log(`Stopped after ${pages} page(s); resume with the same command.`); return; }
      if (result.isDone) break;
    }
  }
  log(cfg.generate ? 'Scan complete. Review records are saved locally; use --rescan to revisit the database.' : 'Read-only plan complete.');
}

export async function main(task) {
  let unlock, ai;
  try {
    const cfg = configuration();
    if (cfg.help) { console.log(HELP); return; }
    cfg.identity = developmentIdentity(cfg.project, cfg.devKey);
    unlock = lockState(cfg.stateDir);
    const scope = readJson(resolve(cfg.stateDir, 'deployment.json'));
    if (scope && scope.url !== cfg.identity.url) throw new Error('State directory belongs to another deployment');
    const db = connect(cfg);
    ai = cfg.generate ? createAI(cfg) : null;
    await populate(task, cfg, db, ai);
  } catch (error) {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (ai) {
      const total = ai.totals();
      console.log(JSON.stringify({ knownCostUSD: total.known / 1e9, uncertainUpperBoundUSD: total.uncertain / 1e9,
        budgetCommittedUSD: total.committed / 1e9, usage: total.usage }));
    }
    unlock?.();
  }
}
