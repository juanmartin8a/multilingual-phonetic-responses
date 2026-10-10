import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { configuration, developmentIdentity, help } from './config.mjs';
import { atomicJson, readJson } from './files.mjs';
import { choosePair, languagePolicy, pronunciationKey } from './data.mjs';
import { connect } from './db.mjs';
import { BudgetReachedError, createAI } from './ai.mjs';

async function insertBatches(insert, rows) {
  for (let offset = 0; offset < rows.length; offset += 50) await insert(rows.slice(offset, offset + 50));
}

async function processPages(cfg, db, ai, pages, source, target, log) {
  let entries = pages.flatMap(({ result }) => result.page);
  const missing = entries.filter((entry) => entry.transcriptions.length === 0);
  const pending = entries.reduce((sum, entry) => sum + entry.transcriptions.filter((t) => !t.hasRespelling).length, 0);
  log(`${source.code}: ${entries.length} words, ${missing.length} missing IPA` +
    (target ? `, ${pending} missing ${target.code} respellings (+ words needing IPA)` : ''));
  const byId = new Map(missing.map((entry) => [entry._id, entry]));
  const ipa = await ai.generate('ipa', missing.map((entry) => ({ key: entry._id, word: entry.orthographic_form })),
    source, null, async (records) => {
      if (!cfg.write) return;
      await insertBatches(db.insertTranscriptions, records.map((record) => {
        const entry = byId.get(record.key);
        return { entry_id: entry._id, orthographic_form: entry.orthographic_form,
          language_id: entry.language_id, language_code: source.code, transcription: record.value };
      }));
    });
  if (!target) return;
  if (cfg.write && missing.length) {
    // Resolve real IPA IDs after insertion before linking respellings.
    const refreshed = [];
    for (const page of pages) {
      const result = await db.page(page.args);
      if (result.continueCursor !== page.result.continueCursor || result.isDone !== page.result.isDone) {
        throw new Error('Entries changed during this page; rerun before generating respellings');
      }
      refreshed.push(...result.page);
    }
    entries = refreshed;
  } else if (!cfg.write) {
    entries = entries.map((entry) => ({ ...entry,
      transcriptions: entry.transcriptions.length ? entry.transcriptions : ipa.has(entry._id) ?
        [{ transcription: ipa.get(entry._id).value, hasRespelling: false }] : [],
    }));
  }
  const candidates = entries.flatMap((entry) => entry.transcriptions.filter((t) => !t.hasRespelling)
    .map((transcription) => ({ entry, transcription, key: pronunciationKey(entry._id, transcription.transcription) })));
  // Duplicate IPA documents share generated text, but each gets its own link.
  const jobs = [...new Map(candidates.map(({ key, entry, transcription }) => [key,
    { key, word: entry.orthographic_form, ipa: transcription.transcription }])).values()];
  await ai.generate('respell', jobs, source, target, async (records) => {
    if (!cfg.write) return;
    const values = new Map(records.map((record) => [record.key, record.value]));
    await insertBatches(db.insertRespellings, candidates.filter(({ key }) => values.has(key))
      .map(({ key, entry, transcription }) => ({
        phonetic_transcription_id: transcription._id, transcription: transcription.transcription,
        orthographic_form: entry.orthographic_form, source_language_code: source.code,
        target_language_id: cfg.targetId, target_language_code: target.code, respelling: values.get(key),
      })));
  });
}

export async function populate(task, cfg, db, ai, { log = console.log, select = randomInt } = {}) {
  const languages = (await db.languages()).sort((a, b) => a.language_code.localeCompare(b.language_code));
  if (new Set(languages.map((l) => l.language_code)).size !== languages.length) throw new Error('Duplicate language codes');
  let target = null, selected;
  if (task === 'respellings') {
    const pairPath = resolve(cfg.stateDir, 'respelling-pair.json');
    const saved = readJson(pairPath);
    selected = saved ? { source: languages.find((l) => l.language_code === saved.source),
      target: languages.find((l) => l.language_code === saved.target) } : choosePair(languages, select);
    if (!selected.source || !selected.target || selected.source.language_code === selected.target.language_code) {
      throw new Error('Saved language pair no longer exists');
    }
    cfg.targetId = selected.target._id;
    target = languagePolicy(selected.target, cfg.languagePolicies);
    if (!target.script) throw new Error(`Configure a native script policy for target ${target.code}`);
    if (!cfg.write && !saved) atomicJson(pairPath,
      { source: selected.source.language_code, target: selected.target.language_code });
    log(`Language pair: ${selected.source.language_code} -> ${target.code}`);
  }
  const ordered = selected ? [selected.source] : languages.filter((l) => l.hasEntries);
  let pages = 0;
  function stopForBudget() {
    log(`Budget reached: $${(ai.totals().committed / 1e9).toFixed(6)} committed this run; $${(cfg.budget / 1e9).toFixed(6)} limit. Completed batches ${cfg.write ? 'inserted' : 'saved locally'}; rerun for a fresh budget.`);
  }
  for (const language of ordered) {
    let cursor = null;
    while (true) {
      const pending = [];
      const windowSize = Math.max(50, cfg.batchSize);
      let words = 0;
      do {
        const args = { languageCode: language.language_code, cursor, numItems: Math.min(50, windowSize - words),
          ...(target ? { targetLanguageCode: target.code } : {}) };
        const result = await db.page(args);
        if (!result.isDone && result.continueCursor === cursor) throw new Error('Pagination did not advance');
        pending.push({ args, result });
        cursor = result.continueCursor;
        words += result.page.length;
        pages++;
        if (result.isDone || (cfg.maxPages && pages >= cfg.maxPages)) break;
      } while (words < windowSize);
      try {
        await processPages(cfg, db, ai, pending, languagePolicy(language, cfg.languagePolicies), target, log);
      } catch (error) {
        if (!(error instanceof BudgetReachedError)) throw error;
        stopForBudget();
        return;
      }
      if (ai.totals().committed >= cfg.budget) { stopForBudget(); return; }
      if (cfg.maxPages && pages >= cfg.maxPages) { log(`Stopped after ${pages} page(s).`); return; }
      if (pending.at(-1).result.isDone) break;
    }
  }
  log(`Scan complete. Finalized results ${cfg.write ? 'inserted into the database' : 'saved locally'}. Rerun to retry skipped items.`);
}

export async function main(task) {
  let ai;
  try {
    const cfg = configuration(task);
    if (cfg.help) { console.log(help(task)); return; }
    cfg.identity = developmentIdentity(cfg.project, cfg.devKey);
    ai = createAI(cfg);
    await populate(task, cfg, connect(cfg), ai);
  } catch (error) {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (ai) {
      const total = ai.totals();
      console.log(JSON.stringify({ knownCostUSD: total.known / 1e9, uncertainUpperBoundUSD: total.uncertain / 1e9,
        budgetCommittedUSD: total.committed / 1e9, usage: total.usage }));
    }
  }
}
