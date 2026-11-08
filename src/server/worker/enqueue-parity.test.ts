/**
 * Port of `tests/unit/test_enqueued_jobs.py`: every `enqueueJob('name', ...)` in the source names a registered job and
 * passes keys it reads. Python's arq checks args only when the job runs; the scan catches a renamed parameter at test
 * time (2026-10: /demo/notify enqueued `user_id=` after the parameter became `telegram_user_id`).
 *
 * The scan reads the source text: a literal call is checked for its name, and an inline object literal for its keys
 * (both spellings, snake_case and camelCase). A payload built elsewhere (`enqueueJob(name, job)`) is checked by name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobs } from './registry';

const SRC = join(import.meta.dirname, '..');
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

interface Call {
  file: string;
  name: string;
  keys: string[] | null;
}

/** Top-level keys of an object literal starting at `start` (a `{`). */
function literalKeys(text: string, start: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  let expectKey = true;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if ('{[('.includes(ch)) {
      depth += 1;
      if (depth === 1) {
        expectKey = true;
        token = '';
        continue;
      }
    } else if ('}])'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        if (expectKey && token.trim()) keys.push(token.trim());
        break;
      }
    }
    if (depth === 1) {
      if (ch === ',') {
        if (expectKey && token.trim()) keys.push(token.trim());
        expectKey = true;
        token = '';
      } else if (ch === ':' && expectKey) {
        keys.push(token.trim());
        expectKey = false;
      } else if (expectKey && /[\w$]/.test(ch)) {
        token += ch;
      }
    }
  }
  return keys.filter((key) => /^[\w$]+$/.test(key));
}

function findEnqueueCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of sourceFiles(SRC)) {
    // Comments may mention keys
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const match of text.matchAll(/enqueueJob\(\s*'([^']+)'\s*(?:,\s*(\{)?)?/g)) {
      const braceAt = match[2] ? (match.index ?? 0) + match[0].length - 1 : -1;
      calls.push({
        file: file.slice(SRC.length + 1),
        name: match[1] as string,
        keys: braceAt >= 0 ? literalKeys(text, braceAt) : null,
      });
    }
  }
  return calls.filter((call) => !call.file.startsWith('worker/'));
}

describe('enqueued jobs match the worker', () => {
  const calls = findEnqueueCalls();

  it('finds the enqueue calls (is the source path right?)', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('every enqueued name is a registered job', () => {
    expect(calls.filter((call) => !(call.name in jobs)).map((call) => `${call.file}: ${call.name}`)).toEqual([]);
  });

  it('every inline payload key is a parameter the job reads', () => {
    const bad = calls.flatMap((call) => {
      const params = jobs[call.name]?.params ?? [];
      const accepted = new Set([...params, ...params.map(camel)]);
      return (call.keys ?? []).filter((key) => !accepted.has(key)).map((key) => `${call.file}: ${call.name}(${key})`);
    });
    expect(bad).toEqual([]);
  });

  it('the scan sees the keys it checks', () => {
    const backup = calls.find((call) => call.name === 'backup_database_job');
    expect(backup?.keys).toEqual(['requester_telegram_id']);
  });
});
