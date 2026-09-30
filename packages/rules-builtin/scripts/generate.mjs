// Inlines every builtin rule YAML into a single generated module.
//
// The YAML files under rules/ are the source of truth: a rule author edits
// those and nothing else (design doc, section 7.1). But the CLI ships as a
// single-file executable, so at runtime there is no rules/ directory to read
// from -- the text has to be baked into the bundle. This script is that step.
//
// Team and personal rules are unaffected: those are always read from disk.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulesDir = path.join(pkgDir, 'rules');
const outDir = path.join(pkgDir, 'generated');
const outFile = path.join(outDir, 'rules.ts');

async function listRuleFiles() {
  let entries;
  try {
    entries = await readdir(rulesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => e.name)
    .sort();
}

const files = await listRuleFiles();
const sources = [];
for (const name of files) {
  sources.push({ file: name, yaml: await readFile(path.join(rulesDir, name), 'utf8') });
}

const body = `// GENERATED FILE -- do not edit. Run \`pnpm --filter @lingspark/rules-builtin build\`.
// Source: packages/rules-builtin/rules/*.yaml

export interface BuiltinRuleSource {
  /** File name the rule came from, for error messages. */
  readonly file: string;
  /** Verbatim YAML text; parsed and zod-validated by the rule loader. */
  readonly yaml: string;
}

export const builtinRuleSources: readonly BuiltinRuleSource[] = ${JSON.stringify(sources, null, 2)};
`;

await mkdir(outDir, { recursive: true });
await writeFile(outFile, body, 'utf8');
console.log(`rules-builtin: inlined ${sources.length} rule(s) into generated/rules.ts`);
