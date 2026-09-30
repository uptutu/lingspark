#!/usr/bin/env node
// Runs `lingspark check` over the real product documents on this machine and
// prints a per-rule tally, so every rule change can be regression-checked
// against real prose -- chiefly for false positives.
//
// The documents are found fresh on each run with Spotlight and read in place.
// Nothing about them -- not the list, not the text, not the results -- is
// written inside this repository: the repo will be published, the documents
// are private. Output goes to a directory outside the repo.
//
// Usage:
//   node tools/corpus/run.mjs [--out <dir>] [--sample <RULE> [n]] [--with-judge]
//
// By default only the rules that need no model run (passes 0 and 1), offline:
// a regression over 145 documents must not spend the user's model quota, and
// with a subscription judge it would take hours. --with-judge runs everything.
//
// macOS only (Spotlight). Requires a built CLI: `pnpm run build`.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repo, 'packages', 'cli', 'dist', 'lingspark.cjs');
const home = os.homedir();

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const outDir = path.resolve(argOf('--out') ?? path.join(os.tmpdir(), 'lingspark-corpus'));
const sampleRule = argOf('--sample');
const sampleN = Number(args[args.indexOf('--sample') + 2] ?? 20) || 20;
const scope = args.includes('--with-judge') ? [] : ['--passes', '0,1', '--offline'];

if (outDir.startsWith(repo)) {
  console.error('输出目录不能在仓库里面：语料是私人文档。');
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error(`找不到 ${cli}，先运行 pnpm run build。`);
  process.exit(2);
}

// Directories that hold tooling, caches, or personal records rather than
// product documents. Resumes and similar personal records are excluded; agent
// session transcripts are excluded because reading them is not authorised.
const EXCLUDE = new RegExp(
  '/(node_modules|\\.git|Library|\\.Trash|\\.cache|\\.npm|\\.pnpm-store|\\.cargo|\\.rustup|' +
    '\\.vscode|\\.cursor|\\.local|\\.codex|\\.claude|site-packages|venv|\\.venv|dist|build|' +
    'vendor|\\.gradle|Pods|DerivedData|[^/]*简历[^/]*|[^/]*[Rr]esume[^/]*)/',
);

const HAN = /[一-鿿]/gu;
const MIN_HAN = 800;
const MIN_HEADINGS = 3;

function discover() {
  const found = execFileSync('mdfind', ['-onlyin', home, 'kMDItemFSName == "*.md"c'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((p) => p !== '' && !EXCLUDE.test(p) && !p.startsWith(repo));

  const seen = new Set();
  const corpus = [];
  for (const p of found) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if ((text.match(HAN) ?? []).length < MIN_HAN) continue;
    if ((text.match(/^#{1,6}\s/gmu) ?? []).length < MIN_HEADINGS) continue;
    const h = createHash('sha256').update(text).digest('hex');
    if (seen.has(h)) continue;
    seen.add(h);
    corpus.push(p);
  }
  return corpus.sort();
}

function check(files) {
  const results = [];
  for (let i = 0; i < files.length; i += 40) {
    const r = spawnSync('node', [cli, 'check', '--format', 'json', ...scope, ...files.slice(i, i + 40)], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0 && r.status !== 1) {
      console.error(`批次失败（退出码 ${r.status}）：${r.stderr.slice(0, 400)}`);
      continue;
    }
    results.push(...JSON.parse(r.stdout).files);
  }
  return results;
}

const corpus = discover();
const results = check(corpus);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results));

const byRule = new Map();
for (const f of results) {
  for (const d of f.diagnostics) {
    const e = byRule.get(d.ruleId) ?? { n: 0, files: new Set() };
    e.n++;
    e.files.add(f.file);
    byRule.set(d.ruleId, e);
  }
}
const total = [...byRule.values()].reduce((s, e) => s + e.n, 0);
console.log(`${results.length} 篇，诊断 ${total} 条（结果在 ${outDir}，仓库外）`);
for (const [id, e] of [...byRule.entries()].sort()) {
  console.log(`  ${id} ${String(e.n).padStart(5)} 条 / ${String(e.files.size).padStart(3)} 篇`);
}

if (sampleRule !== undefined) {
  const hits = results.flatMap((f) =>
    f.diagnostics.filter((d) => d.ruleId === sampleRule).map((d) => ({ file: f.file, d })),
  );
  console.log(`\n--- ${sampleRule} 前 ${Math.min(sampleN, hits.length)} 条（共 ${hits.length}）---`);
  const cache = new Map();
  const lineOf = (file, n) => {
    if (!cache.has(file)) cache.set(file, readFileSync(path.resolve(repo, file), 'utf8').split('\n'));
    return (cache.get(file)[n - 1] ?? '').trim().slice(0, 110);
  };
  for (const { file, d } of hits.slice(0, sampleN)) {
    console.log(`── ${path.basename(file)}:${d.range.start.line}  ${d.message}`);
    console.log(`   ${lineOf(file, d.range.start.line)}`);
  }
}
