import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { PROJECT_DIR } from '../paths.js';
import { msg } from '../messages.js';

const termSchema = z
  .object({
    /** The spelling the team has settled on. */
    preferred: z.string().min(1),
    /** Other spellings that are fine, e.g. an accepted abbreviation. */
    aliases_allowed: z.array(z.string()).default([]),
    /** Spellings that should be reported when they appear. */
    forbidden: z.array(z.string()).default([]),
    definition: z.string().optional(),
  })
  .strict();

export const glossaryFileSchema = z
  .object({
    version: z.number().int().optional(),
    terms: z.array(termSchema).default([]),
  })
  .strict();

export type GlossaryTerm = z.infer<typeof termSchema>;

export interface Glossary {
  readonly terms: readonly GlossaryTerm[];
  /** Every spelling that counts as a legitimate mention of some term. */
  readonly allowedSpellings: ReadonlySet<string>;
}

export const EMPTY_GLOSSARY: Glossary = { terms: [], allowedSpellings: new Set() };

export function buildGlossary(terms: readonly GlossaryTerm[]): Glossary {
  const allowed = new Set<string>();
  for (const t of terms) {
    allowed.add(t.preferred);
    for (const a of t.aliases_allowed) allowed.add(a);
  }
  return { terms, allowedSpellings: allowed };
}

/**
 * Loads `<project>/.lingspark/glossary.yaml`.
 *
 * A missing or broken glossary yields an empty one rather than an error: the
 * glossary drives a single warning-level rule, and failing the whole check
 * because of it would violate design principle 2.
 */
export function loadGlossary(
  projectRoot: string | null,
  warnings: string[] = [],
): Glossary {
  if (projectRoot === null) return EMPTY_GLOSSARY;
  const file = path.join(projectRoot, PROJECT_DIR, 'glossary.yaml');

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return EMPTY_GLOSSARY;
  }

  try {
    const parsed = glossaryFileSchema.safeParse(parseYaml(text) ?? {});
    if (!parsed.success) {
      warnings.push(msg.rules.glossaryInvalid(file, parsed.error.issues[0]?.message ?? ''));
      return EMPTY_GLOSSARY;
    }
    return buildGlossary(parsed.data.terms);
  } catch (err: unknown) {
    warnings.push(msg.rules.glossaryUnparsable(file, String(err)));
    return EMPTY_GLOSSARY;
  }
}
