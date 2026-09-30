#!/usr/bin/env node
// Runs the cross-document check (Pass 3) over the labelled document sets in
// packages/rules-builtin/fixtures/pass3 with the judge configured for this
// user, and scores it: every c-set has exactly one contradiction between two
// documents (expected.json says where), every n-set has none.
//
// This calls a real model and takes minutes. It is a measuring tool, not a
// test: CI never runs it.
//
// Usage: node tools/pass3-eval/run.mjs [--parallel 2] [--budget 600] [--only c01,n03]

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repo, 'packages', 'cli', 'dist', 'lingspark.cjs');
const root = path.join(repo, 'packages', 'rules-builtin', 'fixtures', 'pass3');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const parallel = Number(opt('--parallel', '2'));
const budget = opt('--budget', '600');
const only = opt('--only', '')?.split(',').filter(Boolean) ?? [];

const sets = readdirSync(root)
  .filter((d) => /^[cn]\d+$/u.test(d) && (only.length === 0 || only.includes(d)))
  .sort();

function runSet(id) {
  const dir = path.join(root, id);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [cli, 'check', '--all', '--passes', '3', '--format', 'json', '--budget', budget], { cwd: dir });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', () => {
      let diags = [];
      try {
        diags = JSON.parse(out).files.flatMap((f) => f.diagnostics.filter((d) => d.ruleId === 'G301').map((d) => ({ ...d, file: f.file })));
      } catch {
        // reported below as unreadable
      }
      resolve({ id, diags, err: err.trim(), seconds: Math.round((Date.now() - t0) / 1000), raw: out });
    });
  });
}

const near = (loc, file, line) => path.basename(loc.file) === path.basename(file) && loc.line === line;
function score(id, diags) {
  const expected = JSON.parse(readFileSync(path.join(root, id, 'expected.json'), 'utf8'));
  const locs = diags.map((d) => ({
    here: { file: d.file, line: d.range?.start?.line ?? d.line },
    there: { file: d.related?.[0]?.file ?? '', line: d.related?.[0]?.line ?? -1 },
  }));
  if (!expected.contradiction) return { expected: false, found: diags.length > 0, correct: diags.length === 0, extra: diags.length };
  const matches = (l) =>
    (near(l.here, expected.a.file, expected.a.line) && near(l.there, expected.b.file, expected.b.line)) ||
    (near(l.here, expected.b.file, expected.b.line) && near(l.there, expected.a.file, expected.a.line));
  const hit = locs.some(matches);
  return { expected: true, found: hit, correct: hit, extra: locs.filter((l) => !matches(l)).length };
}

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, sets.length) }, async () => {
    while (next < sets.length) {
      const id = sets[next++];
      const r = await runSet(id);
      const s = score(id, r.diags);
      results.push({ ...r, ...s });
      console.log(`${id}  ${s.correct ? '✓' : '✗'}  ${s.expected ? '应有矛盾' : '应无矛盾'}  报出 ${r.diags.length} 条（多报 ${s.extra}）  ${r.seconds}s`);
      for (const d of r.diags) console.log(`      ${path.basename(d.file)}:${d.range?.start?.line}  ${d.message}`);
      if (r.err) console.log(`      ${r.err.split('\n').slice(-2).join(' | ')}`);
    }
  }),
);

const c = results.filter((r) => r.expected);
const n = results.filter((r) => !r.expected);
const extra = results.reduce((a, r) => a + r.extra, 0);
console.log(`\n有矛盾的 ${c.length} 组：抓到 ${c.filter((r) => r.found).length} 组`);
console.log(`无矛盾的 ${n.length} 组：误报 ${n.filter((r) => r.found).length} 组`);
console.log(`所有组里多报（不是标准答案的那一处）共 ${extra} 条`);
