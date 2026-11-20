// Company job-board feeds (Jobs v2 P2a). Entry points: runFeeds (fetch + store), ADAPTERS (one board at a time),
// postingToRole / readPosting (the roles mapping), normalisePlace and friends (location/remote parsing).
export * from './types.ts';
export { ADAPTERS } from './adapters/index.ts';
export { runFeeds, type BoardStats, type RunFeedsOptions } from './run.ts';
export { FEED_USER_AGENT, guardFeedFetch, politeFetch, realClock, type Clock, type PoliteOptions } from './http.ts';
export { Robots, parseRobots, robotsAllows } from './robots.ts';
export { ensureFeedTables, postingId, postingToRole, readPosting, writePosting, closeMissing, dbRobotsStore, payText } from './store.ts';
export { countryCode, countriesIn, employmentType, normalisePlace, remoteScope, saysRemote, workplaceWord } from './normalize.ts';
export { htmlToText } from './html.ts';
