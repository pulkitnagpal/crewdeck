// C8: a host with a trailing dot ("x.com.", "www.linkedin.com.") is the same host to DNS and browsers, so every host
// comparison strips it: X stays refused, LinkedIn stays behind its switch, copy-only and ATS hosts are still known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUrl, atsOf, checkRoleUrl, copyOnlyHost, hostOf, isLinkedinHost, isLinkedinJobUrl, isXHost } from '../../src/jobs/fields.ts';
import { checkLink } from '../../src/jobs/api.ts';
import { linkedinJobId } from '../../src/jobs/linkedin.ts';

const off = { linkedin_links: false }, on = { linkedin_links: true };

test('C8: trailing-dot hosts are the same host in every check', () => {
  for (const h of ['x.com.', 'X.COM..', 'mobile.twitter.com.', 't.co.']) assert.equal(isXHost(h), true, h);
  for (const h of ['www.linkedin.com.', 'lnkd.in.', 'LINKEDIN.COM.']) assert.equal(isLinkedinHost(h), true, h);
  assert.equal(hostOf('https://Jobs.Example.com./a'), 'jobs.example.com');
  assert.throws(() => checkRoleUrl('https://x.com./example/status/1', on), /X links are never used/);
  assert.throws(() => checkRoleUrl('https://twitter.com../a', on), /X links are never used/);
  assert.throws(() => checkRoleUrl('https://www.linkedin.com./jobs/view/1234567890', off), /LinkedIn links are off/);
  assert.throws(() => checkRoleUrl('https://www.linkedin.com./in/someone', on), /must be job postings/);
  assert.equal(checkRoleUrl('https://www.linkedin.com./jobs/view/1234567890?trk=x', on), 'https://www.linkedin.com/jobs/view/1234567890');
  assert.equal(checkRoleUrl('https://jobs.example.com./a#f', off), 'https://jobs.example.com/a', 'stored without the dot');
  assert.equal(isLinkedinJobUrl(new URL('https://www.linkedin.com./jobs/view/1234567890')), true);
  assert.throws(() => checkLink('https://x.com./a', on), /X links are never used/);
  assert.throws(() => checkLink('https://www.linkedin.com./jobs/view/1234567890', off), /LinkedIn links are off/);
  assert.equal(linkedinJobId('https://www.linkedin.com./jobs/view/1234567890'), '1234567890');
  assert.equal(copyOnlyHost('https://wellfound.com./jobs/1'), 'wellfound.com');
  assert.equal(atsOf('https://jobs.lever.co./example/1'), 'lever');
  assert.equal(atsOf('https://www.linkedin.com./jobs/view/1'), 'linkedin');
  assert.equal(applyUrl('https://jobs.ashbyhq.com./example/1'), 'https://jobs.ashbyhq.com./example/1/application');
});
