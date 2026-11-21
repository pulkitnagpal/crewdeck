export type CrewdeckLane = string

/** The one-click setup's progress, for the panel. */
export type Install = { phase: 'none' | 'running' | 'done' | 'failed'; step: string; done: number; lines: string[] }

/** A proposal as POST /api/proposals {op:'list'} lists it (P3): items the person approves or rejects one by one. */
export type Proposal = {
  id: number
  summary: string
  status: string
  items: { n: number; line: string; reason?: string; evidence?: string | null; status: string; can_undo: boolean }[]
}

/** What POST /api/today answers (src/server.ts todayGlance): the Today panel's data. */
export type Today = {
  date: string
  /** The running Crewdeck's version. */
  version?: string
  url: string
  notes_page: string
  todos: { line: number; done: boolean; text: string }[]
  jobs:
    | null
    | { error: string }
    | {
        activity?: { state: 'working' | 'waiting' | 'fetching' | 'done' | 'failed'; label: string; detail: string; id?: number } | null
        setup_needed: boolean
        connected: boolean
        session_link: string
        counts: { needs_you: number; ready: number; in_progress: number; applied_today: number }
        queue: { id?: string; company: string; title: string; chip: string; kind: string }[]
        /** Today's picks nobody is applying to yet, best first (P4): the panel's "N jobs ready", Apply on each. */
        picks?: { id: string; company: string; title: string; prepared: boolean }[]
        ready_total?: number
        /** Proposals waiting for Approve or Reject (P3). */
        proposals?: number
        /** Connected portals whose sign-in ran out (ADR-0008): the panel says so, with Sign in (op connectPortal). */
        portals_sign_in?: { id: string; name: string }[]
      }
  tickets: { project: string; id: string; title: string; status: string }[]
  more: number
  projects: { name: string; label: string; path?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    crewdeck: {
      busy: Shaped<boolean>
      holdUntil: Shaped<number>
      inflight: Shaped<number[]>
      lane: Shaped<CrewdeckLane>
      today: Shaped<Today | null>
      todayNote: Shaped<string>
      paneOpen: Shaped<boolean>
      install: Shaped<Install>
      here: Shaped<string>
      lastDone: Shaped<number>
      firstPrompt: Shaped<boolean>
      proposals: Shaped<{ pending: Proposal[]; recent: Proposal[] } | null>
    }
  }
}
