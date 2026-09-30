#!/usr/bin/env node
// Hook stdin probe (design doc, section 15: "装一个只把 stdin 写到临时文件的 hook").
//
// Records the raw JSON an agent sends to a hook so we can verify field names
// against the docs instead of guessing. It never blocks and never fails:
// whatever happens, it exits 0, because a probe that breaks the operator's
// session is worse than no probe.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, 'captured.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    mkdirSync(here, { recursive: true });
    appendFileSync(outFile, `${JSON.stringify({ ts: new Date().toISOString(), argv: process.argv.slice(2), raw })}\n`);
  } catch {
    // ignore: fail-open
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
