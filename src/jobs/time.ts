// Days in the user's own time zone (jobs/search.md schedule.timezone). The database stores UTC instants; "today" is
// always a local day turned into UTC bounds here, never an SQL offset (zones have DST and half-hour offsets).

/** The zone to use: the user's, else the system's. */
export function zoneOf(tz?: string | null): string {
  if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch {} }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** YYYY-MM-DD of an instant in a zone. */
export const dayIn = (tz: string, at: Date | string | number = new Date()) => new Date(at).toLocaleDateString('en-CA', { timeZone: zoneOf(tz) });

/** Milliseconds the zone is ahead of UTC at an instant. */
function offset(tz: string, at: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The UTC instant a local day starts. */
export function dayStart(tz: string, day: string): number {
  const z = zoneOf(tz);
  const [y, m, d] = day.split('-').map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  let t = midnight;
  for (let i = 0; i < 3; i++) t = midnight - offset(z, t);
  return t;
}

export const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** A local day as UTC ISO bounds [start, end). */
export const dayBounds = (tz: string, day: string): [string, string] => [new Date(dayStart(tz, day)).toISOString(), new Date(dayStart(tz, addDays(day, 1))).toISOString()];

/** Whole local days from one day to another. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
