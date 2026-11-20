export type CrewdeckLane = string

/** What POST /api/today answers (src/server.ts todayGlance): the Today panel's data. */
export type Today = {
  date: string
  url: string
  notes_page: string
  todos: { line: number; done: boolean; text: string }[]
  jobs:
    | null
    | { error: string }
    | {
        setup_needed: boolean
        connected: boolean
        counts: { needs_you: number; ready: number; in_progress: number; applied_today: number }
        queue: { company: string; title: string; chip: string; kind: string }[]
      }
  tickets: { project: string; id: string; title: string; status: string }[]
  more: number
  projects: { name: string; label: string }[]
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
    }
  }
}
