// Does hybrid ranking order a pool better than the title-only (cheap) score? A small hand-made, fictional pool where
// titles mislead: a backend/platform/AI engineer's best roles are "Member of Technical Staff, Infra" and
// "Software Engineer, Foundations" while "Senior Software Engineer (Android)" shares more title words with his targets.
// Three rankers over the same roles, measured against hand labels: the title-only score (what Find used before), the
// hybrid with keywords (FTS5/BM25 over the profile's terms), and the hybrid with meaning (a fake embedder whose concept
// dimensions stand in for a real sentence model: it shows the fusion works, not how good bge-small is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesOf } from '../../src/jobs/ctx.ts';
import { rankRoles } from '../../src/jobs/pipeline/rank.ts';
import { embedMissing, ensureProfileVector } from '../../src/jobs/search/embed.ts';
import { engineerWorld, fakeEmbedder, role } from './search-helpers.ts';

type Fx = { title: string; company: string; description: string; rel: 0 | 1 | 2 };
// rel: 2 = a role he should read first, 1 = decent, 0 = not for him. "Member of Technical Staff, Infra" has no title word the matcher
// knows, so it is another occupation (ranked last, never judged: ADR-0003; "Senior Engineer, Core Services" is the same); hybrid
// ranking does not change that (rules never change), and those two are left out of the metrics. Labels were written before the
// numbers were seen: 2 = an engineering role on backend, platform, infra or AI work, whatever its title; 1 = next door (ML).
export const POOL: Fx[] = [
  { title: 'Member of Technical Staff, Infra', company: 'Quillon Labs', rel: 2, description: 'Own our Kubernetes clusters and GPU fleet. Distributed systems in Go and Python; reliability of inference serving for large models.' },
  { title: 'Software Engineer, Foundations', company: 'Brightwave', rel: 2, description: 'Build the inference platform: Go services, Kubernetes, model serving for LLM workloads and distributed systems.' },
  { title: 'Staff Engineer, Reliability', company: 'Tessera Cloud', rel: 2, description: 'Distributed systems reliability across Kubernetes clusters in Go. On-call for our model serving stack.' },
  { title: 'Senior Engineer, Core Services', company: 'Harbor Pay', rel: 2, description: 'Backend APIs in Go and Python, Kubernetes deployments and distributed queues behind our payments platform.' },
  { title: 'Senior Software Engineer (Android)', company: 'Pocketly', rel: 0, description: 'Build our Android app in Kotlin with Jetpack Compose. Work closely with design and the iOS team.' },
  { title: 'Senior Software Engineer, iOS', company: 'Pocketly Two', rel: 0, description: 'Build our iOS app in Swift. Mobile performance, accessibility and release trains.' },
  { title: 'Senior Software Engineer, Frontend', company: 'Pixelforge', rel: 0, description: 'React, TypeScript and CSS for our browser UI. Design system, accessibility.' },
  { title: 'Senior Software Engineer (Salesforce)', company: 'Dealroom Co', rel: 0, description: 'Customise our Salesforce CRM with Apex; work with the sales operations team on quota and accounts reports.' },
  { title: 'Software Engineer, Growth', company: 'Sproutly', rel: 0, description: 'Run A/B experiments, React dashboards for the growth team and some Python scripts.' },
  { title: 'Senior Software Engineer, Design Systems', company: 'Figgle', rel: 0, description: 'Own our Figma-to-React component library and the UI kit used by every team.' },
  { title: 'Software Engineer, Systems', company: 'Northgate', rel: 2, description: 'Work on our control plane: Go, Kubernetes operators and distributed systems at scale.' },
  { title: 'Staff Software Engineer, Compute', company: 'Ardent Cloud', rel: 2, description: 'Schedule GPU clusters for inference and training workloads; Go, Kubernetes, distributed systems.' },
  { title: 'Senior Software Engineer, QA Automation', company: 'Testwell', rel: 0, description: 'Write Selenium suites and Python scripts that drive our release checks.' },
  { title: 'Senior Software Engineer, Embedded', company: 'Chipset Works', rel: 0, description: 'Firmware in C for our sensors; RTOS, drivers and board bring-up.' },
  // vocabulary the profile never uses: the keywords miss it, a model that knows k8s = Kubernetes and vLLM = serving does not
  { title: 'Software Engineer, Runtime', company: 'Vantage Compute', rel: 2, description: 'Run vLLM replicas on k8s, tune GPU scheduling and keep model serving fast. Rust and Go.' },
  { title: 'Senior Software Engineer, Fleet', company: 'Kiln Systems', rel: 2, description: 'Operate infrastructure for thousands of nodes, k8s upgrades, reliability tooling in Go.' },
  // surface overlap, wrong job: "platform", "services" and a skill word, but mobile or front-end work
  { title: 'Senior Software Engineer, Mobile Platform', company: 'Orbit Apps', rel: 0, description: 'Our mobile platform team ships the Android and iOS SDK services; Kotlin, Swift and a little Go tooling.' },
  { title: 'Senior Software Engineer, Web Platform', company: 'Canvas Studio', rel: 0, description: 'Web platform services for the browser UI: React, TypeScript, CSS and a Python build script.' },
  { title: 'Software Engineer II', company: 'Municipal Works', rel: 0, description: 'Maintain internal admin tools and forms. Some Python.' },
  { title: 'Engineering Manager, Mobile', company: 'Pocketly Three', rel: 0, description: 'Managing the Android and iOS teams: hiring, people growth and planning.' },
  { title: 'Backend Engineer', company: 'Lumen Retail', rel: 2, description: 'Go services and APIs for our storefront. Some Kubernetes exposure.' },
  { title: 'Machine Learning Engineer', company: 'Corvid AI', rel: 1, description: 'Train and serve models; Python, inference latency, GPU clusters.' },
  { title: 'Account Executive', company: 'Dealroom Two', rel: 0, description: 'Own a quota selling our platform to enterprise accounts.' },
  { title: 'Product Designer', company: 'Figgle Two', rel: 0, description: 'Brand, UX and Figma prototypes for our consumer app.' },
  { title: 'Customer Success Manager', company: 'Sproutly Two', rel: 0, description: 'Managing customer accounts and renewals.' },
];

const metrics = (order: string[], rel: Map<string, number>) => {
  order = order.filter((id) => rel.has(id));
  const gains = order.map((id) => (rel.get(id) === 2 ? 3 : rel.get(id) === 1 ? 1 : 0));
  const dcg = (g: number[]) => g.slice(0, 8).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  const ideal = [...gains].sort((a, b) => b - a);
  const top = order.filter((id) => rel.get(id) === 2).map((id) => order.indexOf(id) + 1);
  return {
    'ndcg@8': dcg(gains) / dcg(ideal),
    'must-reads in top 3': order.slice(0, 3).filter((id) => rel.get(id) === 2).length,
    'rank of 1st must-read': Math.min(...top),
    'mean rank of must-reads': top.reduce((a, b) => a + b, 0) / top.length,
  };
};

test('eval: hybrid orders the pool better than the title-only score (numbers printed)', async () => {
  const w = engineerWorld();
  const ids = POOL.map((p) => role(w.ctx, { company: p.company, title: p.title, description: p.description }));
  const floor = new Set(ids.filter((_, i) => /^(Member of Technical Staff|Senior Engineer, Core)/.test(POOL[i].title))); // another occupation: never judged
  const floorId = ids[0];
  const rel = new Map(ids.filter((id) => !floor.has(id)).map((id) => [id, POOL[ids.indexOf(id)].rel]));
  const name = new Map(ids.map((id, i) => [id, POOL[i].title]));
  const order = () => rankRoles(w.ctx).map((r) => r.id);

  process.env.CREWDECK_HYBRID_RANK = 'off';
  const titleOnly = order();
  process.env.CREWDECK_HYBRID_RANK = 'on';
  const keywords = order();
  const e = fakeEmbedder();
  await embedMissing(w.ctx, e);
  await ensureProfileVector(w.ctx, e, notesOf(w.ctx));
  const meaning = order();

  const rows = { 'title only (before)': metrics(titleOnly, rel), 'hybrid: title + keywords': metrics(keywords, rel), 'hybrid: title + keywords + meaning': metrics(meaning, rel) };
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  const lines = ['', 'ranker                              ndcg@8  must-reads in top 3  1st must-read at  mean rank of must-reads'];
  for (const [k, m] of Object.entries(rows)) lines.push(`${k.padEnd(36)}${fmt(m['ndcg@8']).padEnd(8)}${fmt(m['must-reads in top 3']).padEnd(21)}${fmt(m['rank of 1st must-read']).padEnd(18)}${fmt(m['mean rank of must-reads'])}`);
  lines.push('', 'top 5, title only:    ' + titleOnly.slice(0, 5).map((i) => name.get(i)).join(' | '), 'top 5, + keywords:    ' + keywords.slice(0, 5).map((i) => name.get(i)).join(' | '), 'top 5, + meaning:     ' + meaning.slice(0, 5).map((i) => name.get(i)).join(' | '));
  console.log(lines.join('\n'));

  const t = rows['title only (before)'], k = rows['hybrid: title + keywords'], m = rows['hybrid: title + keywords + meaning'];
  const idOf = (title: string) => ids[POOL.findIndex((p) => p.title === title)];
  const foundations = idOf('Software Engineer, Foundations'), mobile = idOf('Senior Software Engineer, Mobile Platform');
  assert.ok(titleOnly.indexOf(mobile) < titleOnly.indexOf(foundations), 'title-only misorders: the Mobile Platform role is above Software Engineer, Foundations');
  assert.ok(keywords.indexOf(foundations) < keywords.indexOf(mobile), 'with keywords, Foundations is above it');
  assert.ok(meaning.indexOf(foundations) < meaning.indexOf(mobile), 'and with meaning too');
  for (const o of [titleOnly, keywords, meaning]) assert.equal([...floor].every((f) => o.indexOf(f) >= o.length - 5), true, 'another occupation stays last in every ranker');
  assert.ok(k['ndcg@8'] > t['ndcg@8'] && m['ndcg@8'] > k['ndcg@8'], 'each signal improves the ordering');
  assert.ok(k['mean rank of must-reads'] < t['mean rank of must-reads']);
  assert.ok(m['mean rank of must-reads'] < t['mean rank of must-reads']);
  assert.ok(m['must-reads in top 3'] > t['must-reads in top 3']);
  assert.ok(rankRoles(w.ctx).every((r) => ['new'].includes(r.status ?? 'new')), 'nothing about eligibility changed');
});
