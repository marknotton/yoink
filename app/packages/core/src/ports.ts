import type { SignInSite } from "./types.js"

// ── The seams ─────────────────────────────────────────────────────
// The engine never touches a process, a disk or a window. A host app supplies these. Only `Runner`
// is required; the rest have working defaults or can be left out.

export type RunRequest = {
  /** identifies this run so it can be cancelled; unique among runs in flight */
  runId: string
  /** the yt-dlp arguments, exactly as the engine built them */
  args: string[]
  /** add the saved sign-in to this run. The runner should give the run its OWN copy of the cookie file:
   *  yt-dlp rewrites it on exit, so concurrent runs sharing one file can corrupt it. */
  login?: boolean
}

export type RunHandlers = {
  /** one complete line of yt-dlp's stdout (the lookup's JSON arrives as a single long line) */
  onStdout(line: string): void
  /** one complete line of stderr, for error messages */
  onStderr(line: string): void
}

export type RunResult = {
  /** null if it was killed */
  exitCode: number | null
  cancelled: boolean
}

/**
 * How to run yt-dlp on this platform. The ONLY platform-specific code a host must write.
 *
 *  • Stream lines as they happen, not at the end: progress depends on it.
 *  • Supply ffmpeg to yt-dlp (`--ffmpeg-location`) if you bundle one.
 *  • Never rely on PATH if the app is meant to run on machines with nothing installed.
 */
export interface Runner {
  run(request: RunRequest, handlers: RunHandlers): Promise<RunResult>
  /** Stop a run. Use SIGTERM (not SIGKILL): yt-dlp's standalone build is a launcher that must
   *  forward the signal to the real process, or it is orphaned. */
  cancel(runId: string): Promise<void>
  /** Keep a lookup's JSON somewhere yt-dlp can read it back (`--load-info-json`) and return a handle
   *  (usually a file path). Optional: without it, every download re-extracts the link first. */
  storeInfo?(json: string): Promise<string>
  /** Delete files a cancelled download left behind. Optional. */
  removeFiles?(paths: string[]): Promise<void>
}

/** Small async key-value store. The engine uses it for the lookup cache and the sign-in list. */
export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Signing in to a site that only shares video with signed-in users. Each platform does it its own way:
 * a window with the site's login page (desktop), a WebView (Android), a QR code or "sign in on your
 * phone" step (a TV), or importing a cookies file (a server). The engine only needs to know it worked.
 */
export interface Authenticator {
  /** Resolves once a login for this site has been saved where the Runner can use it. Rejects if the
   *  user cancels or it fails. */
  signIn(site: SignInSite): Promise<void>
  /** Forget the saved login for this site. */
  signOut(site: SignInSite): Promise<void>
}

/** A Storage that lives in memory only. The default. */
export function memoryStorage(): Storage {
  const map = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined
    },
    async set(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    },
  }
}
