import { downloadArgs, DEFAULT_FILENAME, probeArgs } from "./args.js"
import { cleanError, looksUnavailable, needsLogin, YoinkError } from "./errors.js"
import { buildChoices } from "./formats.js"
import { pickChoice } from "./pick.js"
import { DownloadTracker, partialsOf } from "./parse.js"
import { runPool } from "./pool.js"
import { memoryStorage, type Authenticator, type Runner, type Storage } from "./ports.js"
import { siteForUrl } from "./sites.js"
import type { Choice, Job, Probe, Quality, SignInSite, VideoInfo, YoinkErrorInfo } from "./types.js"
import { extractUrls } from "./urls.js"

// ── The engine ────────────────────────────────────────────────────
// Look a link up, choose a format, download, track the job. Headless: no screens, no processes, no
// disks. Everything platform-specific goes through the ports (see ports.ts). Everything a UI wants to
// show is plain data on a Job, with events to say when it changed.

export type ChooseContext = { quality: Quality; url: string }
export type OutputContext = { url: string; title: string; choice: Choice }

/** The decisions a host can override. Every one has a default. */
export type Policy = {
  /** Pick a format for a batch (or `downloadBest`). Default: the tallest video, or the audio row. */
  chooseFormat(choices: Choice[], ctx: ChooseContext): Choice | undefined
  /** The full yt-dlp output template: directory plus file name. Default: `<outputDir>/%(title).60s.%(ext)s`. */
  outputTemplate(ctx: OutputContext): string
}

export type YoinkOptions = {
  runner: Runner
  /** Where files go, unless `policy.outputTemplate` decides otherwise. May be a function, read each time. */
  outputDir: string | (() => string)
  /** Persists the lookup cache and which sites are signed in. Default: memory only. */
  storage?: Storage
  /** Needed only if the host offers signing in. */
  authenticator?: Authenticator
  policy?: Partial<Policy>
  /** How many batch links are looked up and downloaded at once. Default 3. */
  concurrency?: number
  /** How long a lookup is reused (the format list rarely changes). Default 24 hours. */
  cacheTtlMs?: number
  /** How long a lookup's saved download links are trusted (they expire quickly). Default 1 hour. */
  infoRefTtlMs?: number
  /** Called after a file is saved. Move it, tag it, notify: your call. Errors are ignored. */
  onDownloaded?: (job: Job) => void | Promise<void>
  /** Test hooks. */
  now?: () => number
  newId?: () => string
}

export type YoinkEvent =
  | { type: "job-added"; job: Job }
  | { type: "job-updated"; job: Job }
  | { type: "job-removed"; job: Job }
  | { type: "job-done"; job: Job }
  | { type: "job-error"; job: Job }
  | { type: "signins-changed"; signedIn: string[] }

export type BatchResult = {
  jobs: Job[]
  /** links found twice (including the same video spelled differently) */
  duplicates: number
  /** more than the limit were found; only the first were used */
  truncated: boolean
  /** resolves when every job in this batch has finished or failed */
  done: Promise<void>
}

export interface Yoink {
  /** Resolves once saved state (signed-in sites) is loaded. Methods wait for it themselves. */
  ready: Promise<void>
  /** Look a link up. Tries anonymously first, and only uses a saved sign-in if the site asks for one. */
  probe(url: string, options?: { refresh?: boolean }): Promise<Probe>
  /** Start downloading a choice from a probe. Returns the job at once; watch it with subscribe(). */
  download(probe: Probe, choice: Choice): Job
  /** Look up and download many links: the best quality (or audio) of each, a few at a time. Accepts any
   *  text containing links, or a list. */
  batch(input: string | string[], options?: { quality?: Quality }): BatchResult
  getJobs(): Job[]
  /** Stop a job and remove it. Partial files are deleted if the runner can. */
  cancel(jobId: string): Promise<void>
  /** Run a failed job again. A batch job that never got as far as a download starts over from the lookup. */
  retry(jobId: string): void
  dismiss(jobId: string): void
  /** Remove every finished or failed job; running ones stay. */
  clearFinished(): void
  /** Listen for changes. Returns the unsubscribe function. */
  subscribe(listener: (event: YoinkEvent) => void): () => void
  /** Resolves when no job is active. Handy in scripts. */
  idle(): Promise<void>
  /** Sign in to a site (through the Authenticator), then retry anything that was waiting on it. */
  signIn(site: SignInSite): Promise<void>
  signOut(site: SignInSite): Promise<void>
  /** Ids of the sites with a saved sign-in. */
  signedIn(): string[]
}

const isActive = (job: Job) => job.status === "queued" || job.status === "fetching" || job.status === "running"

const SIGNINS_KEY = "signins"
const cacheKey = (url: string) => `probe:${url}`

// what the engine remembers about a job beyond its plain-data fields
type JobContext = { choice?: Choice; infoRef?: string; quality?: Quality }

export function createYoink(options: YoinkOptions): Yoink {
  const { runner } = options
  const storage = options.storage ?? memoryStorage()
  const now = options.now ?? Date.now
  const concurrency = options.concurrency ?? 3
  const cacheTtl = options.cacheTtlMs ?? 24 * 60 * 60 * 1000
  const infoRefTtl = options.infoRefTtlMs ?? 60 * 60 * 1000

  let counter = 0
  const newId = options.newId ?? (() => `job-${now().toString(36)}-${++counter}`)
  let probeCounter = 0

  const outputDir = () => (typeof options.outputDir === "function" ? options.outputDir() : options.outputDir)
  const policy: Policy = {
    chooseFormat: (choices, ctx) => pickChoice(choices, ctx.quality),
    outputTemplate: () => `${outputDir().replace(/[\\/]+$/, "")}/${DEFAULT_FILENAME}`,
    ...options.policy,
  }

  let jobs: Job[] = []
  const contexts = new Map<string, JobContext>()
  const trackers = new Map<string, DownloadTracker>()
  const cancelled = new Set<string>()
  const listeners = new Set<(event: YoinkEvent) => void>()
  let signedInIds: string[] = []

  const ready = (async () => {
    signedInIds = (await storage.get<string[]>(SIGNINS_KEY)) ?? []
  })()

  const emit = (event: YoinkEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // one misbehaving listener must not break the engine
      }
    }
  }

  const find = (id: string) => jobs.find((j) => j.id === id)

  function patch(id: string, changes: Partial<Job>) {
    let updated: Job | undefined
    jobs = jobs.map((j) => (j.id === id ? (updated = { ...j, ...changes }) : j))
    if (updated) emit({ type: "job-updated", job: updated })
  }

  function add(job: Job) {
    jobs = [job, ...jobs]
    emit({ type: "job-added", job })
  }

  // ── Errors ──────────────────────────────────────────────────────
  function classify(url: string, stderr: string, exitCode: number | null): YoinkError {
    const message = cleanError(stderr) || `yt-dlp stopped (exit code ${exitCode ?? "none"}).`
    if (needsLogin(message)) return new YoinkError("NEEDS_LOGIN", message, { site: siteForUrl(url), hadLogin: signedInIds.length > 0 })
    if (looksUnavailable(message)) return new YoinkError("UNAVAILABLE", message)
    return new YoinkError("FAILED", message)
  }

  // anything thrown becomes a YoinkError, so jobs always carry a code and a message
  const asYoinkError = (e: unknown, url: string): YoinkError => {
    if (e instanceof YoinkError) return e
    return classify(url, `ERROR: ${e instanceof Error ? e.message : String(e)}`, null)
  }

  const infoOf = (e: YoinkError): YoinkErrorInfo => e.toJSON()

  function fail(id: string, e: unknown) {
    const job = find(id)
    if (!job) return
    const error = infoOf(asYoinkError(e, job.url))
    patch(id, { status: "error", error, progress: undefined, processing: false })
    const updated = find(id)
    if (updated) emit({ type: "job-error", job: updated })
  }

  // ── Looking a link up ───────────────────────────────────────────
  async function runProbe(url: string, login: boolean): Promise<{ info: VideoInfo; infoRef?: string }> {
    const lines: string[] = []
    const errors: string[] = []
    const result = await runner.run(
      { runId: `probe-${++probeCounter}`, args: probeArgs(url), login },
      { onStdout: (l) => lines.push(l), onStderr: (l) => errors.push(l) },
    )
    if (result.exitCode !== 0) throw classify(url, errors.join("\n"), result.exitCode)
    const text = lines.join("\n")
    let info: VideoInfo
    try {
      info = JSON.parse(text) as VideoInfo
    } catch {
      throw new YoinkError("FAILED", "Could not read the video information from yt-dlp.")
    }
    return { info, infoRef: runner.storeInfo ? await runner.storeInfo(text).catch(() => undefined) : undefined }
  }

  async function probe(url: string, opts: { refresh?: boolean } = {}): Promise<Probe> {
    await ready
    const target = url.trim()
    if (!opts.refresh) {
      const cached = await storage.get<Probe>(cacheKey(target))
      if (cached && Array.isArray(cached.choices) && cached.choices.length > 0 && now() - cached.fetchedAt < cacheTtl) {
        // the saved download links go stale long before the format list does
        const fresh = now() - cached.fetchedAt < infoRefTtl
        return { ...cached, infoRef: fresh ? cached.infoRef : undefined, fromCache: true }
      }
    }

    let login = false
    let got: { info: VideoInfo; infoRef?: string }
    try {
      got = await runProbe(target, false)
    } catch (e) {
      // only the site's own "log in" message earns a retry with the saved session
      if (e instanceof YoinkError && e.code === "NEEDS_LOGIN" && signedInIds.length > 0) {
        login = true
        got = await runProbe(target, true)
      } else {
        throw e
      }
    }
    const result: Probe = {
      url: target,
      title: got.info.title,
      uploader: got.info.uploader,
      duration: got.info.duration,
      choices: buildChoices(got.info),
      login,
      infoRef: got.infoRef,
      fetchedAt: now(),
    }
    await storage.set(cacheKey(target), result).catch(() => undefined)
    return result
  }

  // ── Downloading ─────────────────────────────────────────────────
  async function attempt(id: string, useInfo: boolean, login: boolean): Promise<string> {
    const job = find(id)
    const context = contexts.get(id)
    if (!job || !context?.choice) throw new YoinkError("FAILED", "That download no longer exists.")

    const tracker = new DownloadTracker()
    trackers.set(id, tracker)
    const errors: string[] = []
    const args = downloadArgs({
      url: job.url,
      infoRef: useInfo ? context.infoRef : undefined,
      choice: context.choice,
      outputTemplate: policy.outputTemplate({ url: job.url, title: job.title, choice: context.choice }),
    })
    const result = await runner.run(
      { runId: id, args, login },
      {
        onStdout: (line) => {
          const event = tracker.feed(line)
          if (event?.type === "progress") patch(id, { progress: event.progress, processing: false })
          else if (event?.type === "processing") patch(id, { processing: true })
        },
        onStderr: (line) => errors.push(line),
      },
    )

    if (cancelled.has(id) || result.cancelled) {
      // don't leave half-written files behind
      await runner.removeFiles?.(tracker.destinations.flatMap(partialsOf)).catch(() => undefined)
      throw new YoinkError("CANCELLED", "Download cancelled.")
    }
    if (result.exitCode === 0 && tracker.filepath) return tracker.filepath
    throw classify(job.url, errors.join("\n"), result.exitCode)
  }

  // Try the straightforward way, then the two things that commonly fix a failure: the saved sign-in
  // (the site wanted one), and a fresh lookup (the saved download links expired).
  async function execute(id: string): Promise<void> {
    const context = contexts.get(id)
    if (!find(id) || !context?.choice) return
    patch(id, { status: "running", error: undefined, progress: undefined, processing: false, refreshing: false })

    let useInfo = context.infoRef !== undefined
    let login = find(id)?.login ?? false
    for (;;) {
      try {
        const filepath = await attempt(id, useInfo, login)
        patch(id, { status: "done", filepath, progress: undefined, processing: false, refreshing: false })
        const done = find(id)
        if (done) {
          emit({ type: "job-done", job: done })
          try {
            await options.onDownloaded?.(done)
          } catch {
            // the file is saved either way
          }
        }
        return
      } catch (e) {
        const err = asYoinkError(e, find(id)?.url ?? "")
        if (cancelled.has(id) || err.code === "CANCELLED") return
        if (err.code === "NEEDS_LOGIN" && !login && signedInIds.length > 0) {
          login = true
          patch(id, { login: true })
          continue
        }
        if (useInfo) {
          useInfo = false
          patch(id, { progress: undefined, refreshing: true })
          continue
        }
        fail(id, err)
        return
      }
    }
  }

  function download(p: Probe, choice: Choice): Job {
    const job: Job = {
      id: newId(),
      url: p.url,
      title: p.title,
      label: choice.kind === "audio" ? "Audio · mp3" : choice.label,
      kind: choice.kind,
      status: "running",
      processing: false,
      refreshing: false,
      login: p.login,
    }
    contexts.set(job.id, { choice, infoRef: p.infoRef })
    add(job)
    void execute(job.id)
    return job
  }

  // ── Batches ─────────────────────────────────────────────────────
  async function processBatchJob(id: string, quality: Quality): Promise<void> {
    if (cancelled.has(id)) return
    const job = find(id)
    if (!job) return
    patch(id, { status: "fetching", error: undefined })
    try {
      const p = await probe(job.url)
      if (cancelled.has(id)) return
      const choice = policy.chooseFormat(p.choices, { quality, url: job.url })
      if (!choice) throw new YoinkError("NO_FORMATS", "No downloadable formats were found for this link.")
      contexts.set(id, { choice, infoRef: p.infoRef, quality })
      patch(id, { title: p.title, label: choice.kind === "audio" ? "Audio · mp3" : choice.label, kind: choice.kind, login: p.login })
      await execute(id)
    } catch (e) {
      if (cancelled.has(id)) return
      fail(id, e)
    }
  }

  function batch(input: string | string[], opts: { quality?: Quality } = {}): BatchResult {
    const quality = opts.quality ?? "best"
    const found = typeof input === "string" ? extractUrls(input) : extractUrls(input.join("\n"))
    const taken = new Set(jobs.filter(isActive).map((j) => j.url)) // already on its way
    const fresh = found.urls.filter((u) => !taken.has(u))
    const queued: Job[] = fresh.map((url) => ({
      id: newId(),
      url,
      title: url,
      label: "Queued",
      kind: quality === "audio" ? "audio" : "video",
      status: "queued",
      processing: false,
      refreshing: false,
      login: false,
      quality,
    }))
    for (const job of [...queued].reverse()) add(job) // keeps the pasted order at the top of the list
    const done = runPool(queued, concurrency, (job) => processBatchJob(job.id, quality))
    return { jobs: queued, duplicates: found.duplicates, truncated: found.truncated, done }
  }

  // ── Managing jobs ───────────────────────────────────────────────
  async function cancel(id: string): Promise<void> {
    const job = find(id)
    if (!job) return
    cancelled.add(id)
    await runner.cancel(id).catch(() => undefined)
    jobs = jobs.filter((j) => j.id !== id)
    emit({ type: "job-removed", job })
  }

  function retry(id: string): void {
    const job = find(id)
    if (!job || job.status !== "error") return
    cancelled.delete(id)
    const context = contexts.get(id)
    if (context?.choice) {
      // it got as far as a download: go again, with a fresh lookup since the saved one may be stale
      contexts.set(id, { ...context, infoRef: undefined })
      void execute(id)
    } else if (job.quality) {
      void processBatchJob(id, job.quality)
    }
  }

  function dismiss(id: string): void {
    const job = find(id)
    if (!job || isActive(job)) return
    jobs = jobs.filter((j) => j.id !== id)
    contexts.delete(id)
    emit({ type: "job-removed", job })
  }

  function clearFinished(): void {
    for (const job of jobs.filter((j) => !isActive(j))) dismiss(job.id)
  }

  // ── Signing in ──────────────────────────────────────────────────
  async function setSignedIn(ids: string[]) {
    signedInIds = ids
    await storage.set(SIGNINS_KEY, ids).catch(() => undefined)
    emit({ type: "signins-changed", signedIn: [...ids] })
  }

  async function signIn(site: SignInSite): Promise<void> {
    await ready
    if (!options.authenticator) throw new YoinkError("FAILED", "Signing in isn't available in this app.")
    await options.authenticator.signIn(site)
    await setSignedIn([...signedInIds.filter((id) => id !== site.id), site.id])
    // anything that was refused for want of this login gets another go
    for (const job of jobs) if (job.status === "error" && job.error?.code === "NEEDS_LOGIN" && job.error.site?.id === site.id) retry(job.id)
  }

  async function signOut(site: SignInSite): Promise<void> {
    await ready
    await options.authenticator?.signOut(site)
    await setSignedIn(signedInIds.filter((id) => id !== site.id))
  }

  function subscribe(listener: (event: YoinkEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function idle(): Promise<void> {
    if (!jobs.some(isActive)) return Promise.resolve()
    return new Promise((resolve) => {
      const off = subscribe(() => {
        if (!jobs.some(isActive)) {
          off()
          resolve()
        }
      })
    })
  }

  return {
    ready,
    probe,
    download,
    batch,
    getJobs: () => [...jobs],
    cancel,
    retry,
    dismiss,
    clearFinished,
    subscribe,
    idle,
    signIn,
    signOut,
    signedIn: () => [...signedInIds],
  }
}
