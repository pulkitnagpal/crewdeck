// One look for every tool in Crewdeck. The palette lives here and nowhere else; the shell, Jobs, Notes (SilverBullet)
// and each board (Backlog.md) get their colours from it, so they always match.
//
// appearance (in ~/.crewdeck/config.yaml):
//   auto  (default) follow the system, which in Claude desktop's browser pane is the app's own light/dark setting
//   light | dark    force one everywhere
export type Appearance = 'auto' | 'light' | 'dark';
export const APPEARANCES: Appearance[] = ['auto', 'light', 'dark'];

type Palette = {
  ground: string; panel: string; card: string; line: string; ink: string; muted: string; soft: string;
  accent: string; accentBg: string; accentInk: string; chip: string; link: string; linkMissing: string; subtleBg: string;
  ok: string; bad: string; okBg: string; badBg: string; warn: string; warnBg: string; warnLine: string; warnSoft: string;
};

export const PALETTE: Record<'light' | 'dark', Palette> = {
  light: {
    ground: '#FBFAF7', panel: '#F3F1EC', card: '#FFFFFF', line: '#E7E3DA', ink: '#1C1B19', muted: '#8A857B', soft: '#5E5A52',
    accent: '#3550D6', accentBg: '#E8ECFB', accentInk: '#FFFFFF', chip: '#EFEDE8', link: '#3550D6', linkMissing: '#B5651D',
    subtleBg: 'rgba(28, 27, 25, 0.06)', ok: '#1F7A4F', bad: '#B42318',
    okBg: '#E3F3EA', badBg: '#FDECEA', warn: '#8A5A00', warnBg: '#FBF0D6', warnLine: '#F1DCA0', warnSoft: '#FFFBEF',
  },
  dark: {
    ground: '#171716', panel: '#1F1E1C', card: '#23221F', line: '#2E2C29', ink: '#ECE9E3', muted: '#9A958C', soft: '#BDB7AC',
    accent: '#8EA2FF', accentBg: '#252B48', accentInk: '#10131F', chip: '#2A2926', link: '#9AAEFF', linkMissing: '#E0A066',
    subtleBg: 'rgba(236, 233, 227, 0.08)', ok: '#5CC48D', bad: '#F97066',
    okBg: '#14321F', badBg: '#3A1714', warn: '#F4CF73', warnBg: '#3A2A08', warnLine: '#6B4E12', warnSoft: '#2A2008',
  },
};

export const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export function normaliseAppearance(v: unknown): Appearance {
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** CSS that applies `vars(palette)` per appearance: one palette when forced, both with a media query when auto. */
function perAppearance(a: Appearance, sel: { light: string; dark: string }, vars: (p: Palette) => string, scheme = true): string {
  const block = (s: string, p: Palette, name: 'light' | 'dark') => `${s} { ${scheme ? `color-scheme: ${name}; ` : ''}${vars(p)} }`;
  if (a !== 'auto') return `${sel.light}, ${sel.dark} { ${scheme ? `color-scheme: ${a}; ` : ''}${vars(PALETTE[a])} }`;
  return `${block(sel.light, PALETTE.light, 'light')}\n${block(sel.dark, PALETTE.dark, 'dark')}`;
}

const shellVars = (p: Palette) =>
  `--font: ${FONT}; --ground: ${p.ground}; --rail: ${p.panel}; --card: ${p.card}; --line: ${p.line}; --ink: ${p.ink}; ` +
  `--muted: ${p.muted}; --soft: ${p.soft}; --accent: ${p.accent}; --accent-bg: ${p.accentBg}; --accent-ink: ${p.accentInk}; ` +
  `--chip: ${p.chip}; --ok: ${p.ok}; --bad: ${p.bad}; --ok-bg: ${p.okBg}; --bad-bg: ${p.badBg}; --warn: ${p.warn}; --warn-bg: ${p.warnBg}; ` +
  `--warn-line: ${p.warnLine}; --warn-soft: ${p.warnSoft}; --panel: ${p.panel}; --link: ${p.link};`;

/** /tokens.css for the shell and Jobs. */
export function tokensCss(a: Appearance): string {
  const head = `/* Crewdeck tokens (appearance: ${a}). Generated from src/appearance.ts. */\n`;
  if (a !== 'auto') return head + `:root { color-scheme: ${a}; ${shellVars(PALETTE[a])} }\n`;
  return head + `:root { color-scheme: light; ${shellVars(PALETTE.light)} }\n` +
    `@media (prefers-color-scheme: dark) { :root { color-scheme: dark; ${shellVars(PALETTE.dark)} } }\n`;
}

const notesVars = (p: Palette) =>
  `--root-background-color: ${p.ground}; --root-color: ${p.ink}; --subtle-color: ${p.muted}; --subtle-background-color: ${p.subtleBg}; ` +
  `--ui-surface-border-color: ${p.line}; --ui-accent-color: ${p.accent}; --ui-accent-contrast-color: ${p.accentInk}; ` +
  `--link-color: ${p.link}; --link-missing-color: ${p.linkMissing}; --top-background-color: ${p.panel}; ` +
  `--top-border-color: ${p.line}; --panel-background-color: ${p.panel}; --editor-font: ${FONT}; --ui-font: ${FONT};`;

/**
 * Injected at the end of SilverBullet's <head> by the Notes proxy: the right colours from the very first paint, before
 * the vault's own theme pages load (a fresh space only runs them after it has been indexed). Same specificity as
 * SilverBullet's built-in rules and later in the page, so it wins over them; the vault's theme pages load later still,
 * so a user's own edits there win over this.
 */
export function notesHead(a: Appearance): string {
  return `<style id="crewdeck-notes">${perAppearance(a, { light: 'html', dark: 'html[data-theme="dark"]' }, notesVars)}</style>`;
}

/** The vault page that makes SilverBullet's own light/dark switch follow Crewdeck (rewritten on every start). */
export function notesAppearancePage(a: Appearance): string {
  const body = a === 'auto'
    // Forget any stored choice: with none, SilverBullet follows the system (Claude desktop's light/dark) like the rest
    // of Crewdeck. Not setUiOption(nil): that arrives as null, which SilverBullet reads as light.
    ? `    clientStore.delete("darkMode")`
    : `    clientStore.set("darkMode", ${a === 'dark'})\n    editor.setUiOption("darkMode", ${a === 'dark'})`;
  return `---\ndescription: Managed by Crewdeck from "appearance" in ~/.crewdeck/config.yaml (${a}). Rewritten on every start; change the config instead.\n---\n` +
    'Crewdeck keeps Notes in the same light/dark as the rest of the workspace.\n\n' +
    '```space-lua\nevent.listen {\n  name = "editor:init",\n  run = function()\n' + body + '\n  end\n}\n```\n';
}

const boardVars = (p: Palette) =>
  `--cd-ground: ${p.ground}; --cd-panel: ${p.panel}; --cd-card: ${p.card}; --cd-line: ${p.line}; --cd-ink: ${p.ink}; ` +
  `--cd-muted: ${p.soft}; --cd-accent: ${p.accent}; --cd-accent-bg: ${p.accentBg};`;

/**
 * Injected first in each board's <head>: Backlog.md reads its light/dark choice from localStorage before it renders, so
 * set it (following the system when auto), then the palette for both of its modes (`html` and `html.dark`).
 */
export function boardHead(a: Appearance, themeCss: string): string {
  const mode = a === 'auto' ? `matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'` : `'${a}'`;
  const script = `<script>try{localStorage.setItem('backlog-theme',${mode})}catch(e){}</script>`;
  const vars = a === 'auto'
    ? `html { ${boardVars(PALETTE.light)} } html.dark { ${boardVars(PALETTE.dark)} }`
    : `html, html.dark { ${boardVars(PALETTE[a])} }`;
  return `${script}<style id="crewdeck-theme">${vars}\n${themeCss}</style>`;
}
