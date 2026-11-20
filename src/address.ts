// The address without a port (docs/everywhere.md E3): http://crewdeck.localhost instead of http://crewdeck.localhost:4848.
//
// Port 80 needs root on 127.0.0.1, and binding 0.0.0.0:80 would put Crewdeck on the network, so the short address is a
// packet-filter redirect on the loopback interface (127.0.0.1:80 → the shell's port), loaded at boot by a LaunchDaemon.
// The rule goes into a sub-anchor of the `com.apple/*` rdr-anchor that macOS's own /etc/pf.conf already evaluates, so
// /etc/pf.conf is never edited. An extra name (crew.deck) is one hosts-file line.
//
// Crewdeck never runs sudo: it writes the files into ~/.crewdeck/system/ and prints the commands for the person to run,
// and the undo. `crewdeck address --short --done` then checks the redirect reaches this Crewdeck before turning the
// short address on in the config.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { HOME } from './config.ts';
import { proofFor, sameSecret } from './http.ts';

export const DAEMON_LABEL = 'io.crewdeck.address';
export const ANCHOR = 'com.apple/crewdeck';
const SYSTEM_DIR = '/Library/Application Support/Crewdeck';
const DAEMON = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;
const HOSTS_TAG = '# crewdeck';
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type ShortAddressPlan = {
  port: number; name?: string; undo: boolean;
  files: { path: string; text: string }[];
  /** The commands the person runs, in order. */
  steps: string[];
};

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function shortAddressPlan(o: { port: number; name?: string; undo?: boolean; platform?: NodeJS.Platform; home?: string }): ShortAddressPlan {
  if ((o.platform ?? process.platform) !== 'darwin') throw new Error('crewdeck address --short is for macOS for now; on Linux, use http://crewdeck.localhost:<port>');
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw new Error('the shell port must be between 1024 and 65535');
  const name = o.name?.toLowerCase();
  if (name !== undefined && (!NAME.test(name) || /(^|\.)localhost$/.test(name))) throw new Error(`--name ${o.name}: use a host name like crew.deck`);
  const dir = join(o.home ?? HOME, 'system');
  const rules = `# Managed by Crewdeck (crewdeck address --short): http://crewdeck.localhost on port 80 reaches Crewdeck on ${o.port}.
# Loopback only: nothing from the network is redirected.
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${o.port}
`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by Crewdeck: loads the loopback redirect for http://crewdeck.localhost at boot. Remove with crewdeck address --undo. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/sbin/pfctl</string><string>-E</string><string>-a</string><string>${ANCHOR}</string><string>-f</string><string>${SYSTEM_DIR}/pf.conf</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  const files = [{ path: join(dir, 'pf.conf'), text: rules }, { path: join(dir, `${DAEMON_LABEL}.plist`), text: plist }];
  if (o.undo) {
    return {
      port: o.port, name, undo: true, files: [],
      steps: [
        `sudo launchctl bootout system/${DAEMON_LABEL}`,
        `sudo pfctl -a ${ANCHOR} -F all`,
        `sudo rm -f ${DAEMON} ${q(`${SYSTEM_DIR}/pf.conf`)}`,
        `sudo sed -i '' '/${HOSTS_TAG}$/d' /etc/hosts`,
        'crewdeck address --undo --done',
      ],
    };
  }
  return {
    port: o.port, name, undo: false, files,
    steps: [
      `sudo mkdir -p ${q(SYSTEM_DIR)}`,
      `sudo install -m 644 -o root -g wheel ${q(files[0].path)} ${q(`${SYSTEM_DIR}/pf.conf`)}`,
      `sudo install -m 644 -o root -g wheel ${q(files[1].path)} ${DAEMON}`,
      // The copies root loads are checked against what Crewdeck wrote, after they are root's (security review #3): a
      // process of yours that changed ~/.crewdeck/system in between makes this step fail, and nothing is loaded.
      `printf '%s  %s\\n' ${sha(rules)} ${q(`${SYSTEM_DIR}/pf.conf`)} ${sha(plist)} ${DAEMON} | shasum -a 256 -c - && sudo launchctl bootstrap system ${DAEMON}`,
      ...(name ? [`echo '127.0.0.1 ${name} ${HOSTS_TAG}' | sudo tee -a /etc/hosts`] : []),
      `crewdeck address --short${name ? ` --name ${name}` : ''} --done`,
    ],
  };
}

/** Write the plan's files (never as root) and say what to run. */
export function writeShortAddress(plan: ShortAddressPlan): string[] {
  for (const f of plan.files) {
    mkdirSync(join(f.path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(f.path, f.text, { mode: 0o644 });
  }
  const what = plan.undo
    ? 'To go back to the address with the port, run these in Terminal (your admin password is asked once):'
    : `To open Crewdeck at http://crewdeck.localhost${plan.name ? ` and http://${plan.name}` : ''} (no port), run these in Terminal (your admin password is asked once). They add a redirect on this computer only, from port 80 to ${plan.port}, loaded at startup:`;
  return [
    ...(plan.files.length ? [`Wrote ${plan.files.map((f) => f.path).join(' and ')}`] : []),
    what, '', ...plan.steps.map((s) => `  ${s}`), '',
    plan.undo ? 'Undo removes the redirect, its startup file and the hosts line.' : 'To undo later: crewdeck address --undo',
    ...(plan.name ? [`The first time, type ${plan.name}/ (with the slash) or http://${plan.name}: a browser may search for a bare ${plan.name}.`] : []),
  ];
}

export const shortAddressFilesExist = (home = HOME) => existsSync(join(home, 'system', 'pf.conf'));

/**
 * Port 80 on this machine reaches this Crewdeck: a nonce sent there comes back proved with the token and the shell's
 * own port (where the redirect lands). The token is never sent.
 */
export async function shortAddressReaches(shellPort: number, token: string, port = 80): Promise<boolean> {
  if (!(await reachesOn('127.0.0.1', shellPort, token, port))) return false;
  // crewdeck.localhost resolves to ::1 too, and the redirect is IPv4 only (security review #2): nothing may answer there,
  // or a browser trying ::1 first would get that program's page at Crewdeck's address.
  return !(await answersOn('::1', port));
}

/** Anything accepts a connection on host:port. */
export function answersOn(host: string, port: number): Promise<boolean> {
  return new Promise((ok) => {
    const r = request({ host, port, method: 'HEAD', path: '/', timeout: 2000, headers: { host: 'crewdeck.localhost' } }, (res) => { res.resume(); ok(true); });
    r.on('timeout', () => { r.destroy(); ok(true); });
    r.on('error', (e: any) => ok(!['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'EAFNOSUPPORT'].includes(e?.code)));
    r.end();
  });
}

function reachesOn(host: string, shellPort: number, token: string, port: number): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex');
  return new Promise((ok) => {
    const r = request({ host, port, method: 'POST', path: '/api/hello', timeout: 3000,
      headers: { host: 'crewdeck.localhost', 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try { ok(sameSecret(JSON.parse(Buffer.concat(chunks).toString('utf8')).proof, proofFor(token, nonce, shellPort))); } catch { ok(false); }
      });
    });
    r.on('timeout', () => { r.destroy(); ok(false); });
    r.on('error', () => ok(false));
    r.end(JSON.stringify({ nonce }));
  });
}
