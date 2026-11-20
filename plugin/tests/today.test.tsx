// The /crewdeck command and the Today panel (docs/everywhere.md E6, E7), against a fake Crewdeck: the token file, the
// challenge-first hello, /api/today and /api/today/todo, answered by hooks standing for the engine's fs and process.
import { expect, test } from 'claude-code/testing'

const TOKEN = 'a'.repeat(64)
const HOME = '/fake/crewdeck-home'

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

type Todo = { line: number; done: boolean; text: string }

/** curl's config syntax as the plugin writes it: `name = "value"` lines, \\ and \" escaped. */
function parseCurlConfig(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const m = /^([a-z-]+) = "((?:[^"\\]|\\.)*)"$/.exec(line)
    if (!m) continue
    const v = (m[2] ?? '').replace(/\\(.)/g, '$1')
    ;(out[m[1] ?? ''] ??= []).push(v)
  }
  return out
}
const res = (exitCode: number, stdout: string, stderr: string) => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
/** A slash command the person typed at the prompt. */
const typed = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** A fake Crewdeck on port 4848: what each curl the plugin runs gets back, and what it was asked. */
function fakeCrewdeck(o: { running: boolean }) {
  const s = {
    running: o.running,
    todos: [{ line: 4, done: false, text: 'Tweet for the day' }] as Todo[],
    calls: [] as { path: string; body: any; token: boolean }[],
    opened: [] as string[],
    started: 0,
  }
  const today = () => ({
    date: '2026-11-20', url: 'http://crewdeck.localhost:4848', notes_page: 'journal/2026-11-20', todos: s.todos,
    jobs: { setup_needed: false, connected: false, counts: { needs_you: 1, ready: 2, in_progress: 0, applied_today: 0 },
      queue: [{ company: 'Acme', title: 'Backend Engineer', chip: 'Needs you', kind: 'first' }] },
    tickets: [{ project: 'app', id: 'TASK-2', title: 'Fix login', status: 'In Progress' }], more: 0,
    projects: [{ name: 'app', label: 'Board' }],
  })
  const run = async (argv: readonly string[], init?: { stdin?: string }) => {
    const ok = (stdout: string) => res(0, stdout, '')
    if (argv[0] === 'sh') return ok(HOME)
    if (argv[0] === 'open') { s.opened.push(argv[1] ?? ''); return ok('') }
    if (argv[0] === `${HOME}/bin/crewdeck`) { s.started++; s.running = true; return ok('http://crewdeck.localhost:4848/') }
    if (argv[0] === 'curl') {
      if (!s.running) return res(7, '', 'connection refused')
      // Everything comes on stdin as curl config; the arguments never carry the token.
      expect(argv.join(' ')).toBe('curl -s -m 3 -X POST --config -')
      const conf = parseCurlConfig(init?.stdin ?? '')
      const path = (conf.url?.[0] ?? '').replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
      const body = JSON.parse(conf['data-binary']?.[0] ?? '{}')
      s.calls.push({ path, body, token: (conf.header ?? []).includes(`x-crewdeck-token: ${TOKEN}`) })
      if (path === '/api/hello') return ok(JSON.stringify({ proof: await sha256Hex(`crewdeck-proof:${TOKEN}:${body.nonce}:4848`) }))
      if (path === '/api/today') return ok(JSON.stringify(today()))
      if (path === '/api/today/todo') {
        if (body.op === 'add') s.todos = [...s.todos, { line: 5, done: false, text: body.text }]
        if (body.op === 'set') s.todos = s.todos.map((t) => (t.line === body.line && t.text === body.text ? { ...t, done: body.done } : t))
        return ok(JSON.stringify(today()))
      }
      if (path === '/api/claim') return ok(JSON.stringify({ lane: 'cockpit', cli: 'crewdeck', proof: await sha256Hex(`crewdeck-proof:${TOKEN}:${body.nonce}:4848`), requests: [] }))
      return ok('{}')
    }
    return res(127, '', 'unknown')
  }
  return { s, run }
}

const PANE = {
  plugin: 'crewdeck', component: 'Pane', requestId: 'crewdeck-today',
  props: { title: 'Crewdeck · Today', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('/crewdeck opens the Today panel: to-dos, jobs, tickets; ticking and adding go to Crewdeck with the token', async ($, on) => {
  const { s, run } = fakeCrewdeck({ running: true })
  on('command.register', () => ({ value: { command: 'crewdeck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: `${TOKEN}\n` }))
  on('process.run', async (_, e) => ({ value: await run(e.argv, e.init) }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(typed('crewdeck'))
  expect(out.text).toBe('Crewdeck is open beside the chat.')
  // The token went only to the agent endpoints, after the hello proved the server.
  expect(s.calls.find((c) => c.path === '/api/hello')?.token).toBe(false)
  expect(s.calls.find((c) => c.path === '/api/today')?.token).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'todo-4' }))?.props.label).toBe('☐ Tweet for the day')
    expect(await ui.find({ type: 'Text', text: /1 need you · 2 ready to submit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Acme · Backend Engineer \(Needs you\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /TASK-2 Fix login · In Progress/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs a Claude Code session open in your jobs folder/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'todo-4' })
  expect(s.calls.at(-1)).toEqual({ path: '/api/today/todo', body: { date: '2026-11-20', op: 'set', line: 4, text: 'Tweet for the day', done: true }, token: true })
  expect((await ui.find({ key: 'todo-4' }))?.props.label).toBe('☑ Tweet for the day')
  await ui.input({ key: 'add-todo', text: '  Build my portfolio  ' })
  expect(s.calls.at(-1)?.body).toEqual({ date: '2026-11-20', op: 'add', text: 'Build my portfolio' })
  expect((await ui.find({ key: 'todo-5' }))?.props.label).toBe('☐ Build my portfolio')
  await ui.press({ key: 'notes' })
  await ui.press({ key: 'open-jobs' })
  expect(s.opened).toEqual(['http://crewdeck.localhost:4848/#notes/journal/2026-11-20', 'http://crewdeck.localhost:4848/#jobs'])
  await ui.unmount()
})

test('/crewdeck starts Crewdeck when it is not running; /crewdeck jobs opens the Jobs page', async ($, on) => {
  const { s, run } = fakeCrewdeck({ running: false })
  on('command.register', () => ({ value: { command: 'crewdeck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: `${TOKEN}\n` }))
  on('process.run', async (_, e) => ({ value: await run(e.argv, e.init) }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(typed('crewdeck', 'jobs'))
  expect(s.started).toBe(1)
  expect(out.text).toBe('Opened http://crewdeck.localhost:4848/#jobs in your browser.')
  expect(s.opened).toEqual(['http://crewdeck.localhost:4848/#jobs'])
})

test('without Crewdeck set up, the panel says so and offers Start', async ($, on) => {
  on('command.register', () => ({ value: { command: 'crewdeck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('process.run', async (_, e) => ({ value: e.argv[0] === 'sh' ? res(0, HOME, '') : res(127, '', 'not found') }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(typed('crewdeck'))
  expect(out.text).toMatch(/Crewdeck did not start|not set up/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'start' }))?.props.label).toBe('Start Crewdeck')
  await ui.unmount()
})
