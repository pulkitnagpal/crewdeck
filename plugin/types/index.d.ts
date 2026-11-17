export type CrewdeckLane = string

declare module 'claude-code' {
  interface PluginState {
    'crewdeck-bridge': { busy: Shaped<boolean>; holdUntil: Shaped<number>; inflight: Shaped<number[]>; lane: Shaped<CrewdeckLane> }
  }
}
