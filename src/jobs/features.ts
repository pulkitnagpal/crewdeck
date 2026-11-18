// The risky Jobs switches (design §12), as the user reads them: what each one does and the risk it carries. Shared by
// `crewdeck jobs features` and Jobs → Settings, so both say the same thing.
import { FEATURE_CAPS, type JobsFeatures } from '../config.ts';

export const RISK: Record<keyof JobsFeatures, string> = {
  linkedin_search: 'Reads LinkedIn\'s public job search as a guest. LinkedIn\'s terms forbid automated access: your IP can be rate-limited or blocked. Paced at 2.5 s; stops at the first refusal.',
  linkedin_links: 'Lets you paste LinkedIn job links; Crewdeck reads that one posting page. Same terms-of-service risk, one page per link.',
  easy_apply: 'Lets Claude fill LinkedIn Easy Apply forms in your signed-in browser (you click Submit). Automated use of your account is against LinkedIn\'s terms and can get it restricted.',
  daily_quick_apply: `How many Easy Apply forms Claude may fill per day (0 to ${FEATURE_CAPS.daily_quick_apply}).`,
  email_drafts: 'Lets Claude create Gmail drafts to recruiters. Drafts only: nothing is ever sent by Crewdeck.',
  max_emails_per_day: `Most email drafts per day (0 to ${FEATURE_CAPS.max_emails_per_day}).`,
  linkedin_message_text: 'Lets Claude write LinkedIn message text for you to send yourself.',
};

/** How Settings shows each switch: a title, the number that goes with it, and its risk text. */
export const FEATURE_INFO: { name: keyof JobsFeatures; title: string; limit?: keyof typeof FEATURE_CAPS }[] = [
  { name: 'linkedin_search', title: 'LinkedIn guest search' },
  { name: 'linkedin_links', title: 'Pasted LinkedIn job links' },
  { name: 'easy_apply', title: 'Easy Apply filling', limit: 'daily_quick_apply' },
  { name: 'email_drafts', title: 'Email drafts (Gmail)', limit: 'max_emails_per_day' },
  { name: 'linkedin_message_text', title: 'LinkedIn message text' },
];
