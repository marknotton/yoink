// ── Shared types ──────────────────────────────────────────────────
// Everything here is plain data: serialisable, framework-free, safe to put in any UI's state.

export type Kind = "video" | "audio"

/** One row the user (or a policy) can pick: a resolution, or "audio only". */
export type Choice = {
  /** "1080p", "Audio only", "Video with audio" */
  label: string
  /** "mp4 · ~122 MB": a short description, size estimated when yt-dlp doesn't report one */
  detail: string
  kind: Kind
  /** the yt-dlp options that produce this choice, e.g. ["-f", "bv*[height=1080]…", "--merge-output-format", "mp4"] */
  args: string[]
}

/** What `yt-dlp -J` tells us about a video. Only the fields Yoink reads are typed. */
export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  formats?: RawFormat[]
}

export type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

/** The result of looking a link up. Cheap to keep: no raw format list, just the choices. */
export type Probe = {
  url: string
  title: string
  uploader?: string
  duration?: number
  choices: Choice[]
  /** this link needed a saved sign-in to be looked up (and will to be downloaded) */
  login: boolean
  /** a runner-specific handle to the saved lookup, so the download can skip re-extracting. May expire. */
  infoRef?: string
  fetchedAt: number
  /** true when this came from the cache rather than a fresh yt-dlp run */
  fromCache?: boolean
}

export type Progress = {
  downloadedBytes: number
  totalBytes?: number
  /** bytes per second */
  speed?: number
  /** seconds */
  eta?: number
  /** which file of `totalParts` is downloading (video, then audio, when they're separate) */
  part: number
  totalParts: number
}

export type JobStatus = "queued" | "fetching" | "running" | "done" | "error"

export type Quality = "best" | "audio"

export type Job = {
  id: string
  url: string
  /** the real title once known; until then, the link itself */
  title: string
  /** "1080p", "Audio · mp3", "Queued" */
  label: string
  kind: Kind
  status: JobStatus
  progress?: Progress
  /** the download finished and ffmpeg is merging or converting */
  processing: boolean
  /** the saved lookup went stale, so the download is re-extracting */
  refreshing: boolean
  /** this job uses the saved sign-in */
  login: boolean
  /** set when the job came from a batch, so a retry can start from the lookup */
  quality?: Quality
  /** where the file ended up (only when status is "done") */
  filepath?: string
  error?: YoinkErrorInfo
}

export type YoinkErrorCode =
  /** the site only shares this with signed-in users: offer `site` to the user */
  | "NEEDS_LOGIN"
  /** private, removed, geo-blocked, or the link is wrong */
  | "UNAVAILABLE"
  /** the link looked up fine but offers nothing downloadable */
  | "NO_FORMATS"
  | "CANCELLED"
  /** anything else yt-dlp reported */
  | "FAILED"

/** Serialisable error: UIs render their own wording from `code`; `message` is yt-dlp's, cleaned up. */
export type YoinkErrorInfo = {
  code: YoinkErrorCode
  message: string
  /** for NEEDS_LOGIN: which sign-in would unlock it */
  site?: SignInSite
  /** for NEEDS_LOGIN: a sign-in was tried and the site still refused it */
  hadLogin?: boolean
}

/** What proves a login. A bare name means "this cookie exists". Some sites hand logged-out visitors the
 *  same cookie name, so a rule can also say: don't count it if the token inside it belongs to one of these
 *  anonymous subjects (read from the token's own claims, locally). */
export type MarkerRule = { name: string; jwtSubNot?: string[] }

export type SignInSite = {
  id: string
  label: string
  loginUrl: string
  /** where this site's cookies live (a site can span several domains) */
  cookieUrls: string[]
  /** proof of a login, so a sign-in window can be closed automatically. Empty = can't tell, ask the user. */
  markers: MarkerRule[]
  /** domains to forget when signing out */
  domains: string[]
  note?: string
}
