import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, boardHead, normaliseAppearance, notesAppearancePage, notesHead, tokensCss } from '../src/appearance.ts';

test('appearance: auto unless light or dark is asked for', () => {
  assert.equal(normaliseAppearance(undefined), 'auto');
  assert.equal(normaliseAppearance('dark'), 'dark');
  assert.equal(normaliseAppearance('purple'), 'auto');
});

test('shell tokens: one palette when forced, both with a media query when auto', () => {
  const light = tokensCss('light');
  assert.match(light, new RegExp(`--ground: ${PALETTE.light.ground}`));
  assert.doesNotMatch(light, /prefers-color-scheme/);
  assert.doesNotMatch(light, new RegExp(PALETTE.dark.ground));
  const auto = tokensCss('auto');
  assert.match(auto, /@media \(prefers-color-scheme: dark\)/);
  assert.match(auto, new RegExp(PALETTE.dark.ground));
});

test('notes: forced light overrides SilverBullet\'s dark mode too; auto keys on its data-theme', () => {
  const forced = notesHead('light');
  assert.match(forced, /html, html\[data-theme="dark"\] \{ color-scheme: light; --root-background-color: #FBFAF7/);
  const auto = notesHead('auto');
  assert.match(auto, /html \{ color-scheme: light; --root-background-color: #FBFAF7/);
  assert.match(auto, /html\[data-theme="dark"\] \{ color-scheme: dark; --root-background-color: #171716/);
  assert.match(notesAppearancePage('dark'), /editor\.setUiOption\("darkMode", true\)/);
  assert.match(notesAppearancePage('auto'), /clientStore\.delete\("darkMode"\)/);
  assert.doesNotMatch(notesAppearancePage('auto'), /setUiOption/, 'null would mean light');
});

test('boards: Backlog.md\'s own switch follows the system when auto, palette for both its modes', () => {
  const auto = boardHead('auto', '/*rules*/');
  assert.match(auto, /prefers-color-scheme: dark\)'\)\.matches \? 'dark' : 'light'/);
  assert.match(auto, /html \{ --cd-ground: #FBFAF7.*html\.dark \{ --cd-ground: #171716/s);
  assert.match(boardHead('dark', ''), /setItem\('backlog-theme','dark'\)/);
  assert.match(boardHead('dark', '/*rules*/'), /\/\*rules\*\/<\/style>$/);
});
