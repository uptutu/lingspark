import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ResolvedConfig } from '../config/schema.js';
import { dataPaths, PROJECT_DIR, type PathEnv } from '../paths.js';
import { ruleFileSchema, type Rule, type RuleOrigin } from './schema.js';
import { msg } from '../messages.js';

/** Id prefixes the builtin rule set reserves (design doc, section 7.2). */
const BUILTIN_PREFIXES = ['D', 'S', 'G'];

export interface RuleSource {
  readonly file: string;
  readonly yaml: string;
  readonly origin: RuleOrigin;
}

export interface LoadRulesResult {
  /** Rules by id, after layering and config overrides. */
  readonly rules: ReadonlyMap<string, Rule>;
  readonly warnings: readonly string[];
}

/**
 * Parses one rule file.
 *
 * A rule that fails validation is skipped with a warning, never thrown: one
 * bad YAML file in a team repo must not take the whole check down (design doc,
 * section 7.1).
 */
function parseRule(source: RuleSource, warnings: string[]): Rule | null {
  let raw: unknown;
  try {
    raw = parseYaml(source.yaml);
  } catch (err: unknown) {
    warnings.push(msg.rules.notYaml(source.file, String(err)));
    return null;
  }

  const parsed = ruleFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || msg.config.root}: ${i.message}`)
      .join('; ');
    warnings.push(msg.rules.invalid(source.file, detail));
    return null;
  }

  if (parsed.data.origin !== source.origin) {
    warnings.push(msg.rules.originMismatch(parsed.data.id, parsed.data.origin, source.origin));
  }

  return { ...parsed.data, origin: source.origin, sourcePath: source.file };
}

/** Reads every `*.yaml` in a directory. A missing directory yields nothing. */
export function readRuleDir(dir: string, origin: RuleOrigin): RuleSource[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'));
  } catch {
    return [];
  }
  const out: RuleSource[] = [];
  for (const name of entries.sort()) {
    const file = path.join(dir, name);
    try {
      out.push({ file, yaml: readFileSync(file, 'utf8'), origin });
    } catch {
      // Unreadable file: skip it. `doctor` surfaces permission problems.
    }
  }
  return out;
}

export interface LoadRulesOptions {
  readonly config: ResolvedConfig;
  /** Builtin rule YAML, inlined at build time (see DECISIONS D-007). */
  readonly builtin?: readonly { file: string; yaml: string }[];
  readonly pathEnv?: PathEnv;
  /** Overrides the personal rules directory; used by tests. */
  readonly personalDir?: string;
  /** Overrides the team rules directory; used by tests. */
  readonly teamDir?: string;
}

/**
 * Loads every layer and collapses them into one rule set.
 *
 * Later layers replace earlier ones by id: personal beats team beats builtin
 * (design doc, section 7.2). Config `disable` and `severity` are applied last,
 * so a user can always silence or downgrade a rule no matter which layer
 * defined it.
 */
export function loadRules(opts: LoadRulesOptions): LoadRulesResult {
  const { config } = opts;
  const warnings: string[] = [];

  const sources: RuleSource[] = [
    ...(opts.builtin ?? []).map((b) => ({ ...b, origin: 'builtin' as const })),
  ];

  const teamDir =
    opts.teamDir ??
    (config.projectRoot === null ? null : path.join(config.projectRoot, PROJECT_DIR, 'rules'));
  if (teamDir !== null) sources.push(...readRuleDir(teamDir, 'team'));

  const personalDir = opts.personalDir ?? dataPaths.personalRules(opts.pathEnv);
  sources.push(...readRuleDir(personalDir, 'personal'));

  const builtinIds = new Set<string>();
  for (const s of opts.builtin ?? []) {
    const m = /^\s*id:\s*["']?([A-Za-z0-9-]+)/mu.exec(s.yaml);
    if (m?.[1] !== undefined) builtinIds.add(m[1]);
  }

  const rules = new Map<string, Rule>();
  for (const source of sources) {
    const rule = parseRule(source, warnings);
    if (rule === null) continue;

    if (
      source.origin !== 'builtin' &&
      BUILTIN_PREFIXES.some((p) => rule.id.startsWith(p)) &&
      !builtinIds.has(rule.id)
    ) {
      warnings.push(msg.rules.reservedPrefix(rule.id, source.file));
    }

    rules.set(rule.id, rule);
  }

  // Config has the final say, whichever layer defined the rule.
  const resolved = new Map<string, Rule>();
  for (const [id, rule] of rules) {
    if (config.rules.disable.has(id)) continue;
    const severity = config.rules.severity.get(id);
    const threshold = config.rules.threshold.get(id);
    resolved.set(id, {
      ...rule,
      ...(severity !== undefined ? { severity } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
    });
  }

  return { rules: resolved, warnings };
}

/** The rules that should actually run for a document. */
export function selectRules(
  rules: ReadonlyMap<string, Rule>,
  opts: { pass: number; docType: string; includeShadow?: boolean },
): Rule[] {
  const wanted = opts.includeShadow === true ? ['active', 'shadow'] : ['active'];
  return [...rules.values()]
    .filter(
      (r) =>
        r.pass === opts.pass &&
        wanted.includes(r.status) &&
        (r.doc_types as readonly string[]).includes(opts.docType),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}
