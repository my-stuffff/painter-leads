import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../paths';
import type { SourceId } from '../types';
import { PpConfigSchema, type PpConfig } from './schema';

export function defaultConfigPath(): string {
  return process.env.PP_CONFIG && process.env.PP_CONFIG.length > 0
    ? path.resolve(process.env.PP_CONFIG)
    : path.join(REPO_ROOT, 'pp.config.json');
}

/** Reads and validates the ONE settings file. There are no code defaults for any value. */
export function loadConfig(file: string = defaultConfigPath()): PpConfig {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read config ${file}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = PpConfigSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const keyPath = i.path.length > 0 ? i.path.map(String).join('.') : '(root)';
      return `  ${keyPath}: ${i.message}`;
    });
    throw new Error(`Invalid config ${file}:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export function isSourceEnabled(config: PpConfig, id: SourceId): boolean {
  return config.sources[id].enabled;
}
