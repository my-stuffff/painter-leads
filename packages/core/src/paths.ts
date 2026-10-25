import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PpConfig } from './config/schema';

/** Repo root: this file lives at <root>/packages/core/src/paths.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Where cached pages, downloads and run output live (never committed).
 * PP_DATA_DIR wins; on Windows the project evidence folder lives under the project
 * (short path, survives worktree deletion); elsewhere ./.pp-data.
 */
export function dataDir(_config?: PpConfig): string {
  const fromEnv = process.env.PP_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  if (process.platform === 'win32') return 'D:\ClaudeCode\Painter-Promotions\pp-data';
  return path.join(REPO_ROOT, '.pp-data');
}
