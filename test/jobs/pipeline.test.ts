import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { splitNote } from '../../src/jobs/notes.ts';
import { setField } from '../../src/jobs/edit.ts';
import { addEvent, getRole } from '../../src/jobs/db.ts';
import { refilter, runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { candidates, judge, pick, pickPasted } from '../../src/jobs/pipeline/pick.ts';
import { markApplied, notInterested } from '../../src/jobs/pipeline/apply.ts';
import { addRole, setApplyUrl, setRoleStatus } from '../../src/jobs/pipeline/roles.ts';
import { addContact, addMessage, checkMessage, followups, markSent } from '../../src/jobs/pipeline/outreach.ts';
import { appliedToday } from '../../src/jobs/views.ts';
import { role, textFile, world } from './helpers.ts';

const status = (w: any, id: string) => getRole(w.ctx.db, id).status as string;
const reason = (w: any, id: string) => getRole(w.ctx.db, id).status_reason as string;
const front = (file: string) => parse(splitNote(readFileSync(file, 'utf8')).front!);

test('prefilter: the notes\' rules, then company cooldown and one active pick per company; pay recorded in the user\'s currency', () => {
  const w = world('berlin-analyst');
  const ok = role(w.ctx, { company: 'Example Labs', pay_text: '€60,000 – €70,000 per year' });
  const sales = role(w.ctx, { company: 'Example Two', title: 'Sales Data Analyst' });
  const eng = role(w.ctx, { company: 'Example Three', title: 'Software Engineer' });
  const munich = role(w.ctx, { company: 'Example Four', location: 'Munich, Germany' });
  const cheap = role(w.ctx, { company: 'Example Five', pay_text: '€30,000 – €40,000 a year' });
  const cool = role(w.ctx, { company: 'Cool Down GmbH' });
  w.ctx.db.prepare(`update companies set cooldown_until='2027-01-01T00:00:00.000Z' where name='Cool Down GmbH'`).run();
  role(w.ctx, { company: 'Busy Co', title: 'BI Analyst' }, 'picked');
  const busy = role(w.ctx, { company: 'Busy Co' });
  const r = runPrefilter(w.ctx);
  assert.equal(r.kept, 2, 'the analyst role and the engineering one (titles are a score, never a drop: ADR-0003)');
  assert.equal(status(w, ok), 'new');
  assert.equal(status(w, eng), 'new');
  const rule = (id: string) => reason(w, id).split(':')[0];
  assert.deepEqual([sales, munich, cheap, cool, busy].map(rule), ['title_exclude', 'location_elsewhere', 'pay', 'cooldown', 'active_pick']);
  const pay = getRole(w.ctx.db, ok);
  assert.deepEqual([pay.pay_min, pay.pay_max, pay.pay_currency, pay.pay_period, pay.pay_status], [60000, 70000, 'EUR', 'year', 'ok']);
  assert.equal(runPrefilter(w.ctx).kept, 2, 'running again changes nothing');
});

test('refilter: after a preference change, roles dropped in the last N days come back; older drops stay', () => {
  const w = world('berlin-analyst', { now: '2026-11-01T10:00:00Z' });
  const old = role(w.ctx, { company: 'Old Remote Co', location: 'Remote' });
  runPrefilter(w.ctx);
  w.at('2026-11-15T10:00:00Z');
  const fresh = role(w.ctx, { company: 'Remote Labs', location: 'Remote' });
  runPrefilter(w.ctx);
  assert.match(reason(w, fresh), /^workplace_excluded/);
  w.at('2026-11-19T10:00:00Z');
  assert.equal(refilter(w.ctx, 14).restored, 0, 'nothing changed yet');
  const because = textFile(w.root, 'because.txt', 'Remote is fine now, within Germany.');
  setField(join(w.vault, 'jobs', 'search.md'), 'search', ['workplace'], 'onsite,hybrid,remote', { because: readFileSync(because, 'utf8'), today: '2026-11-19' });
  setField(join(w.vault, 'jobs', 'search.md'), 'search', ['places', 'remote_from'], 'Germany', { because: 'same', today: '2026-11-19' });
  const r = refilter(w.ctx, 14);
  assert.deepEqual(r.roles.map((x) => x.id), [fresh]);
  assert.equal(status(w, fresh), 'new');
  assert.equal(status(w, old), 'prefiltered_out');
  assert.throws(() => refilter(w.ctx, 0), /--days/);
});

test('candidates: ranked from the notes, plain clipped descriptions, judged roles left out, at most 40', () => {
  const w = world('berlin-analyst');
  const plain = role(w.ctx, { company: 'P Co', title: 'Data Analyst', description: 'x'.repeat(5000) });
  const senior = role(w.ctx, { company: 'Q Co', title: 'Senior Data Analyst', description: '<p>We use <b>SQL</b>&nbsp;&amp; dbt</p>' });
  const c = candidates(w.ctx, 40);
  assert.deepEqual(c.map((x) => x.id), [senior, plain]);
  assert.equal(c[0].description, 'We use SQL & dbt');
  assert.ok(c[1].description.length <= 4000);
  judge(w.ctx, [{ role: senior, eligible: 'no', evidence: 'German C1 required', score: 0 }]);
  assert.deepEqual(candidates(w.ctx, 40).map((x) => x.id), [plain]);
  assert.equal(status(w, senior), 'judged_out');
  assert.throws(() => candidates(w.ctx, 41), /at most 40/);
});

function pickWorld(person: 'berlin-analyst' | 'us-nurse' = 'berlin-analyst', now?: string) {
  const w = world(person, { now });
  const rows: [string, 'yes' | 'no' | 'unclear', number][] = [['A', 'yes', 90], ['A', 'yes', 85], ['B', 'yes', 80], ['C', 'yes', 70], ['D', 'yes', 60], ['E', 'yes', 50], ['F', 'yes', 40], ['G', 'unclear', 99], ['H', 'no', 95]];
  const ids = rows.map(([co, eligible, score]) => { const id = role(w.ctx, { company: `Company ${co}` }); judge(w.ctx, [{ role: id, eligible, score, evidence: 'Berlin' }]); return id; });
  const company = (id: string) => getRole(w.ctx.db, id).company.replace('Company ', '');
  return { ...w, ids, company };
}

test('pick: best score first, one per company, idempotent per day; unclear and no never picked; the rest benched', () => {
  const w = pickWorld();
  const first = pick(w.ctx, 5);
  assert.deepEqual(first.map(w.company), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(first[0], w.ids[0]);
  assert.deepEqual(pick(w.ctx, 5), first);
  assert.equal(getRole(w.ctx.db, first[0]).picked_on, '2026-11-19');
  const bench = (w.ctx.db.prepare(`select r.id from roles r where status='bench'`).all() as any[]).map((r) => w.company(r.id)).sort();
  assert.deepEqual(bench, ['A', 'F', 'G']);
  assert.equal(status(w, w.ids[8]), 'judged_out');
});

test('pick across a UTC midnight: a new local day in Berlin, still the same day in Chicago', () => {
  const b = pickWorld('berlin-analyst', '2026-11-19T22:50:00Z'); // 23:50 in Berlin
  const before = pick(b.ctx, 2);
  b.at('2026-11-19T23:10:00Z'); // 00:10 the next day in Berlin
  const after = pick(b.ctx, 2);
  assert.notDeepEqual(after, before);
  assert.deepEqual(after.map((id) => getRole(b.ctx.db, id).picked_on), ['2026-11-20', '2026-11-20']);
  const c = pickWorld('us-nurse', '2026-11-19T22:50:00Z'); // 16:50 in Chicago
  const one = pick(c.ctx, 2);
  c.at('2026-11-19T23:10:00Z');
  assert.deepEqual(pick(c.ctx, 2), one);
  assert.equal(getRole(c.ctx.db, one[0]).picked_on, '2026-11-19');
});

test('pick skips judged roles whose title the user has since excluded', () => {
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Labs', title: 'Data Analyst, Marketing Agency' });
  judge(w.ctx, [{ role: id, eligible: 'yes', score: 90, evidence: '' }]);
  setField(join(w.vault, 'jobs', 'search.md'), 'search', ['roles', 'exclude_title_words'], 'intern,agency', { because: 'no agencies', today: '2026-11-19' });
  assert.deepEqual(pick(w.ctx, 3), []);
  assert.equal(status(w, id), 'skipped');
});

test('a role the user chose: picked today, or warnings (cooldown, company busy, already applied) unless forced', () => {
  const w = world('berlin-analyst');
  const a = role(w.ctx, { company: 'Example Labs' });
  assert.deepEqual(pickPasted(w.ctx, a), []);
  assert.deepEqual([status(w, a), getRole(w.ctx.db, a).eligibility, getRole(w.ctx.db, a).picked_on], ['picked', 'yes', '2026-11-19']);
  const b = role(w.ctx, { company: 'Example Labs', title: 'BI Analyst' });
  assert.match(pickPasted(w.ctx, b).join(), /already has "Senior Data Analyst" in progress/);
  markApplied(w.ctx, a);
  const warn = pickPasted(w.ctx, b);
  assert.match(warn.join(), /cooldown until 2027-01-18/);
  assert.equal(status(w, b), 'new');
  assert.deepEqual(pickPasted(w.ctx, b, undefined, true), []);
  assert.match(reason(w, b), /despite: .*cooldown/);
  assert.match(pickPasted(w.ctx, a).join(), /already applied/);
});

test('applied: status, cooldown max(existing, now + cooldown_days), one journal line, open requests left to the server', () => {
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Labs' }, 'prepared');
  w.ctx.db.prepare(`update companies set cooldown_until='2027-06-01T00:00:00.000Z' where name='Example Labs'`).run();
  const r = markApplied(w.ctx, id);
  assert.equal(status(w, id), 'applied');
  assert.equal(r.cooldown_until, '2027-06-01T00:00:00.000Z', 'a longer cooldown stays');
  const other = role(w.ctx, { company: 'Sample Retail' }, 'prepared');
  assert.equal(markApplied(w.ctx, other).cooldown_until, '2027-01-18T10:00:00.000Z', '60 days from now');
  const journal = join(w.vault, 'journal', '2026-11-19.md');
  markApplied(w.ctx, id);
  assert.equal(readFileSync(journal, 'utf8'), '# 2026-11-19\n\n- Applied: Example Labs — Senior Data Analyst\n- Applied: Sample Retail — Senior Data Analyst\n');
  assert.throws(() => setRoleStatus(w.ctx, other, 'applied'), /crewdeck jobs applied/);
});

test('"applied today" is the user\'s local day, across a UTC midnight, for two time zones', () => {
  for (const [person, expectToday] of [['berlin-analyst', false], ['us-nurse', true]] as const) {
    const w = world(person, { now: '2026-11-19T22:30:00Z' }); // Berlin 23:30, Chicago 16:30
    const id = role(w.ctx, { company: 'Example Labs' }, 'prepared');
    markApplied(w.ctx, id);
    assert.ok(appliedToday(w.ctx).has(id));
    w.at('2026-11-19T23:30:00Z'); // Berlin 00:30 on the 20th, Chicago 17:30 on the 19th
    assert.equal(appliedToday(w.ctx).has(id), expectToday, person);
    assert.ok(existsSync(join(w.vault, 'journal', '2026-11-19.md')), 'the journal day is the local day it was applied');
  }
});

test('not interested: skipped, the reason remembered in the user\'s words, title words excluded in search.md and dropped later', () => {
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Labs', title: 'Data Analyst (Werbung)' });
  const r = notInterested(w.ctx, { role: id, reason: 'No advertising-tech roles for me', titleWords: ['Werbung', 'adtech'] });
  assert.equal(status(w, id), 'skipped');
  const mem = front(join(w.vault, 'jobs', 'memory.md')).items.find((m: any) => m.id === r.remembered);
  assert.deepEqual([mem.kind, mem.text, mem.quote, mem.scope], ['avoid', 'No advertising-tech roles for me', 'No advertising-tech roles for me', 'all']);
  const search = join(w.vault, 'jobs', 'search.md');
  assert.deepEqual(front(search).roles.exclude_title_words, ['intern', 'Praktikum', 'Werkstudent', 'sales', 'Werbung', 'adtech']);
  assert.match(readFileSync(search, 'utf8'), /- 2026-11-19: roles\.exclude_title_words: .* → .*Werbung, adtech\. "No advertising-tech roles for me"/);
  const later = role(w.ctx, { company: 'Sample Ads', title: 'Adtech Data Analyst' });
  runPrefilter(w.ctx);
  assert.match(reason(w, later), /^title_exclude/);
  const applied = role(w.ctx, { company: 'Done Co' }, 'applied');
  assert.throws(() => notInterested(w.ctx, { role: applied, reason: 'x' }), /already applied/);
  assert.throws(() => notInterested(w.ctx, { role: later, reason: 'x', titleWords: ['a,b'] }), /not a title word/);
});

test('add-role: http(s) only, no credentials, never X, LinkedIn only as a job posting and only when switched on', () => {
  const w = world('berlin-analyst');
  const base = { title: 'Data Analyst', company: 'Example Labs' };
  assert.equal(addRole(w.ctx, { ...base, url: 'https://jobs.example.com/1#apply' }).isNew, true);
  assert.equal(addRole(w.ctx, { ...base, url: 'https://jobs.example.com/1' }).isNew, false, 'the fragment is dropped');
  for (const [url, why] of [['ftp://jobs.example.com/1', /http/], ['https://user:pw@example.com/1', /user name or password/], ['https://x.com/someone/status/1', /X links/],
    ['https://twitter.com/jobs', /X links/], ['https://www.linkedin.com/in/someone', /job postings/], ['https://www.linkedin.com/jobs/view/123', /switch them on/], ['not a url', /not a web address/]] as const) {
    assert.throws(() => addRole(w.ctx, { ...base, url }), why, url);
  }
  assert.throws(() => addRole(w.ctx, { ...base, title: ' ', url: 'https://jobs.example.com/2' }), /required/);
  const on = world('berlin-analyst', { features: { linkedin_links: true } });
  const li = addRole(on.ctx, { ...base, url: 'https://www.linkedin.com/jobs/view/123/?trk=x' });
  assert.equal(getRole(on.ctx.db, li.id).url, 'https://www.linkedin.com/jobs/view/123/');
  assert.equal(setApplyUrl(w.ctx, addRole(w.ctx, { ...base, url: 'https://jobs.example.com/3' }).id, 'https://apply.example.com/3'), 'https://apply.example.com/3');
});

test('outreach: off until switched on; verified email, one per role, a daily cap in the user\'s day; LinkedIn text gated', () => {
  const off = world('berlin-analyst');
  const r0 = role(off.ctx, { company: 'Example Labs' });
  const c0 = addContact(off.ctx, { company: 'Example Labs', name: 'Pat Example', email: 'pat@example.com', email_verified: true });
  assert.throws(() => checkMessage(off.ctx, { role_id: r0, contact_id: c0, channel: 'email' }), /email drafts are off/);
  assert.throws(() => checkMessage(off.ctx, { role_id: r0, contact_id: c0, channel: 'linkedin' }), /LinkedIn message text is off/);

  const w = world('berlin-analyst', { features: { email_drafts: true, max_emails_per_day: 2, linkedin_message_text: true }, now: '2026-11-19T21:00:00Z' });
  const roles = [0, 1, 2, 3].map((i) => role(w.ctx, { company: `Co ${i}` }));
  const contact = (i: number, verified = true) => addContact(w.ctx, { company: `Co ${i}`, name: 'Pat Example', email: `pat${i}@example.com`, email_verified: verified });
  assert.throws(() => addMessage(w.ctx, { role_id: roles[0], contact_id: contact(0, false), channel: 'email', body: 'hi' }), /not verified/);
  const c0b = contact(0);
  addMessage(w.ctx, { role_id: roles[0], contact_id: c0b, channel: 'email', body: 'Subject: Hello\nhi' });
  assert.throws(() => addMessage(w.ctx, { role_id: roles[0], contact_id: c0b, channel: 'email', body: 'again' }), /already exists/);
  addMessage(w.ctx, { role_id: roles[1], contact_id: contact(1), channel: 'email', body: 'hi' });
  assert.throws(() => addMessage(w.ctx, { role_id: roles[2], contact_id: contact(2), channel: 'email', body: 'hi' }), /2 email drafts per day/);
  w.at('2026-11-19T23:30:00Z'); // a new day in Berlin
  assert.doesNotThrow(() => addMessage(w.ctx, { role_id: roles[2], contact_id: contact(2), channel: 'email', body: 'hi' }));
  addMessage(w.ctx, { role_id: roles[3], contact_id: contact(3), channel: 'linkedin', body: 'hi' });
  assert.throws(() => addContact(w.ctx, { company: 'Co 9', name: 'X', linkedin_url: 'https://x.com/x' }), /profile address/);
});

test('follow-ups: day 3-4 nudge and day 10-12 final, counted in local days, skipping replied roles', () => {
  const w = world('berlin-analyst', { features: { email_drafts: true, max_emails_per_day: 10 } });
  const ids = [0, 1, 2].map((i) => {
    const r = role(w.ctx, { company: `Co ${i}` });
    return { r, m: addMessage(w.ctx, { role_id: r, contact_id: addContact(w.ctx, { company: `Co ${i}`, name: 'X', email: `x${i}@example.com`, email_verified: true }), channel: 'email', body: 'hi' }) };
  });
  markSent(w.ctx, ids[0].m, '2026-11-15T23:30:00Z'); // 16 Nov in Berlin: 4 days before the 20th
  markSent(w.ctx, ids[1].m, '2026-11-10T10:00:00Z'); // 10 days
  markSent(w.ctx, ids[2].m, '2026-11-16T10:00:00Z');
  addEvent(w.ctx.db, ids[2].r, 'reply', 'interested');
  assert.deepEqual(followups(w.ctx, '2026-11-20').map((d) => [d.message_id, d.step, d.days]), [[ids[0].m, 'nudge', 4], [ids[1].m, 'final', 10]]);
});

test('C2: status by hand never reaches picked or prepared from outside the pipeline; allowed moves are listed', () => {
  const w = world('berlin-analyst');
  const fresh = role(w.ctx, { company: 'Example Labs' });
  assert.throws(() => setRoleStatus(w.ctx, fresh, 'picked'), /picked is set by crewdeck jobs pick/);
  assert.throws(() => setRoleStatus(w.ctx, fresh, 'prepared'), /from new to prepared is not allowed/);
  const out = role(w.ctx, { company: 'Sample Retail' }, 'prefiltered_out');
  assert.throws(() => setRoleStatus(w.ctx, out, 'new'), /from prefiltered_out to new is not allowed.*refilter/);
  const done = role(w.ctx, { company: 'Sample AG' }, 'applied');
  assert.throws(() => setRoleStatus(w.ctx, done, 'skipped'), /from applied to skipped is not allowed/);
  // The pipeline's own moves.
  const picked = role(w.ctx, { company: 'Example Co' }, 'picked');
  setRoleStatus(w.ctx, picked, 'prepared');
  assert.equal(status(w, picked), 'prepared');
  setRoleStatus(w.ctx, picked, 'expired', 'the posting is closed');
  assert.equal(status(w, picked), 'expired');
  setRoleStatus(w.ctx, fresh, 'skipped');
  setRoleStatus(w.ctx, fresh, 'new');
  assert.equal(status(w, fresh), 'new');
});
