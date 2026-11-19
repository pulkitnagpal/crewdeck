// The Jobs page's files: web/jobs/* (HTML, JS, CSS, SVG only, inside that folder) and Preact + htm from node_modules
// through an explicit map, so no other package file is reachable. index.html's one inline script (the importmap) is
// allowed in the CSP by its hash, computed from the file as served.
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { REPO } from '../config.ts';
import { jobsCsp, send } from '../http.ts';

export const WEB_JOBS = join(REPO, 'web', 'jobs');
const MODULES = join(REPO, 'node_modules');
export const VENDOR: Record<string, string> = {
  'vendor/preact.mjs': join(MODULES, 'preact', 'dist', 'preact.module.js'),
  'vendor/hooks.mjs': join(MODULES, 'preact', 'hooks', 'dist', 'hooks.module.js'),
  'vendor/htm.mjs': join(MODULES, 'htm', 'dist', 'htm.module.js'),
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/** The sha256 (base64) of the page's importmap script, for its CSP. */
export function importmapHash(html: string): string {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('web/jobs/index.html has no importmap');
  return createHash('sha256').update(m[1]).digest('base64');
}

/** Serve one /jobs/… path; false when it isn't a Jobs file (the caller answers 404). */
export function serveJobsStatic(path: string, res: ServerResponse): boolean {
  const rel = path === '/jobs/' ? 'index.html' : decodeURIComponent(path.slice('/jobs/'.length));
  if (Object.hasOwn(VENDOR, rel)) {
    // Source maps are not served: drop the comment so the browser doesn't ask.
    const js = readFileSync(VENDOR[rel], 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
    send(res, 200, js, TYPES['.mjs']);
    return true;
  }
  const file = normalize(join(WEB_JOBS, rel));
  if (!file.startsWith(WEB_JOBS + sep) || !Object.hasOwn(TYPES, extname(file)) || extname(file) === '.mjs' || !existsSync(file) || !statSync(file).isFile()) return false;
  const body = readFileSync(file);
  if (extname(file) === '.html') send(res, 200, body, TYPES['.html'], { 'content-security-policy': jobsCsp(importmapHash(body.toString('utf8'))) });
  else send(res, 200, body, TYPES[extname(file)]);
  return true;
}
