#!/usr/bin/env node
// Prints the field shape of everything probe.mjs captured.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let text;
try {
  text = readFileSync(path.join(here, 'captured.jsonl'), 'utf8');
} catch {
  console.log('还没有捕获到任何 hook 调用。请在本仓库里开一个新的代理会话再试。');
  process.exit(0);
}

const shape = (v, d = 0) =>
  v === null || typeof v !== 'object' || d > 1
    ? Array.isArray(v) ? `array[${v.length}]` : typeof v
    : `{ ${Object.entries(v).map(([k, x]) => `${k}: ${shape(x, d + 1)}`).join(', ')} }`;

for (const line of text.split('\n').filter((l) => l.trim())) {
  const { ts, argv, raw } = JSON.parse(line);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.log(`${ts} [argv ${JSON.stringify(argv)}] 非 JSON: ${raw.slice(0, 200)}`);
    continue;
  }
  console.log(`\n=== ${ts} · argv=${JSON.stringify(argv)} ===`);
  console.log(shape(payload));
}
