// Every company-board adapter by ATS. SmartRecruiters is deliberately absent: its robots.txt disallows agents
// other than LinkedIn's (ADR-0002).
import type { Adapter, Ats } from '../types.ts';
import { ashby } from './ashby.ts';
import { breezy } from './breezy.ts';
import { greenhouse } from './greenhouse.ts';
import { keka } from './keka.ts';
import { lever } from './lever.ts';
import { personio } from './personio.ts';
import { recruitee } from './recruitee.ts';
import { teamtailor } from './teamtailor.ts';
import { workable } from './workable.ts';
import { workday } from './workday.ts';
import { zoho } from './zoho.ts';

export const ADAPTERS: Record<Ats, Adapter> = { greenhouse, lever, ashby, workable, recruitee, personio, teamtailor, breezy, workday, keka, zoho };

export { ashby, breezy, greenhouse, keka, lever, personio, recruitee, teamtailor, workable, workday, zoho };
