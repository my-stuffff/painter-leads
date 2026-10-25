#!/usr/bin/env node
// Repository guards (T-01-05): nothing large, no roster/personnel/export files, no client data paths.
// Runs over `git ls-files` of the current directory (excluding .planning/). Prints each offender and
// exits 1; prints "guards: ok" otherwise.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;
const LARGE_ALLOWLIST = new Map([['data/geo/pilot-zcta.geojson', 5_000_000]]);
const BINARY_EXT = new Set(['.gz', '.xlsx', '.png', '.jpg', '.jpeg', '.zip', '.ico', '.woff', '.woff2']);

// Real download file names (NJ roster, CSLB files, the client CRM export).
const FORBIDDEN_NAME = [/^Data\.txt$/i, /PersonnelData/i, /MasterLicenseData/i, /Export_Contacts/i];
const TABLE_EXT = new Set(['.xlsx', '.csv']);
const TABLE_ALLOWED_DIR = /(^|\/)(fixtures|test)\//;

// Built from parts so this script does not flag itself.
const DOWNLOADS = ['Users', 'bigsh', 'Downloads'];
const DOWNLOADS_RE = new RegExp(DOWNLOADS.join('[\\\\/]+'), 'i');

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((f) => f.length > 0 && !f.startsWith('.planning/'));

const offenders = [];

for (const file of files) {
  const base = path.posix.basename(file);
  const ext = path.posix.extname(file).toLowerCase();

  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue; // deleted in the working tree
  }
  const limit = LARGE_ALLOWLIST.get(file) ?? MAX_BYTES;
  if (size > limit) offenders.push(`${file}: ${size} bytes exceeds the ${limit} byte limit`);

  if (FORBIDDEN_NAME.some((re) => re.test(base))) {
    offenders.push(`${file}: file name looks like a raw roster / personnel / export download`);
  }
  if (TABLE_EXT.has(ext) && !TABLE_ALLOWED_DIR.test(file)) {
    offenders.push(`${file}: ${ext} files are only allowed under a test/ or fixtures/ folder`);
  }
  if (!BINARY_EXT.has(ext) && size <= limit) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (DOWNLOADS_RE.test(text)) offenders.push(`${file}: mentions the owner's Downloads folder`);
  }
}

if (offenders.length > 0) {
  for (const o of offenders) console.error(`guard violation: ${o}`);
  process.exit(1);
}
console.log('guards: ok');
