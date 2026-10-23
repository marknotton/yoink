// @marknotton/yoink-core: the headless engine behind Yoink.
// Start with `createYoink` (engine.ts) and the `Runner` seam (ports.ts). Everything else is exported
// because hosts sometimes want a piece on its own: the link finder, the format builder, the parser.

export { createYoink } from "./engine.js"
export type { BatchResult, ChooseContext, OutputContext, Policy, Yoink, YoinkEvent, YoinkOptions } from "./engine.js"

export { memoryStorage } from "./ports.js"
export type { Authenticator, RunHandlers, RunRequest, RunResult, Runner, Storage } from "./ports.js"

export { cleanError, isYoinkError, looksUnavailable, needsLogin, YoinkError } from "./errors.js"

export { buildChoices } from "./formats.js"
export { pickChoice } from "./pick.js"
export { runPool } from "./pool.js"
export { extractUrls, isProbablyUrl, MAX_BATCH, normaliseUrl } from "./urls.js"
export type { ExtractedLinks } from "./urls.js"
export { detectPlatform, isSignInLink, SITES, siteForUrl } from "./sites.js"
export type { Platform } from "./sites.js"

export { DEFAULT_FILENAME, downloadArgs, probeArgs, PROGRESS_PREFIX, PROGRESS_TEMPLATE } from "./args.js"
export { DownloadTracker, partialsOf } from "./parse.js"
export type { TrackerEvent } from "./parse.js"

export { formatBytes, formatDuration, formatEta, formatSpeed, tildify } from "./format.js"

export type {
  Choice,
  Job,
  JobStatus,
  Kind,
  MarkerRule,
  Probe,
  Progress,
  Quality,
  RawFormat,
  SignInSite,
  VideoInfo,
  YoinkErrorCode,
  YoinkErrorInfo,
} from "./types.js"
