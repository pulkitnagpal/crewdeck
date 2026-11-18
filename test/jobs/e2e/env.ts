// Imported first by every journey file: a fresh temp root and CREWDECK_HOME before any Crewdeck module reads it
// (src/config.ts fixes HOME, CONFIG_PATH and TOKEN_PATH when it loads). Never the real ~/.crewdeck or vault.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TMP = realpathSync(tmpdir());
export const ROOT = mkdtempSync(join(TMP, 'cd-e2e-'));
export const HOME = join(ROOT, 'crewdeck');
export const VAULT = join(ROOT, 'vault');
export const FILES = join(ROOT, 'files');
mkdirSync(HOME, { mode: 0o700 });
mkdirSync(FILES);
process.env.CREWDECK_HOME = HOME;
