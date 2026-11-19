import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJobNotes } from '../../src/jobs/notes.ts';
import { didYouMean, normalise, validate } from '../../src/jobs/schema.ts';
import { PEOPLE } from './helpers.ts';

const errors = (name: string, data: unknown) => validate(name, data).filter((i) => i.level === 'error');
const warnings = (name: string, data: unknown) => validate(name, data).filter((i) => i.level === 'warning');

test('every fictional person, the example and the templates validate with no errors', () => {
  for (const [who, dir] of Object.entries(PEOPLE)) {
    const n = loadJobNotes(dir, null);
    assert.deepEqual(n.issues.filter((i) => i.level === 'error'), [], who);
    if (who !== 'template') assert.deepEqual(n.issues, [], `${who}: no warnings either`);
  }
});

test('messages name the note, the field path and the fix', () => {
  const [e] = errors('search', { pay: { currency: 'EUR', floor: 50000, period: 'annual' } });
  assert.deepEqual({ note: e.note, path: e.path }, { note: 'jobs/search.md', path: 'pay.period' });
  assert.match(e.message, /"annual" is not one of: year, month, hour/);
  assert.match(e.fix!, /use one of year \| month \| hour|did you mean/);
  const [lang] = errors('search', { languages: [{ name: 'German', level: 'fluant' }] });
  assert.equal(lang.path, 'languages[0].level');
  assert.match(lang.fix!, /did you mean "fluent"/);
  const [phone] = errors('profile', { identity: { phone: 'call me' } });
  assert.equal(phone.note, 'me/profile.md');
  assert.equal(phone.path, 'identity.phone');
  assert.ok(errors('profile', { identity: { email: 'nope' } }).some((i) => i.path === 'identity.email'));
  assert.ok(errors('search', { pay: { floor: 100 } }).some((i) => i.path === 'pay.currency' && /floor needs a currency/.test(i.message)));
  assert.ok(errors('search', { schedule: { timezone: 'Mars/Olympus' } }).some((i) => i.path === 'schedule.timezone'));
  assert.ok(errors('search', { pay: { currency: 'euro' } }).some((i) => i.path === 'pay.currency'));
  assert.ok(errors('search', { schedule: { daily_picks: 2.5 } }).some((i) => /whole number/.test(i.message)));
});

test('unknown keys are warnings with "did you mean"; SilverBullet keys are ignored', () => {
  const data = { tags: 'jobs', aliases: ['x'], displayName: 'Search', pay: { currency: 'EUR', flor: 1 }, workplce: ['remote'], my_own_key: 1 };
  assert.deepEqual(errors('search', data), []);
  const w = warnings('search', data);
  assert.match(w.find((i) => i.path === 'pay.flor')!.fix!, /did you mean "floor"/);
  assert.match(w.find((i) => i.path === 'workplce')!.fix!, /did you mean "workplace"/);
  assert.ok(w.some((i) => i.path === 'my_own_key'));
  assert.ok(!w.some((i) => ['tags', 'aliases', 'displayName'].includes(i.path)));
  assert.equal(didYouMean('greenhous', ['lever', 'greenhouse', 'ashby']), 'greenhouse');
  assert.equal(didYouMean('zzzz', ['lever', 'greenhouse']), null);
});

test('career: fact ids must start with a summary, experience or list section; ids unique; experience needs title and org', () => {
  const sections = [{ id: 'summary', kind: 'summary' }, { id: 'acme', kind: 'experience', title: 'Analyst', org: 'Acme' }, { id: 'skills', kind: 'skills' }];
  assert.deepEqual(errors('career', { sections, facts: [{ id: 'acme.one', text: 'x' }] }), []);
  const e = errors('career', { sections, facts: [{ id: 'skills.sql', text: 'x' }, { id: 'nope.x', text: 'y' }, { id: 'acme.one', text: 'a' }, { id: 'acme.one', text: 'b' }] });
  assert.ok(e.some((i) => i.path === 'facts[0].id' && /start the id with one of: summary, acme/.test(i.fix!)));
  assert.ok(e.some((i) => i.path === 'facts[1].id'));
  assert.ok(e.some((i) => i.path === 'facts[3].id' && /twice/.test(i.message)));
  assert.ok(errors('career', { sections: [{ id: 'x', kind: 'experience' }] }).some((i) => i.path === 'sections[0].title'));
  assert.ok(errors('career', { sections: [{ id: 'x', kind: 'summary' }, { id: 'x', kind: 'skills' }] }).some((i) => /twice/.test(i.message)));
  assert.ok(errors('career', { resume: { file_name: '../resume.pdf' } }).some((i) => i.path === 'resume.file_name'));
  assert.ok(errors('career', { resume: { file_name: '{name}.pdf' } }).some((i) => /placeholder/.test(i.message)));
});

test('memory: answers need keys, company scope needs a company, superseded_by must point at an item', () => {
  const base = { text: 't', quote: 'q', scope: 'all', created: '2026-11-18' };
  const e = errors('memory', { items: [
    { id: 'm-1', kind: 'answer', ...base },
    { id: 'm-2', kind: 'fact', ...base, scope: 'company' },
    { id: 'm-3', kind: 'company_rule', ...base },
    { id: 'm-4', kind: 'fact', ...base, superseded_by: 'm-9' },
    { id: 'm-4', kind: 'fact', ...base },
    { id: 'm-6', kind: 'opinion', ...base },
  ] });
  for (const p of ['items[0].key', 'items[1].company', 'items[2].scope', 'items[3].superseded_by', 'items[4].id', 'items[5].kind']) assert.ok(e.some((i) => i.path === p), p);
});

test('sources: parser entries and unknown providers are refused', () => {
  const e = errors('sources', { boards: [{ name: 'A', parser: 'x', careers_url: 'https://jobs.example.com' }, { name: 'B', provider: 'greenhous' }, { name: 'C' }, { name: 'D', provider: 'local-parser' }] });
  assert.ok(e.some((i) => i.path === 'boards[0].parser'));
  assert.ok(e.some((i) => i.path === 'boards[1].provider' && /did you mean "greenhouse"/.test(i.fix!)));
  assert.ok(e.some((i) => i.path === 'boards[2]' && /needs a provider, a careers_url or a url/.test(i.message)));
  assert.ok(e.some((i) => i.path === 'boards[3].provider'));
  assert.deepEqual(errors('sources', { watchlist: [{ name: 'E', careers_url: 'https://jobs.example.com/e', any_option: 3 }] }), []);
});

test('rules overrides: names checked, regexes compiled, place rules need a places group', () => {
  assert.deepEqual(errors('search', { rules: { title_gate: '\\bdesigner\\b' } }), []);
  assert.ok(errors('search', { rules: { title_gat: 'x' } }).some((i) => /did you mean "title_gate"/.test(i.fix!)));
  assert.ok(errors('search', { rules: { industry: '(unclosed' } }).some((i) => /not a valid regular expression/.test(i.message)));
  assert.ok(errors('search', { rules: { other_only: '\\bonly\\b' } }).some((i) => /places/.test(i.message)));
});

test('places outside the gazetteer warn; "Town, Country" is fine', () => {
  const w = warnings('search', { workplace: ['onsite'], places: { onsite: ['Springfield', 'Potsdam, Germany', 'Smalltown, Texas'] } });
  assert.deepEqual(w.filter((i) => i.path.startsWith('places')).map((i) => i.path), ['places.onsite[0]']);
});

test('normalise fills defaults', () => {
  const s = normalise.search({});
  assert.equal(s.places.commute_km, 50);
  assert.equal(s.exclude.travel, 'none');
  assert.equal(s.pay, null);
  assert.equal(normalise.career({}).resume.paper, 'A4');
});
