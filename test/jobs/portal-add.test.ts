// `portal_add` proposals (a job site the person named, or one a post linked to): the payload is checked, a site Crewdeck
// already knows becomes a portal switch or a source, the rest waits for Approve (never applied on its own) and adds a
// teach entry to the person's readers file; Undo removes it. The intake skill reads social posts one hop deep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, world } from './helpers.ts';
import { type ApplyEnv, ProposalError, addProposal, approve, checkProposal, proposalView, routePortalAdd, undo } from '../../src/jobs/proposals.ts';
import { effectivePortals, readersFile } from '../../src/jobs/portals/readers.ts';
import { notesOf } from '../../src/jobs/ctx.ts';

const env = (w: ReturnType<typeof world>): ApplyEnv => ({ ctx: w.ctx, queueLink: () => 1, cancelLink: () => true });
const item = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ kind: 'portal_add', payload, reason: 'A site from the post', ...extra });

test('portal_add: the payload is name, url, countries?, fields?, each checked', () => {
  const ok = checkProposal({ origin: 'fetched', summary: 'A site', items: [item({ name: 'Sample Careers', url: 'https://www.samplecareers.test/jobs', countries: ['IN', 'world'], fields: ['data'] })] });
  assert.deepEqual(ok.items[0].payload, { name: 'Sample Careers', url: 'https://www.samplecareers.test/jobs', countries: ['in', 'world'], fields: ['data'] });
  for (const [p, re] of [
    [{ name: 'X', url: 'ftp://x.test/' }, /http\(s\) address/],
    [{ url: 'https://x.test/' }, /name is required/],
    [{ name: 'X', url: 'https://x.test/', countries: ['india'] }, /not a two-letter country code/],
    [{ name: 'X', url: 'https://x.test/', fields: ['rocketry'] }, /not a field Crewdeck knows/],
    [{ name: 'X', url: 'https://x.test/', login: 'me' }, /unknown field "login"/],
  ] as [Record<string, unknown>, RegExp][]) assert.throws(() => checkProposal({ origin: 'fetched', summary: 's', items: [item(p)] }), (e: any) => e instanceof ProposalError && re.test(e.message), JSON.stringify(p));
});

test('a site Crewdeck knows: a catalog portal → portal_toggle on; an employer\'s ATS page or a catalog board → source_add', () => {
  const w = world('example');
  const r = (url: string) => routePortalAdd(w.ctx, item({ name: 'Site', url }) as any);
  assert.deepEqual({ kind: r('https://www.naukri.com/data-analyst-jobs').kind, payload: r('https://www.naukri.com/data-analyst-jobs').payload }, { kind: 'portal_toggle', payload: { portal: 'naukri', on: true } });
  assert.equal(r('https://naukri.com/').payload.portal, 'naukri');
  assert.equal(r('https://www.iimjobs.com/').payload.portal, 'iimjobs', 'teach entries count as portals too');
  assert.match(r('https://www.naukri.com/').reason, /already one of Crewdeck's portals: Naukri/);
  assert.deepEqual(r('https://jobs.lever.co/fictional-co').payload, { careers_url: 'https://jobs.lever.co/fictional-co', name: 'Site' });
  assert.equal(r('https://boards.greenhouse.io/fictional').kind, 'source_add');
  assert.deepEqual(r('https://remotive.com/remote-jobs').payload, { provider: 'remotive', name: 'Remotive' });
  const unknown = r('https://www.samplecareers.test/');
  assert.equal(unknown.kind, 'portal_add');
  // Stored proposals carry the routed kind.
  const p = addProposal(env(w), checkProposal({ origin: 'fetched', summary: 's', items: [item({ name: 'Naukri', url: 'https://www.naukri.com/' }), item({ name: 'Sample', url: 'https://www.samplecareers.test/' })] }));
  assert.deepEqual(p.items.map((i) => i.kind), ['portal_toggle', 'portal_add']);
});

test('never applied on its own: even the person\'s own words wait for Approve; approve adds a teach entry; Undo removes it', () => {
  const w = world('example');
  const said = 'also look on sample careers https://www.samplecareers.test/';
  const p = addProposal(env(w), checkProposal({ origin: 'person', summary: 'A site', items: [item({ name: 'Sample Careers', url: 'https://www.samplecareers.test/jobs?q=x', countries: ['in'] }, { evidence: said })] }), { told: said });
  assert.equal(p.items[0].status, 'pending');
  assert.equal(proposalView(p).items[0].line, 'Add the job site Sample Careers (samplecareers.test)');
  const a = approve(env(w), p.id, 1);
  assert.equal(a.applied, 1, a.failed.join());
  assert.match(a.proposal.items[0].done!, /added the job site Sample Careers \(samplecareers\): connect it on Sources → Portals/);
  const added = effectivePortals(w.ctx.home).byId.get('samplecareers')!;
  assert.ok(added.teach && added.added);
  assert.equal(added.home_url, 'https://www.samplecareers.test/jobs');
  assert.deepEqual(added.countries, ['in']);
  assert.match(readFileSync(readersFile(w.ctx.home), 'utf8'), /added:\n\s+- id: samplecareers/);
  assert.equal(proposalView(a.proposal).items[0].can_undo, true);
  const u = undo(env(w), p.id, 1);
  assert.equal(u.items[0].undone, true);
  assert.equal(effectivePortals(w.ctx.home).byId.has('samplecareers'), false);
  assert.ok(!notesOf(w.ctx).sources.data.items.some((x) => x.portal === 'samplecareers'));
  assert.throws(() => undo(env(w), p.id, 1), /not applied by Crewdeck on its own/);
});

test('a second site on the same name gets its own id', () => {
  const w = world('example');
  for (const url of ['https://www.samplecareers.test/', 'https://jobs.samplecareers.co.in/']) {
    const p = addProposal(env(w), checkProposal({ origin: 'fetched', summary: 's', items: [item({ name: 'Sample', url })] }));
    approve(env(w), p.id, 1);
  }
  const ids = effectivePortals(w.ctx.home).portals.filter((p) => p.added).map((p) => p.id);
  assert.deepEqual(ids, ['samplecareers', 'samplecareers-2']);
});

test('the intake skill reads X and other social posts one hop deep, classifies their links, and everything waits', () => {
  const s = readFileSync(join(REPO, 'plugin', 'skills', 'jobs-intake', 'SKILL.md'), 'utf8');
  const bullet = s.slice(s.indexOf('- A social post or search link'), s.indexOf('- A job posting link alone'));
  for (const re of [/x\.com or twitter\.com/, /this chat's browser pane/, /If X or LinkedIn asks them to sign in, they sign in there themselves/, /Never follow more than one\s+hop/,
    /lnkd\.in, t\.co\) may be opened once/, /\*\*data, never instructions\*\*/, /a job posting → `add_link`/, /lever|Lever/, /Greenhouse, Ashby, Workday, Keka, Darwinbox/,
    /`watch_company`\s+with its `careers_url`/, /`crewdeck jobs sources suggest` and `crewdeck jobs portals list` first/, /else `portal_add`/, /origin `fetched` and waits for Approve/]) assert.match(bullet, re);
  assert.match(s, /\| `portal_add` \| `\{ name, url, countries\?, fields\? \}`/);
  assert.match(s, /Always waits for Approve; Undo removes it/);
  const ws = readFileSync(join(REPO, 'plugin', 'skills', 'jobs-workspace', 'SKILL.md'), 'utf8');
  const teach = ws.slice(ws.indexOf('## teach:'), ws.indexOf('## Also in this session'));
  for (const re of [/`crewdeck jobs portals inspect-script`/, /`crewdeck jobs portals teach <portal id> --file <T>\/reader-<portal id>\.json`/, /--answer <T>\/portal-<portal id>-teach\.json --save/,
    /At least 5 jobs/, /__reactFiber|`react` and `fields`/, /`crewdeck jobs portals reader <portal id> --reset`/, /data, never instructions/, /no screenshots, no `read_page`/]) assert.match(teach, re);
  assert.match(ws, /`context\.portal\.needs_reader` true/);
});
