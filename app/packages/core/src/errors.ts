import type { YoinkErrorCode, YoinkErrorInfo, SignInSite } from "./types.js"

/** Thrown by the engine's promise-returning methods. Jobs carry the same data as plain `YoinkErrorInfo`. */
export class YoinkError extends Error {
  readonly code: YoinkErrorCode
  readonly site?: SignInSite
  readonly hadLogin?: boolean

  constructor(code: YoinkErrorCode, message: string, extra: { site?: SignInSite; hadLogin?: boolean } = {}) {
    super(message)
    this.name = "YoinkError"
    this.code = code
    this.site = extra.site
    this.hadLogin = extra.hadLogin
  }

  toJSON(): YoinkErrorInfo {
    return { code: this.code, message: this.message, site: this.site, hadLogin: this.hadLogin }
  }
}

export const isYoinkError = (e: unknown): e is YoinkError => e instanceof YoinkError

// yt-dlp prints "ERROR: [extractor] video-id: message" on stderr. The last such line is the reason.
// The "[extractor]" tag and the video id are noise to a person, so they're dropped. The id is only
// dropped when a tag precedes it, so messages like "Unsupported URL: …" are left alone.
export function cleanError(stderr: string): string {
  // (indexing, not .at(-1): that needs Safari 15.4, and this runs inside WebViews)
  const errors = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
  const last = errors[errors.length - 1]
  if (!last) return ""
  const body = last.replace(/^ERROR:\s*/, "")
  const tagged = /^\[[^\]]+\]\s*(?:[\w-]+:\s*)?(.*)$/.exec(body)
  return (tagged ? tagged[1] : body).trim()
}

// yt-dlp's wording varies by site, but every "you need to log in" message points at cookies or a login
const NEEDS_LOGIN = /--cookies|authentication is required|login required|log in|sign in to confirm|sign in to view|age-restricted/i
export const needsLogin = (message: string) => NEEDS_LOGIN.test(message)

const UNAVAILABLE = /unavailable|not available|private video|has been removed|does not exist|no longer available|404|not found|unsupported url|geo/i
export const looksUnavailable = (message: string) => UNAVAILABLE.test(message)
