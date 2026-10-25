import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDir } from '../src/paths';

const saved = process.env.PP_DATA_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.PP_DATA_DIR;
  else process.env.PP_DATA_DIR = saved;
});

describe('dataDir', () => {
  it('PP_DATA_DIR wins and is made absolute', () => {
    process.env.PP_DATA_DIR = path.join(process.cwd(), 'some-data-dir');
    expect(dataDir()).toBe(path.join(process.cwd(), 'some-data-dir'));
  });

  it('defaults to the project evidence folder on Windows, with every path separator intact', () => {
    delete process.env.PP_DATA_DIR;
    const d = dataDir();
    if (process.platform === 'win32') {
      expect(d).toBe('D:\\ClaudeCode\\Painter-Promotions\\pp-data');
    } else {
      expect(d.endsWith('.pp-data')).toBe(true);
    }
  });
});
