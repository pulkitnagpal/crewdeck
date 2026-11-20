// Company directory seed (ADR-0002): the shipped CC BY seed is pinned by SHA-256, curated entries are well-formed, and
// the offline enrichment is deterministic and honest (unknown is the common answer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrich } from '../../../src/jobs/directory/enrich.ts';
import { DIR, SEED_FILE, SEED_SHA256, SeedHashError, csvLine, curatedIssues, loadDirectory, loadSeed, sha256 } from '../../../src/jobs/directory/seed.ts';

test('the shipped seed matches its pin, SOURCE.md records both hashes and the licence', () => {
  assert.equal(sha256(readFileSync(SEED_FILE)), SEED_SHA256);
  const src = readFileSync(join(DIR, 'SOURCE.md'), 'utf8');
  assert.match(src, new RegExp(SEED_SHA256));
  assert.match(src, /e637a04d06561bb3839dbf95a291e5fd11ac26b8f2858dc207939c1b723974a3/, 'original download hash');
  assert.match(src, /CC BY 4\.0/);
  assert.match(src, /LastRound AI/);
  assert.match(src, /2026-11-20/);
});

test('a changed seed file is refused (pinning)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crewdeck-seed-'));
  const f = join(dir, 'seed.csv');
  copyFileSync(SEED_FILE, f);
  assert.equal(loadSeed(f).length, 9932);
  writeFileSync(f, readFileSync(f, 'utf8') + 'greenhouse,"Injected Co",injected,2026-11-20\n');
  assert.throws(() => loadSeed(f), SeedHashError);
  assert.throws(() => loadDirectory({ seedFile: f }), /expected 5ea6dfb7/);
});

test('seed rows parse: three vendors, quoted names with commas, unique ids', () => {
  const rows = loadSeed();
  const by = (a: string) => rows.filter((r) => r.ats === a).length;
  assert.deepEqual([by('greenhouse'), by('ashby'), by('lever')], [4966, 2854, 2112]);
  assert.deepEqual(csvLine('ashby,"80,000 Hours",80000hours,2026-07-12'), ['ashby', '80,000 Hours', '80000hours', '2026-07-12']);
  assert.deepEqual(csvLine('x,"say ""hi""",y,z'), ['x', 'say "hi"', 'y', 'z']);
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.seenAt) && r.board && r.name));
});

test('curated entries are well-formed; verified ones carry evidence; quarantine is off by default', () => {
  assert.deepEqual(curatedIssues(), []);
  const d = loadDirectory();
  assert.equal(d.byId.size, d.companies.length);
  const mgb = d.byId.get('workday:massgeneralbrigham/wd1/MGBExternal')!;
  assert.equal(mgb.verified, true);
  assert.equal(mgb.url, 'https://massgeneralbrigham.wd1.myworkdayjobs.com/MGBExternal');
  assert.deepEqual(mgb.regions, ['us']);
  const phonepe = d.byId.get('greenhouse:phonepe')!;
  assert.equal(phonepe.quarantine, true, 'gone board (404 on 2026-11-20) is quarantined');
  assert.equal(phonepe.origin, 'seed', 'an overlay keeps the seed origin');
  assert.ok(d.companies.filter((c) => c.quarantine).every((c) => c.curated && c.note), 'only curated entries are quarantined, each with a reason');
  const groww = d.byId.get('greenhouse:groww')!;
  assert.deepEqual([groww.regions, groww.regionConfidence, groww.familyConfidence], [['in'], 'medium', 'medium']);
});

test('enrichment: industry and place words, confidence, unknown when the name says nothing', () => {
  const a = enrich('Adaptive Home Health');
  assert.ok(a.families.includes('healthcare') && a.families.includes('care-social'));
  assert.equal(a.familyConfidence, 'low');
  assert.deepEqual(enrich('Arkose Labs - India').regions, ['in']);
  assert.equal(enrich('Arkose Labs - India').regionConfidence, 'medium');
  const pvt = enrich('South Star Software Private Limited');
  assert.deepEqual([pvt.regions, pvt.regionConfidence], [['in'], 'low']);
  assert.deepEqual(enrich('Klarstein', 'berlin-brands').regions, ['de'], 'slug words (split on - and _) count');
  assert.deepEqual(enrich('Klarstein', 'berlinbrands').regions, [], 'run-together slugs are not guessed apart');
  const z = enrich('Zapier');
  assert.deepEqual([z.families, z.familyConfidence, z.regions, z.regionConfidence, z.remote], [[], 'unknown', [], 'unknown', null]);
  assert.equal(enrich('Remote Woman').remote, true);
  assert.equal(enrich('Acme Staffing Partners').staffing, true);
  assert.deepEqual(enrich('Samsung Research America').families, ['science-research'], 'research is not healthcare');
  assert.deepEqual(enrich('Adaptive Home Health'), enrich('Adaptive Home Health'), 'deterministic');
});

test('most of the directory stays honestly unknown', () => {
  const d = loadDirectory();
  const unknownRegion = d.companies.filter((c) => c.regionConfidence === 'unknown').length;
  assert.ok(unknownRegion / d.companies.length > 0.8, `${unknownRegion} of ${d.companies.length}`);
  assert.ok(existsSync(join(DIR, 'curated.yaml')));
});
