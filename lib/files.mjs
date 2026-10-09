import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function appendEvent(path, event) {
  const fd = openSync(path, 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function lockState(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'population.lock');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`State is locked: ${path}. See README for crash recovery.`);
    throw error;
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  closeSync(fd);
  return () => unlinkSync(path);
}

export function journal(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!text.endsWith('\n')) throw new Error('Usage journal has an incomplete final event; recover it before continuing');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
