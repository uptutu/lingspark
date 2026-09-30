import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { dataPaths, type PathEnv } from '../paths.js';

/** The credentials lingspark knows how to look up (design doc, 8.5). */
export type CredentialName = 'typesafe' | 'anthropic' | 'openai' | 'openrouter';

const ENV: Readonly<Record<CredentialName, string>> = {
  typesafe: 'TYPESAFE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const FILE_KEY: Readonly<Record<CredentialName, string>> = {
  typesafe: 'typesafe_api_key',
  anthropic: 'anthropic_api_key',
  openai: 'openai_api_key',
  openrouter: 'openrouter_api_key',
};

/**
 * Looks a key up: environment first, then `<data>/credentials.yaml`.
 *
 * Returns the key or null and nothing else. The value must never reach a log,
 * a diagnostic or an error message; callers pass it straight into a request
 * header. A project config carrying a key is refused at load time instead
 * (config/load.ts).
 */
export function getCredential(name: CredentialName, env?: PathEnv): string | null {
  const fromEnv = (env?.env ?? process.env)[ENV[name]];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();

  let text: string;
  try {
    text = readFileSync(dataPaths.credentials(env), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = parseYaml(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    const v = (parsed as Record<string, unknown>)[FILE_KEY[name]];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  } catch {
    return null;
  }
}

/** For messages: where the user should put a missing key. Never includes a value. */
export function credentialHint(name: CredentialName, env?: PathEnv): string {
  return `${ENV[name]} 环境变量，或 ${dataPaths.credentials(env)} 里的 ${FILE_KEY[name]}`;
}
