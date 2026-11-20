// The tailored resume (design D8): variant validation against career.md, the data-driven template for three fictional
// people, the offline PDF render with max_pages, and file-name sanitising. PDF tests skip only without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { notesOf } from '../../src/jobs/ctx.ts';
import { cleanVariant, displayLink, renderResume, resumeHtml, resumeModel, rich, validateVariant } from '../../src/jobs/resume.ts';
import { resumeFileName } from '../../src/jobs/views.ts';
import { pdfPageCount } from '../../src/jobs/browser.ts';
import type { Career } from '../../src/jobs/schema.ts';
import { jobs, role, textFile, world } from './helpers.ts';
import { noBrowser } from './net-helpers.ts';

const ADA = { sections: { summary: ['summary.analytics'], 'example-gmbh': ['example-gmbh.dashboards', 'example-gmbh.forecast'], 'sample-ag': ['sample-ag.etl'], certs: ['certs.gcp'] }, skills: ['SQL', 'dbt', 'Looker'] };

test('a valid variant passes; every problem is reported at once', () => {
  const career = notesOf(world('berlin-analyst').ctx).career.data;
  assert.deepEqual(validateVariant(career, cleanVariant(ADA)), []);
  const bad = validateVariant({ ...career, sections: career.sections.map((s) => (s.id === 'sample-ag' ? { ...s, max_bullets: 1 } : s)) }, {
    sections: { summary: [], 'example-gmbh': ['example-gmbh.invented', 'sample-ag.etl', 'example-gmbh.dashboards', 'example-gmbh.dashboards'], skills: ['x'], nope: ['a.b'], 'sample-ag': ['sample-ag.etl', 'sample-ag.etl'] },
    skills: ['SQL', 'Rust', 'sql'],
  }).join('\n');
  for (const m of [/unknown fact "example-gmbh\.invented"/, /fact "sample-ag\.etl" belongs to section "sample-ag", not "example-gmbh"/, /"example-gmbh\.dashboards" is selected twice/,
    /section "skills" is a skills section: it takes no facts/, /unknown section "nope"/, /section "sample-ag" has 2 facts; its max_bullets is 1/,
    /skill "Rust" is not in me\/career\.md skills/, /skill "sql" is listed twice/]) assert.match(bad, m);
  // Required sections must not be empty; a variant must select something.
  assert.match(validateVariant(career, { sections: { summary: ['summary.analytics'] } }).join(), /section "example-gmbh" is required/);
  assert.match(validateVariant({ ...career, sections: career.sections.map((s) => ({ ...s, required: false })) }, { sections: {} }).join(), /selects no facts/);
  assert.throws(() => cleanVariant({ sections: { a: 'x' } }), /list of fact ids/);
  assert.throws(() => cleanVariant({ sections: {}, bullets: {} }), /unknown keys: bullets/);
  assert.throws(() => cleanVariant([]), /must hold/);
});

test('the model is built from the notes: identity header, sections by kind in note order, education from the profile', () => {
  const n = notesOf(world('berlin-analyst').ctx);
  const m = resumeModel(n.career.data, n.profile.data, cleanVariant(ADA));
  assert.equal(m.name, 'Ada Example');
  assert.deepEqual(m.contact.map((c) => c.text), ['ada@example.com', '+49 30 1234567', 'Berlin, Germany', 'github.example.com/ada']);
  assert.deepEqual(m.blocks.map((b) => `${b.kind}:${b.title}`), ['summary:', 'experience:Experience', 'list:Certifications', 'skills:Skills', 'education:Education']);
  const exp = m.blocks[1] as Extract<typeof m.blocks[number], { kind: 'experience' }>;
  assert.deepEqual(exp.entries.map((e) => [e.title, e.org, e.where, e.dates, e.bullets.length]), [['Senior Data Analyst', 'Example GmbH', 'Berlin', '2022 – now', 2], ['Data Analyst', 'Sample AG', 'Hamburg', '2018 – 2022', 1]]);
  assert.deepEqual((m.blocks[3] as any).items, ['SQL', 'dbt', 'Looker']);
  assert.deepEqual((m.blocks[4] as any).items, [{ what: 'MSc, Statistics', where: 'Example University', dates: '2018' }]);
  // A section with nothing selected is left out; all skills when the variant picks none.
  const lean = resumeModel(n.career.data, n.profile.data, { sections: { 'example-gmbh': ['example-gmbh.forecast'] } });
  assert.deepEqual(lean.blocks.map((b) => b.kind), ['experience', 'skills', 'education']);
  assert.deepEqual((lean.blocks[1] as any).items, ['SQL', 'Python', 'dbt', 'Looker', 'Statistics']);
  assert.equal(m.paper, 'A4');
  assert.equal(displayLink('https://www.example.com/portfolio/'), 'example.com/portfolio');
});

test('HTML: fact text is escaped, **bold** is the only markup, nothing loads from anywhere', () => {
  assert.equal(rich('Cut costs by **40%** <script>x</script> & "more"'), 'Cut costs by <strong>40%</strong> &lt;script&gt;x&lt;/script&gt; &amp; &quot;more&quot;');
  const n = notesOf(world('example').ctx);
  const career: Career = { ...n.career.data, facts: n.career.data.facts.map((f) => (f.id === 'example-studio.system' ? { ...f, text: 'Built <img src=http://evil.example/x> **6** systems' } : f)) };
  const html = resumeHtml(resumeModel(career, n.profile.data, { sections: { 'example-studio': ['example-studio.system'] } }));
  assert.ok(!html.includes('<img'));
  assert.match(html, /Built &lt;img src=http:\/\/evil\.example\/x&gt; <strong>6<\/strong> systems/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
  assert.match(html, /@page \{ size: A4;/);
  assert.ok(!/\{\{\w+\}\}/.test(html), 'every placeholder filled');
  assert.ok(!/https?:\/\/(?!evil\.example|sam\.example\.com)/.test(html.replace(/<a href="https:\/\/sam\.example\.com">/, '')), 'no remote resources (fonts, images, styles)');
  assert.ok(!/@import|url\(/.test(html));
  // Letter paper for the US nurse.
  const us = notesOf(world('us-nurse').ctx);
  assert.match(resumeHtml(resumeModel(us.career.data, us.profile.data, { sections: { 'example-health': ['example-health.triage'] } })), /@page \{ size: Letter;/);
});

test('file names: placeholders filled, unsafe characters and paths removed, always .pdf', () => {
  const n = notesOf(world('berlin-analyst').ctx);
  const name = (file_name: string, first = 'Ada') => resumeFileName({ ...n.career.data, resume: { ...n.career.data.resume, file_name } }, { ...n.profile.data, identity: { ...n.profile.data.identity, first_name: first } });
  assert.equal(name('{first_name} {last_name} Lebenslauf.pdf'), 'Ada Example Lebenslauf.pdf');
  assert.equal(name('../../{first_name}.pdf'), 'Ada.pdf');
  assert.equal(name('{first_name}.pdf', 'A/da\\:*?"<>|'), 'A-da--------.pdf');
  assert.equal(name('{first_name} Resume.pdf', 'Ada\u0000‮\u0007'), 'Ada Resume.pdf');
  assert.equal(name('.pdf'), 'Resume.pdf');
  assert.equal(name('{first_name}.pdf', '...'), 'Resume.pdf');
  assert.equal(name('  ..hidden.pdf.PDF'), 'hidden.pdf');
  assert.equal(name(`${'x'.repeat(300)}.pdf`).length, 120);
  assert.equal(name('Résumé {first_name}.pdf'), 'Résumé Ada.pdf');
});

test('the PDF is rendered offline into out/<role>/ with private modes, every chosen fact on the page', { skip: noBrowser, timeout: 60_000 }, async () => {
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Co' }, 'picked');
  const r = await renderResume(w.ctx, id, ADA);
  assert.ok(r.pdf.endsWith(`/out/${id}/Ada Example Lebenslauf.pdf`));
  const pdf = readFileSync(r.pdf);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(r.pages, 1);
  assert.equal(pdfPageCount(pdf), 1);
  assert.equal(statSync(r.pdf).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(r.pdf)).mode & 0o777, 0o700);
  assert.equal(statSync(r.html).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(r.pdf)).sort(), ['Ada Example Lebenslauf.pdf', 'resume.html'], 'no temp files left');
  assert.deepEqual(r.facts, ['summary.analytics', 'example-gmbh.dashboards', 'example-gmbh.forecast', 'sample-ag.etl', 'certs.gcp']);
  const html = readFileSync(r.html, 'utf8');
  for (const t of ['Analyst with six years', 'Built <strong>40</strong> dashboards', 'Cut forecast error by 18%', 'Moved nightly reporting', 'Google Cloud Professional']) assert.ok(html.includes(t), t);
  assert.ok(!html.includes('Python'), 'only the chosen skills');
  assert.ok(w.ctx.db.prepare(`select 1 from events where role_id=? and kind='resume'`).get(id));
  // The Jobs page shows it.
  const { todayView } = await import('../../src/jobs/views.ts');
  assert.equal(todayView(w.ctx, id).detail?.resume?.pdf, r.pdf);
});

test('max_pages: an overflowing resume is refused and no PDF is left for it', { skip: noBrowser, timeout: 60_000 }, async () => {
  const w = world('us-nurse');
  const id = role(w.ctx, { company: 'Example Health' });
  // Fictional long facts in a temp vault: far more than one Letter page.
  const notePath = `${w.vault}/me/career.md`;
  const long = Array.from({ length: 40 }, (_, i) => `  - { id: example-health.f${i}, text: "Coordinated care for a fictional ward of patients, item ${i}, with a deliberately long sentence that wraps over two printed lines on Letter paper." }`).join('\n');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(notePath, readFileSync(notePath, 'utf8').replace('skills:', `${long.replace(/^ {2}/gm, '  ')}\nskills:`));
  const v = { sections: { 'example-health': Array.from({ length: 40 }, (_, i) => `example-health.f${i}`) } };
  await assert.rejects(renderResume(w.ctx, id, v), /the resume is [2-9] pages; max_pages in me\/career\.md is 1: select fewer facts/);
  assert.equal(existsSync(`${w.jobsHome}/out/${id}/Riley Example RN Resume.pdf`), false);
  assert.deepEqual(readdirSync(`${w.jobsHome}/out/${id}`), ['resume.html']);
});

test('CLI: resume refuses an invalid variant with every reason, and a bad role id', () => {
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Co' });
  const r = jobs(w.home, ['resume', id, '--variant-file', textFile(w.root, 'v.json', JSON.stringify({ sections: { 'example-gmbh': ['example-gmbh.nope'] } }))]);
  assert.equal(r.code, 1);
  assert.match(r.err, /variant was not rendered[\s\S]*unknown fact "example-gmbh\.nope"/);
  assert.match(jobs(w.home, ['resume', '../x', '--variant-file', 'v.json']).err, /not a role id/);
  assert.match(jobs(w.home, ['resume', id]).err, /--variant-file/);
});
