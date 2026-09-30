import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { msg } from '../messages.js';
import { dataPaths, findProjectRoot, PROJECT_CONFIG, PROJECT_DIR, type PathEnv } from '../paths.js';
import type { CliOverrides } from './resolve.js';
import { resolveConfig } from './resolve.js';
import {
  CONFIG_VERSION,
  CREDENTIAL_KEYS,
  PROJECT_ONLY_KEYS,
  USER_ONLY_KEYS,
  projectConfigFileSchema,
  userConfigFileSchema,
  type ProjectConfigFile,
  type ResolvedConfig,
  type UserConfigFile,
} from './schema.js';

/** A problem serious enough that lingspark should not run with this config. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const where = i.path.length > 0 ? i.path.join('.') : msg.config.root;
      return `${where}: ${i.message}`;
    })
    .join('; ');
}

/** Reads and YAML-parses a file. Returns null when the file does not exist. */
export function readConfigFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(msg.config.unreadable(file, String(err)));
  }
  try {
    return parseYaml(text) ?? {};
  } catch (err: unknown) {
    throw new ConfigError(msg.config.invalid(file, String(err)));
  }
}

/**
 * Walks a parsed config looking for anything that smells like a credential.
 *
 * This runs before schema validation so the user gets the specific "move this
 * to credentials.yaml" message rather than a generic "unrecognized key".
 * Matching is on key names, not values: it is predictable, and there is no
 * legitimate `key`/`token`/`secret` field anywhere in a lingspark config.
 */
export function findCredentialKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findCredentialKey(item, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if ((CREDENTIAL_KEYS as readonly string[]).includes(k.toLowerCase())) return k;
    const hit = findCredentialKey(v, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

function checkVersion(raw: unknown, file: string): void {
  if (raw === null || typeof raw !== 'object') return;
  const v = (raw as { version?: unknown }).version;
  if (v !== undefined && v !== CONFIG_VERSION) {
    throw new ConfigError(`${msg.config.invalid(file, msg.config.unsupportedVersion(v, CONFIG_VERSION))}`);
  }
}

export interface LoadedLayer<T> {
  readonly config: T | null;
  readonly warnings: readonly string[];
}

export function loadProjectConfig(projectRoot: string): LoadedLayer<ProjectConfigFile> {
  const file = path.join(projectRoot, PROJECT_DIR, PROJECT_CONFIG);
  const raw = readConfigFile(file);
  if (raw === null) return { config: null, warnings: [] };

  const credential = findCredentialKey(raw);
  if (credential !== null) {
    throw new ConfigError(msg.config.credentialInProject(file, credential));
  }
  checkVersion(raw, file);

  const warnings: string[] = [];
  const stripped = { ...(raw as Record<string, unknown>) };
  for (const key of USER_ONLY_KEYS) {
    if (key in stripped) {
      warnings.push(msg.config.userOnlyKeyInProjectConfig(key));
      delete stripped[key];
    }
  }

  const parsed = projectConfigFileSchema.safeParse(stripped);
  if (!parsed.success) {
    throw new ConfigError(msg.config.invalid(file, formatZodError(parsed.error)));
  }
  // Where documents go and what program runs are the user's call, not the
  // repository's (D-031); say so rather than silently ignoring the field.
  const j = parsed.data.judge;
  const e = parsed.data.extractor;
  if (j?.endpoint !== undefined) warnings.push(msg.config.endpointInProject('judge.endpoint'));
  if (j?.command !== undefined) warnings.push(msg.config.endpointInProject('judge.command'));
  if (e?.endpoint !== undefined) warnings.push(msg.config.endpointInProject('extractor.endpoint'));
  return { config: parsed.data, warnings };
}

export function loadUserConfig(env?: PathEnv): LoadedLayer<UserConfigFile> {
  const file = dataPaths.config(env);
  const raw = readConfigFile(file);
  if (raw === null) return { config: null, warnings: [] };
  checkVersion(raw, file);

  const warnings: string[] = [];
  const stripped = { ...(raw as Record<string, unknown>) };
  for (const key of PROJECT_ONLY_KEYS) {
    if (key in stripped) {
      warnings.push(msg.config.projectOnlyKeyInUserConfig(key));
      delete stripped[key];
    }
  }

  const parsed = userConfigFileSchema.safeParse(stripped);
  if (!parsed.success) {
    throw new ConfigError(msg.config.invalid(file, formatZodError(parsed.error)));
  }
  return { config: parsed.data, warnings };
}

export interface LoadConfigOptions {
  /** Where to start looking for `.lingspark/config.yaml`. */
  readonly cwd: string;
  readonly cli?: CliOverrides;
  readonly pathEnv?: PathEnv;
  /** Injected for tests; defaults to a real filesystem check. */
  readonly exists?: (p: string) => boolean;
}

/**
 * Loads and merges every config layer.
 *
 * Returns a config with `projectRoot: null` when the directory has not opted
 * in. Callers must treat that as "nothing here is checked" -- the defaults are
 * filled in only so that commands like `doctor` have something to report.
 */
export function loadConfig(opts: LoadConfigOptions): ResolvedConfig {
  // existsSync, not a read: this runs once per parent directory on the hook
  // no-op path, and reading a file to find out whether it exists is exactly
  // the kind of waste HOOK_NOOP_MS does not leave room for.
  const exists = opts.exists ?? existsSync;

  const projectRoot = findProjectRoot(opts.cwd, exists);
  const user = loadUserConfig(opts.pathEnv);
  const project =
    projectRoot === null
      ? { config: null, warnings: [] as readonly string[] }
      : loadProjectConfig(projectRoot);

  return resolveConfig({
    projectRoot,
    project: project.config,
    user: user.config,
    ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
    warnings: [...user.warnings, ...project.warnings],
  });
}
