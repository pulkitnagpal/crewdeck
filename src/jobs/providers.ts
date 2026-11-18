// Job-board providers (design §15): downloaded at setup from a pinned career-ops commit, verified file by file, run in a
// sandboxed child. NOT BUILT YET: this is the hook P5 fills. `jobs init` calls installProviders and `doctor` calls
// providersStatus; until P5 both say sourcing isn't set up, and everything else (pasted links, Apply) works without it.
import type { Config } from '../config.ts';

export type ProvidersStatus = { ready: boolean; message: string };

const NOT_YET: ProvidersStatus = {
  ready: false,
  message: 'Sourcing isn\'t set up yet: job-board providers come in a later Crewdeck version. Pasted links, Prepare and Apply work now.',
};

/** P5: download the pinned providers into <jobs.home>/providers/<commit>/ and verify every file (§15). */
export async function installProviders(_c: Config): Promise<ProvidersStatus> {
  return NOT_YET;
}

/** P5: are the verified providers in place for the pinned commit? */
export function providersStatus(_c: Config): ProvidersStatus {
  return NOT_YET;
}
