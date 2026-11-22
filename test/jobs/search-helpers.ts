// Shared by the hybrid-ranking tests: a fictional backend/platform/AI engineer's notes, a fake embedder (no model, no
// network) whose "meaning" is a handful of concept dimensions, and role fixtures. Everyone and everything is fictional.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder } from '../../src/jobs/search/embed.ts';
import { type World, role, world } from './helpers.ts';

// Hybrid ranking is on for these files (the shared helpers switch it off for the suites that pin the cheap score).
process.env.CREWDECK_HYBRID_RANK = 'on';

export const SEARCH_MD = `---
tags: jobs
roles:
  titles: [backend engineer, platform engineer, ai engineer]
  seniority_prefer: [senior, staff]
  exclude_title_words: [intern]
  targets:
    - { name: Backend engineering, titles: [backend engineer, platform engineer, ai engineer], families: [engineering-it], skills: [Go, Python, Kubernetes, distributed systems, inference] }
workplace: [remote]
places: { remote_from: [Germany] }
languages: [{ name: English, level: fluent }]
employment_types: [full-time]
schedule: { timezone: Europe/Berlin, daily_picks: 5, cooldown_days: 60 }
---
# Job search
## Changes
- 2026-11-18: created during setup.
`;
export const CAREER_MD = `---
tags: me
sections:
  - { id: summary, kind: summary }
  - { id: example-labs, kind: experience, title: Senior Backend Engineer, org: Example Labs, where: Berlin, dates: "2020 – now", required: true }
facts:
  - { id: summary.platform, text: "Backend and platform engineer: Go services, Kubernetes clusters, distributed systems and LLM inference serving." }
  - { id: example-labs.infra, text: "Ran a 400-node Kubernetes platform and the GPU inference fleet." }
skills: [Go, Python, Kubernetes, distributed systems, LLM inference]
---
`;

/** A world for the engineer profile (temp vault and tracker, clock fixed). */
export function engineerWorld(): World {
  const w = world('berlin-analyst');
  writeFileSync(join(w.vault, 'jobs', 'search.md'), SEARCH_MD);
  writeFileSync(join(w.vault, 'me', 'career.md'), CAREER_MD);
  return w;
}

/**
 * A fake embedder: each text becomes a count of concept words over eight dimensions, unit length. "Infra", "kubernetes",
 * "cluster" and "gpu" share a dimension, as a real model would put them near each other. Deterministic, offline.
 */
export const CONCEPTS: string[][] = [
  ['infra', 'infrastructure', 'kubernetes', 'k8s', 'cluster', 'clusters', 'gpu', 'platform', 'distributed', 'reliability', 'kubernetes'],
  ['android', 'ios', 'kotlin', 'swift', 'mobile', 'compose', 'jetpack', 'app'],
  ['llm', 'inference', 'model', 'models', 'ml', 'ai', 'training', 'serving'],
  ['frontend', 'react', 'css', 'typescript', 'ui', 'browser'],
  ['sales', 'salesforce', 'crm', 'accounts', 'quota'],
  ['go', 'golang', 'python', 'backend', 'api', 'services', 'service', 'rust'],
  ['design', 'brand', 'figma', 'ux'],
  ['manager', 'hiring', 'people', 'managing'],
];
export const fakeEmbedder = (id = 'fake-concepts-v1'): Embedder & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    id, dims: CONCEPTS.length, calls,
    async embed(texts: string[]) {
      calls.push(texts);
      return texts.map((t) => {
        const v = new Float32Array(CONCEPTS.length);
        for (const w of t.toLowerCase().split(/[^a-z0-9+#]+/)) CONCEPTS.forEach((c, i) => { if (c.includes(w)) v[i] += 1; });
        let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
        return v.map((x) => x / n);
      });
    },
  };
};

export { role };
