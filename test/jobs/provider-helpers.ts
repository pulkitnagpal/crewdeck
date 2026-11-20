// The fictional provider tree (test/fixtures/jobs/providers; workday, greenhouse and neogov are shaped like the real ones
// but read fictional hosts only) as an "installed" providers folder with its own manifest:
// the same shape the pinned career-ops manifest has, so the real runner and installer run against it.
import { cpSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '../../src/jobs/providers.ts';
import { REPO } from './helpers.ts';

export const FIXTURE_TREE = join(REPO, 'test', 'fixtures', 'jobs', 'providers');
export const FIXTURE_PROVIDERS = ['broken', 'evil-escape', 'evil-forge', 'evil-import', 'evil-net', 'evil-read', 'evil-spawn', 'fixture-ats', 'fixture-board', 'greenhouse', 'neogov', 'noisy', 'slow', 'workday'];
const LISTED = ['providers/_http.mjs', 'lib/clean.mjs', ...FIXTURE_PROVIDERS.map((p) => `providers/${p}.mjs`)];
const LICENSE = 'MIT License\n\nCopyright (c) 2026 Example Maintainers\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this fixture.\n';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A manifest over the fixture tree (unlisted.mjs is on disk but deliberately not listed). */
export function fixtureManifest(): Manifest {
  return {
    repo: 'example/providers', commit: 'a'.repeat(40),
    license: { spdx: 'MIT', copyright: 'Copyright (c) 2026 Example Maintainers', text: LICENSE, file: 'LICENSE', sha256: sha(LICENSE) },
    providers: FIXTURE_PROVIDERS, detectors: ['fixture-ats', 'greenhouse', 'neogov', 'workday'],
    files: Object.fromEntries(LISTED.map((p) => [p, sha(readFileSync(join(FIXTURE_TREE, p)))])),
    optional_imports: {}, excluded: {},
  };
}

/** A copy of the fixture tree in a temp dir, as if installed. */
export function installedFixture(): { dir: string; manifest: Manifest } {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'cd-prov-')));
  cpSync(FIXTURE_TREE, dir, { recursive: true });
  return { dir, manifest: fixtureManifest() };
}
