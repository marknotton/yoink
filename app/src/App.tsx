import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as backend from "./lib/backend"
import { APP_VERSION, updateActionLabel, useUpdates } from "./lib/updates"
import { UpdateToast } from "./UpdateToast"
import { Logo } from "./logo"
import { ExternalIcon, UpdateAvailableIcon, AlertIcon, CheckIcon, ClockIcon, DownloadIcon, FolderIcon, MusicIcon, PasteIcon, VideoIcon } from "./icons"
import { formatDuration, formatEta, formatSpeed, formatBytes, tildify } from "./lib/format"
import { needsLogin, siteForUrl, SITES, type SignedIn, type SignInSite } from "./lib/auth"
import { SignInDialog } from "./SignIn"
import { extractUrls, pickChoice, runPool, type BatchQuality } from "./lib/batch"
import { detectPlatform, isProbablyUrl, type Platform } from "./lib/platforms"
import { buildChoices, type DownloadChoice, type Progress, type VideoInfo } from "./lib/ytdlp"

const VERSION = `v${APP_VERSION}`
const ORIGINAL_AUTHOR = "Pablo Stanley"
const ORIGINAL_REPO = "https://github.com/pablostanley/yoinks"
const ORIGINAL_PROFILE = "https://github.com/pablostanley"
const HISTORY_KEY = "yoink.history"
const OUT_DIR_KEY = "yoink.outDir"
const HISTORY_LIMIT = 50
const CACHE_KEY = "yoink.probeCache"
const CACHE_LIMIT = 20
// The format list rarely changes, so a day-old fetch is fine to show instantly.
// The saved download link inside it expires much sooner, so it's only reused for an hour.
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000
const INFO_PATH_MAX_AGE = 60 * 60 * 1000


// Downloads live outside the phase so any number can run while you paste more links
type Phase =
  | { name: "input"; warning?: string }
  | { name: "probing"; status: string }
  | { name: "picking" }
  | { name: "error"; message: string; signIn?: SignInSite }

type Job = {
  id: string
  url: string
  title: string
  label: string
  kind: "video" | "audio"
  choiceArgs: string[]
  infoPath: string | null
  // queued / fetching only happen in a batch, before the download itself starts
  status: "queued" | "fetching" | "running" | "done" | "error"
  batch?: BatchQuality
  /** this link needed a sign-in, so yt-dlp is given the saved session for it */
  login?: boolean
  /** it failed because the site wants a login; offer to sign in */
  signIn?: SignInSite
  progress?: Progress
  processing: boolean
  refreshing: boolean
  filepath?: string
  message?: string
}

const isActive = (job: Job) => job.status === "queued" || job.status === "fetching" || job.status === "running"
// how many batch links are looked up and downloaded at once
const BATCH_CONCURRENCY = 3

let jobCounter = 0
const newJobId = () => `job-${Date.now().toString(36)}-${++jobCounter}`

// ── localStorage is a nicety, never a dependency ─────────────────
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode or blocked storage — carry on
  }
}
type DownloadedFile = { path: string; label: string }
type HistoryEntry = { url: string; title?: string; files?: DownloadedFile[] }

// older versions stored bare URL strings
function loadHistory(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readStore(HISTORY_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((e): HistoryEntry[] => {
      if (typeof e === "string") return [{ url: e }]
      if (e && typeof e.url === "string") {
        const files = Array.isArray(e.files)
          ? e.files.filter((f: unknown): f is DownloadedFile => !!f && typeof (f as DownloadedFile).path === "string" && typeof (f as DownloadedFile).label === "string")
          : undefined
        return [{ url: e.url, title: typeof e.title === "string" ? e.title : undefined, files }]
      }
      return []
    })
  } catch {
    return []
  }
}

// ── Fetch cache: what yt-dlp told us about a link, kept next to Recent ──
type CachedProbe = {
  title: string
  uploader?: string
  duration?: number
  choices: DownloadChoice[]
  infoPath?: string
  login?: boolean
  fetchedAt: number
}

function loadCache(): Record<string, CachedProbe> {
  try {
    const parsed: unknown = JSON.parse(readStore(CACHE_KEY) ?? "{}")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, CachedProbe>) : {}
  } catch {
    return {}
  }
}

function saveCache(url: string, entry: CachedProbe) {
  const all = { ...loadCache(), [url]: entry }
  // keep only the newest few so this can't grow forever
  const newest = Object.entries(all).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, CACHE_LIMIT)
  writeStore(CACHE_KEY, JSON.stringify(Object.fromEntries(newest)))
}

function freshCached(url: string): CachedProbe | undefined {
  const hit = loadCache()[url]
  const usable = hit && Array.isArray(hit.choices) && hit.choices.length > 0 && Date.now() - hit.fetchedAt < CACHE_MAX_AGE
  if (!usable) return undefined
  // older fetches were saved with a "not QuickTime-compatible" note that no longer exists
  return { ...hit, choices: hit.choices.map((c) => ({ ...c, detail: c.detail.replace(" · not QuickTime-compatible", "") })) }
}

// ── Which sites the user has signed in to (the sessions themselves live in the backend) ──
const SIGNINS_KEY = "yoink.signins"

function loadSignins(): SignedIn[] {
  try {
    const parsed: unknown = JSON.parse(readStore(SIGNINS_KEY) ?? "[]")
    return Array.isArray(parsed)
      ? parsed.filter((s): s is SignedIn => !!s && typeof s.id === "string" && typeof s.label === "string")
      : []
  } catch {
    return []
  }
}

// yt-dlp's own wording is a command-line hint; say what's actually going on
function loginMessage(site: SignInSite, hadLogin: boolean): string {
  // Android can't sign in yet (the sign-in window only exists on the desktop app so far)
  if (backend.isAndroid) return `${site.label} only shares this with signed-in users, and Yoink can’t sign in on Android yet.`
  return hadLogin
    ? `${site.label} didn’t accept your saved sign-in. It may have expired, so sign in again.`
    : `${site.label} only shares this with signed-in users. Sign in once and Yoink will remember it.`
}

const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "")

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: "input" })
  const [urlInput, setUrlInput] = useState("")
  const [url, setUrl] = useState("")
  const [platform, setPlatform] = useState<Platform>()
  const [info, setInfo] = useState<VideoInfo>()
  const [choices, setChoices] = useState<DownloadChoice[]>([])
  const [selected, setSelected] = useState(0)
  const [history, setHistory] = useState(loadHistory)
  const [jobs, setJobs] = useState<Job[]>([])
  const [outDir, setOutDir] = useState(() => (backend.isAndroid ? "" : (readStore(OUT_DIR_KEY) ?? "")))

  const [fromCache, setFromCache] = useState(false)
  const [existing, setExisting] = useState<DownloadedFile[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [signins, setSignins] = useState<SignedIn[]>(loadSignins)
  const signinsRef = useRef(signins) // for callbacks that outlive a render
  signinsRef.current = signins
  const [signInFor, setSignInFor] = useState<{ site: SignInSite; then?: () => void } | null>(null)
  const [signinPick, setSigninPick] = useState(SITES[0].id)
  const loginRef = useRef(false) // did the link being looked at need a sign-in?
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState("")
  const [batchQuality, setBatchQuality] = useState<BatchQuality>("best")
  const batch = useMemo(() => extractUrls(batchText), [batchText])
  const infoPathRef = useRef<string | undefined>(undefined)
  // bumped on every new probe/cancel so a stale yt-dlp result is dropped
  const runRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const updates = useUpdates()
  const footerRef = useRef<HTMLElement>(null)
  // jobs the user cancelled, so their rejected promise isn't shown as an error
  const cancelledRef = useRef(new Set<string>())

  // the update toast sits just above the footer, whatever height the footer is
  useEffect(() => {
    const footer = footerRef.current
    if (!footer) return
    const set = () => document.documentElement.style.setProperty("--footer-actual", `${footer.offsetHeight}px`)
    const observer = new ResizeObserver(set)
    observer.observe(footer)
    set()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!aboutOpen) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAboutOpen(false)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [aboutOpen])

  // ── Window height follows the content ──────────────────────────
  // The scroll container can't report its natural height once the window is
  // taller than it, so the cards sit in an inner wrapper that can.
  useEffect(() => {
    const inner = innerRef.current
    if (!inner || backend.isAndroid) return
    const fit = () => {
      const chrome = 28 + 57 + 16 + 20 // appbar + footer + content padding
      const max = Math.max(300, window.screen.availHeight - 40)
      // the About dialog is taller than the home screen, so the window makes room for it
      const wanted = Math.max(300, Math.ceil(inner.offsetHeight) + chrome, aboutOpen ? 560 : 0)
      const height = Math.min(max, wanted)
      if (Math.abs(height - window.innerHeight) > 1) {
        backend.fitWindowHeight(height)
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(inner)
    fit()
    return () => observer.disconnect()
  }, [aboutOpen])

  useEffect(() => {
    if (outDir) return
    backend.defaultOutDir().then(setOutDir)
  }, [outDir])

  useEffect(() => {
    if (phase.name === "input") inputRef.current?.focus()
  }, [phase.name])

  // On the format page: is a file from an earlier download of this link still there?
  useEffect(() => {
    if (phase.name !== "picking") {
      setExisting([])
      return
    }
    let stale = false
    const files = history.find((h) => h.url === url)?.files ?? []
    void Promise.all(files.map(async (f) => ((await backend.fileExists(f.path)) ? f : null))).then((found) => {
      if (!stale) setExisting(found.filter((f): f is DownloadedFile => f !== null))
    })
    return () => {
      stale = true
    }
  }, [phase.name, url, history])

  // ── Probe ──────────────────────────────────────────────────────
  // Try without a login first: it's the normal case, and it keeps a session from being sent to a
  // site that doesn't need it. Only when the site asks for one do we retry with the saved session.
  const probeSmart = async (target: string) => {
    try {
      return { result: await backend.probe(target, false), login: false }
    } catch (e) {
      if (signinsRef.current.length > 0 && needsLogin(errorText(e))) {
        return { result: await backend.probe(target, true), login: true }
      }
      throw e
    }
  }

  const startProbe = useCallback(async (target: string) => {
    const run = ++runRef.current
    setUrl(target)
    setPlatform(detectPlatform(target))
    setPhase({ name: "probing", status: "Fetching video info…" })
    try {
      const { result, login } = await probeSmart(target)
      if (run !== runRef.current) return
      loginRef.current = login
      const videoInfo = JSON.parse(result.info) as VideoInfo
      infoPathRef.current = result.infoPath
      const built = buildChoices(videoInfo)
      saveCache(target, {
        title: videoInfo.title,
        uploader: videoInfo.uploader,
        duration: videoInfo.duration,
        choices: built,
        infoPath: result.infoPath,
        login,
        fetchedAt: Date.now(),
      })
      setFromCache(false)
      setInfo(videoInfo)
      setChoices(built)
      setSelected(0)
      setPhase({ name: "picking" })
    } catch (e) {
      if (run !== runRef.current) return
      const message = errorText(e)
      if (needsLogin(message)) {
        const site = siteForUrl(target)
        setPhase({ name: "error", message: loginMessage(site, signinsRef.current.length > 0), signIn: backend.isAndroid ? undefined : site })
      } else {
        setPhase({ name: "error", message })
      }
    }
  }, [])

  const submit = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!isProbablyUrl(trimmed)) {
        setPhase({ name: "input", warning: "That doesn’t look like a link — paste a full URL." })
        return
      }
      // fetched this link recently? skip yt-dlp and go straight to the formats
      const cached = freshCached(trimmed)
      if (cached) {
        setUrl(trimmed)
        setPlatform(detectPlatform(trimmed))
        setInfo({ title: cached.title, uploader: cached.uploader, duration: cached.duration })
        setChoices(cached.choices)
        setSelected(0)
        infoPathRef.current = Date.now() - cached.fetchedAt < INFO_PATH_MAX_AGE ? cached.infoPath : undefined
        loginRef.current = !!cached.login
        setFromCache(true)
        setPhase({ name: "picking" })
        return
      }
      void startProbe(trimmed)
    },
    [startProbe],
  )

  // pasting a link anywhere on the input screen goes straight to fetching
  useEffect(() => {
    if (phase.name !== "input") return
    const onPaste = (e: ClipboardEvent) => {
      if (batchOpen) return // the batch box takes pasted text as it is
      const text = e.clipboardData?.getData("text")?.trim() ?? ""
      // more than one link: that's a batch
      if (extractUrls(text).urls.length > 1) {
        e.preventDefault()
        openBatch(text)
        return
      }
      if (!isProbablyUrl(text)) return
      e.preventDefault()
      setUrlInput(text)
      submit(text)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [phase.name, submit, batchOpen])

  const pasteFromClipboard = async () => {
    try {
      const text = (await backend.readClipboardText()).trim()
      if (extractUrls(text).urls.length > 1) {
        openBatch(text)
        return
      }
      setUrlInput(text)
      if (isProbablyUrl(text)) submit(text)
    } catch {
      setPhase({ name: "input", warning: "Couldn’t read the clipboard — paste into the box instead." })
    }
  }

  // ── Download ───────────────────────────────────────────────────
  const patchJob = (id: string, patch: Partial<Job>) =>
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)))

  const runJob = async (job: Job, infoPath: string | null) => {
    const handlers = {
      onProgress: (progress: Progress) => patchJob(job.id, { progress, processing: false }),
      onProcessing: () => patchJob(job.id, { processing: true }),
    }
    const base = { url: job.url, choiceArgs: job.choiceArgs, outDir, useCookies: !!job.login }
    patchJob(job.id, { status: "running", message: undefined, progress: undefined, processing: false, refreshing: false })
    try {
      let filepath: string
      try {
        // reuse the probe's metadata so it starts straight away
        filepath = await backend.download(job.id, { ...base, infoPath }, handlers)
      } catch (e) {
        if (cancelledRef.current.has(job.id)) throw e
        if (infoPath === null) throw e
        // media URLs in the cached info can expire — retry with a fresh extraction
        patchJob(job.id, { progress: undefined, refreshing: true })
        filepath = await backend.download(job.id, { ...base, infoPath: null }, handlers)
      }
      patchJob(job.id, { status: "done", filepath, progress: undefined, processing: false })
      setHistory((prev) => {
        // remember what was saved, so re-opening the link can offer the file again
        const before = prev.find((h) => h.url === job.url)?.files ?? []
        const files = [{ path: filepath, label: job.label }, ...before.filter((f) => f.path !== filepath)].slice(0, 4)
        const next = [{ url: job.url, title: job.title, files }, ...prev.filter((h) => h.url !== job.url)].slice(0, HISTORY_LIMIT)
        writeStore(HISTORY_KEY, JSON.stringify(next))
        return next
      })
    } catch (e) {
      if (cancelledRef.current.has(job.id)) return
      const message = errorText(e)
      if (needsLogin(message)) {
        // refused without a login: if we have one, try again with it
        if (!job.login && signinsRef.current.length > 0) {
          patchJob(job.id, { login: true })
          return runJob({ ...job, login: true }, infoPath)
        }
        const site = siteForUrl(job.url)
        patchJob(job.id, { status: "error", message: loginMessage(site, !!job.login), signIn: backend.isAndroid ? undefined : site, progress: undefined, processing: false })
        return
      }
      patchJob(job.id, { status: "error", message, progress: undefined, processing: false })
    }
  }

  // starting a download hands it to the list and drops you straight back to
  // the paste screen, ready for the next one
  const startDownload = () => {
    const choice = choices[selected]
    if (!choice) return
    const job: Job = {
      id: newJobId(),
      url,
      title: info?.title ?? shortUrl(url),
      label: choice.kind === "audio" ? "Audio · mp3" : choice.label,
      kind: choice.kind,
      choiceArgs: choice.args,
      infoPath: infoPathRef.current ?? null,
      login: loginRef.current,
      status: "running",
      processing: false,
      refreshing: false,
    }
    setJobs((list) => [job, ...list])
    void runJob(job, job.infoPath)
    reset()
  }

  const cancelJob = (id: string) => {
    cancelledRef.current.add(id)
    void backend.cancelDownload(id)
    setJobs((list) => list.filter((j) => j.id !== id))
  }

  // Open / Show: say so when it fails, instead of silently doing nothing
  const openSaved = async (path: string, how: "open" | "show" = "open") => {
    try {
      await (how === "open" ? backend.openFile(path) : backend.reveal(path))
      setOpenError(null)
    } catch (e) {
      setOpenError(errorText(e))
      setTimeout(() => setOpenError(null), 6000)
    }
  }

  const retryJob = (job: Job) =>
    job.batch && job.choiceArgs.length === 0 ? void processBatchJob(job, job.batch) : void runJob(job, null)
  const dismissJob = (id: string) => setJobs((list) => list.filter((j) => j.id !== id))
  const clearFinished = () => setJobs((list) => list.filter(isActive))

  // ── Batch ──────────────────────────────────────────────────────
  const openBatch = (text = "") => {
    setBatchText(text)
    setBatchOpen(true)
    setPhase({ name: "input" })
  }
  const closeBatch = () => {
    setBatchOpen(false)
    setBatchText("")
  }

  // One link, start to finish: look it up, take the best format, download it.
  const processBatchJob = async (job: Job, quality: BatchQuality) => {
    if (cancelledRef.current.has(job.id)) return
    patchJob(job.id, { status: "fetching", message: undefined })
    try {
      let title = job.title
      let choicesFound: DownloadChoice[]
      let infoPath: string | undefined
      let login = false
      const cached = freshCached(job.url) // fetched it recently? no need to ask again
      if (cached) {
        title = cached.title
        choicesFound = cached.choices
        infoPath = Date.now() - cached.fetchedAt < INFO_PATH_MAX_AGE ? cached.infoPath : undefined
        login = !!cached.login
      } else {
        const probed = await probeSmart(job.url)
        const result = probed.result
        login = probed.login
        const videoInfo = JSON.parse(result.info) as VideoInfo
        title = videoInfo.title
        choicesFound = buildChoices(videoInfo)
        infoPath = result.infoPath
        saveCache(job.url, { title, uploader: videoInfo.uploader, duration: videoInfo.duration, choices: choicesFound, infoPath, login, fetchedAt: Date.now() })
      }
      if (cancelledRef.current.has(job.id)) return
      const choice = pickChoice(choicesFound, quality)
      if (!choice) throw new Error("No downloadable formats were found for this link.")
      const ready: Job = {
        ...job,
        title,
        label: choice.kind === "audio" ? "Audio · mp3" : choice.label,
        kind: choice.kind,
        choiceArgs: choice.args,
        infoPath: infoPath ?? null,
        login,
      }
      patchJob(job.id, { login, title: ready.title, label: ready.label, kind: ready.kind, choiceArgs: ready.choiceArgs, infoPath: ready.infoPath })
      await runJob(ready, ready.infoPath)
    } catch (e) {
      if (cancelledRef.current.has(job.id)) return
      const message = errorText(e)
      if (needsLogin(message)) {
        const site = siteForUrl(job.url)
        patchJob(job.id, { status: "error", message: loginMessage(site, signinsRef.current.length > 0), signIn: backend.isAndroid ? undefined : site, progress: undefined, processing: false })
        return
      }
      patchJob(job.id, { status: "error", message, progress: undefined, processing: false })
    }
  }

  const startBatch = () => {
    const taken = new Set(jobs.filter(isActive).map((j) => j.url)) // already on its way
    const fresh = batch.urls.filter((u) => !taken.has(u))
    if (fresh.length === 0) return
    const queued: Job[] = fresh.map((u) => ({
      id: newJobId(),
      url: u,
      title: shortUrl(u),
      label: "Queued",
      kind: batchQuality === "audio" ? "audio" : "video",
      choiceArgs: [],
      infoPath: null,
      status: "queued",
      batch: batchQuality,
      processing: false,
      refreshing: false,
    }))
    setJobs((list) => [...queued, ...list])
    closeBatch()
    void runPool(queued, BATCH_CONCURRENCY, (job) => processBatchJob(job, batchQuality))
  }

  // ── Signing in ─────────────────────────────────────────────────
  const openSignIn = (site: SignInSite, then?: () => void) => setSignInFor({ site, then })

  const finishSignIn = () => {
    if (!signInFor) return
    const { site, then } = signInFor
    const next = [...signinsRef.current.filter((s) => s.id !== site.id), { id: site.id, label: site.label }]
    signinsRef.current = next // visible to the retry below, before the next render
    setSignins(next)
    writeStore(SIGNINS_KEY, JSON.stringify(next))
    setSignInFor(null)
    then?.()
  }

  const signOut = async (id: string) => {
    const site = SITES.find((s) => s.id === id)
    if (site) await backend.cookiesForget(site.domains).catch(() => undefined)
    const next = signinsRef.current.filter((s) => s.id !== id)
    signinsRef.current = next
    setSignins(next)
    writeStore(SIGNINS_KEY, JSON.stringify(next))
  }

  // after signing in, try every link that was waiting on that site again
  const retryWaiting = (site: SignInSite) => {
    for (const j of jobs) if (j.status === "error" && j.signIn?.id === site.id) retryJob(j)
  }

  // ── Navigation ─────────────────────────────────────────────────
  const reset = (keepUrl = false) => {
    runRef.current++
    setInfo(undefined)
    setChoices([])
    setPlatform(undefined)
    if (!keepUrl) setUrlInput("")
    setBatchOpen(false)
    setPhase({ name: "input" })
  }

  const cancel = () => reset(true) // a cancel shouldn't throw the link away

  const clearHistory = () => {
    setHistory([])
    writeStore(HISTORY_KEY, "[]")
  }

  const changeFolder = async () => {
    const dir = await backend.chooseFolder(outDir)
    if (dir) {
      setOutDir(dir)
      writeStore(OUT_DIR_KEY, dir)
    }
  }

  const busy = phase.name === "probing"
  // the big logo belongs to the home screen; every other page gets the small one (Android)
  // green tick = up to date, orange arrow = update available, red = the check failed
  const updateTone = updates.checking
    ? "checking"
    : updates.error
      ? "error"
      : updates.latest
        ? "available"
        : updates.checkedOnce
          ? "ok"
          : "idle"
  const isHome = phase.name === "input" || phase.name === "probing"

  return (
    <div className="app">
      <div className="appbar" data-tauri-drag-region>
        {backend.isAndroid ? (isHome ? null : <Logo className="logo logo--small" />) : <span className="appbar__title" data-tauri-drag-region>Yoink</span>}
      </div>

      <main className="content">
        <div className="content__inner" ref={innerRef}>
        {isHome && <Logo />}
        {phase.name === "input" && batchOpen && (
          <section className="card">
            <header className="card-header">
              <h2 className="card-title">Batch download</h2>
              <button className="btn btn--ghost btn--small" onClick={closeBatch}>Single link</button>
            </header>
            <div className="card-body">
              <textarea
                className="textarea"
                rows={6}
                autoFocus
                spellCheck={false}
                placeholder={"Paste your links here, one per line.\nAny text with links in it works."}
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
              />
              <p className={`note ${batch.urls.length === 0 && batchText.trim() ? "note--error" : ""}`}>
                {batch.urls.length === 0
                  ? batchText.trim() ? "No links found in that text." : "Links are found, tidied and de-duplicated for you."
                  : `${batch.urls.length} ${batch.urls.length === 1 ? "link" : "links"} found${batch.duplicates ? ` · ${batch.duplicates} duplicate${batch.duplicates === 1 ? "" : "s"} ignored` : ""}${batch.truncated ? ` · only the first ${batch.urls.length} will be used` : ""}`}
              </p>
              <div className="seg" role="radiogroup" aria-label="Quality">
                <button role="radio" aria-checked={batchQuality === "best"} className={`pill pill--choice${batchQuality === "best" ? " pill--accent" : ""}`} onClick={() => setBatchQuality("best")}>Best quality</button>
                <button role="radio" aria-checked={batchQuality === "audio"} className={`pill pill--choice${batchQuality === "audio" ? " pill--accent" : ""}`} onClick={() => setBatchQuality("audio")}>Audio only · mp3</button>
              </div>
              <p className="note">
                {batchQuality === "best"
                  ? "Takes the highest resolution available for each link. 4K videos can be several GB each."
                  : "Saves the audio from each link as an mp3."}
              </p>
            </div>
          </section>
        )}

        {((phase.name === "input" && !batchOpen) || phase.name === "probing") && (
          <>
            <section className="card">
              <header className="card-header">
                <h2 className="card-title">Paste a link</h2>
                {platform && <span className="pill pill--accent">{platform.label}</span>}
              </header>
              <div className="card-body">
                <div className="field">
                  <input
                    ref={inputRef}
                    className="input"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="https://youtube.com/watch?v=…"
                    value={phase.name === "probing" ? url : urlInput}
                    disabled={phase.name === "probing"}
                    onChange={(e) => {
                      setUrlInput(e.target.value)
                      if (phase.name === "input" && phase.warning) setPhase({ name: "input" })
                    }}
                    onKeyDown={(e) => e.key === "Enter" && submit(urlInput)}
                  />
                  <button className="btn btn--secondary" onClick={pasteFromClipboard} disabled={busy}>
                    <PasteIcon /> Paste
                  </button>
                </div>
                {phase.name === "input" && phase.warning && (
                  <p className="note note--error"><AlertIcon /> {phase.warning}</p>
                )}
                {phase.name === "probing" && (
                  <p className="note"><span className="spinner" /> {phase.status}</p>
                )}
                {phase.name === "input" && !phase.warning && (
                  <>
                    <p className="note">YouTube, X, Instagram, Threads, TikTok and 1,800+ other sites.</p>
                    <p className="note">
                      <button className="link-btn" onClick={() => openBatch(urlInput)}>Have a list? Download several at once.</button>
                    </p>
                  </>
                )}
              </div>
            </section>
          </>
        )}

        {phase.name === "picking" && info && (
          <>
            <section className="card">
              <header className="card-header">
                <h2 className="card-title">Video</h2>
                <span className="card-actions">
                  {fromCache && (
                    <button className="btn btn--ghost btn--small" onClick={() => void startProbe(url)} title="This is from your last fetch">
                      Refresh
                    </button>
                  )}
                  {platform && <span className="pill pill--accent">{platform.label}</span>}
                </span>
              </header>
              <div className="card-body">
                <p className="video-title">{info.title}</p>
                <p className="meta">
                  {[info.uploader, info.duration ? formatDuration(info.duration) : ""].filter(Boolean).join(" · ")}
                </p>
              </div>
            </section>

            {existing.length > 0 && (
              <section className="card card--success">
                <ul className="list">
                  {existing.map((f) => (
                    <li key={f.path} className="found">
                      <CheckIcon />
                      <div className="found__text">
                        <span className="found__title">File still exists. Open now?</span>
                        <span className="found__name">{f.label} · {f.path.split("/").pop()}</span>
                      </div>
                      <div className="found__actions">
                        <button className="btn btn--secondary btn--small" onClick={() => void openSaved(f.path)}>Open</button>
                        {!backend.isAndroid && (
                          <button className="btn btn--ghost btn--small" onClick={() => void openSaved(f.path, "show")}>Show</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="card">
              <header className="card-header">
                <h2 className="card-title">Format</h2>
              </header>
              <ul className="list" role="radiogroup">
                {choices.map((choice, index) => (
                  <li key={choice.label}>
                    <button
                      role="radio"
                      aria-checked={index === selected}
                      className={`row row--option${index === selected ? " row--active" : ""}`}
                      onClick={() => setSelected(index)}
                      onDoubleClick={startDownload}
                    >
                      {choice.kind === "audio" ? <MusicIcon /> : <VideoIcon />}
                      <span className="row__name">{choice.label}</span>
                      <span className="row__detail">{choice.detail}</span>
                      <span className="radio" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {jobs.length > 0 && (
          <section className="card">
            <header className="card-header">
              <h2 className="card-title">Downloads</h2>
              <span className="card-actions">
                {backend.isAndroid && jobs.some((j) => j.status === "done") && (
                  <button className="btn btn--ghost btn--small" onClick={() => void backend.openDownloads()}>Open folder</button>
                )}
                {jobs.some((j) => !isActive(j)) && (
                  <button className="btn btn--ghost btn--small" onClick={clearFinished}>Clear finished</button>
                )}
              </span>
            </header>
            <ul className="list">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} onCancel={cancelJob} onRetry={retryJob} onDismiss={dismissJob} onOpen={openSaved} onSignIn={(site) => openSignIn(site, () => retryWaiting(site))} />
              ))}
            </ul>
          </section>
        )}

        {phase.name === "input" && !batchOpen && history.length > 0 && (
          <section className="card">
            <header className="card-header">
              <h2 className="card-title">Recent</h2>
              <button className="btn btn--ghost btn--small" onClick={clearHistory}>Clear</button>
            </header>
            <ul className="list">
              {history.slice(0, 6).map((entry) => (
                <li key={entry.url}>
                  <button className="row" onClick={() => submit(entry.url)} title={entry.url}>
                    <ClockIcon />
                    <span className="row__text">
                      <span className="row__name">{entry.title ?? shortUrl(entry.url)}</span>
                      {entry.title && <span className="row__sub">{shortUrl(entry.url)}</span>}
                    </span>
                    <span className="pill">{detectPlatform(entry.url).label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {openError && <p className="note note--error job-error"><AlertIcon /> {openError}</p>}
          </section>
        )}

        {phase.name === "error" && (
          <section className="card">
            <header className="card-header">
              <h2 className="card-title">Something went wrong</h2>
              <span className="pill pill--error">Error</span>
            </header>
            <div className="card-body">
              <p className="mono-error">{phase.message}</p>
            </div>
          </section>
        )}
        </div>
      </main>

      <UpdateToast updates={updates} />

      <footer className="footer" ref={footerRef}>
        <div className="footer__meta">
          {backend.isAndroid ? (
            <button className="btn btn--ghost" onClick={() => void backend.openDownloads()} title="Saved to Download/Yoink">
              <FolderIcon /> Open Downloads
            </button>
          ) : (
            <button className="btn btn--ghost" onClick={changeFolder} disabled={busy} title="Choose where videos are saved">
              <FolderIcon /> {outDir ? tildify(outDir) : "…"}
            </button>
          )}
          <button className="btn btn--ghost btn--about" onClick={() => setAboutOpen(true)}>About · {VERSION}</button>
        </div>
        <div className="footer__actions">
          {phase.name === "input" && !batchOpen && (
            <button className="btn btn--primary" onClick={() => submit(urlInput)} disabled={!urlInput.trim()}>
              Fetch formats
            </button>
          )}
          {phase.name === "input" && batchOpen && (
            <>
              <button className="btn btn--ghost" onClick={closeBatch}>Back</button>
              <button className="btn btn--primary" onClick={startBatch} disabled={batch.urls.length === 0}>
                <DownloadIcon /> Download {batch.urls.length > 0 ? `${batch.urls.length} ` : ""}{batch.urls.length === 1 ? "link" : "links"}
              </button>
            </>
          )}
          {busy && (
            <button className="btn btn--danger-ghost" onClick={cancel}>Cancel</button>
          )}
          {phase.name === "picking" && (
            <>
              <button className="btn btn--ghost" onClick={() => reset(true)}>Back</button>
              <button className="btn btn--primary" onClick={startDownload}>
                <DownloadIcon /> Download
              </button>
            </>
          )}
          {phase.name === "error" && (
            <>
              <button className="btn btn--ghost" onClick={() => reset(true)}>Back</button>
              {phase.signIn ? (
                <button className="btn btn--primary" onClick={() => openSignIn(phase.signIn!, () => void startProbe(url))}>
                  Sign in to {phase.signIn.label}
                </button>
              ) : (
                <button className="btn btn--primary" onClick={() => void startProbe(url)}>Try again</button>
              )}
            </>
          )}
        </div>
      </footer>

      {signInFor && <SignInDialog site={signInFor.site} onSignedIn={finishSignIn} onClose={() => setSignInFor(null)} />}

      {aboutOpen && (
        <div className="modal-backdrop" onClick={() => setAboutOpen(false)}>
          <section className="card modal" role="dialog" aria-label="About Yoink" onClick={(e) => e.stopPropagation()}>
            <header className="card-header">
              <h2 className="card-title">About Yoink</h2>
              <span className="pill">{VERSION}</span>
            </header>
            <div className="card-body">
              <p>
                Yoink is a graphical version of <strong>yoinks</strong>, the original terminal app created by{" "}
                <strong>{ORIGINAL_AUTHOR}</strong>. All credit for the idea and the download flow goes to them.
              </p>
              <div className="update-row">
                <span className={`update-row__status ${updateTone}`}>
                  {updates.checking ? <span className="spinner" /> : updateTone === "ok" ? <CheckIcon /> : updateTone === "available" ? <UpdateAvailableIcon /> : updateTone === "error" ? <AlertIcon /> : null}
                  <span className="meta">
                    {updates.error
                      ? updates.error
                      : updates.checking
                        ? "Checking for updates…"
                        : updates.latest
                          ? `Version ${updates.latest.version} is available.`
                          : updates.checkedOnce
                            ? "You’re up to date."
                            : `You’re on ${VERSION}.`}
                  </span>
                </span>
                {updates.latest ? (
                  <button className="btn btn--primary btn--small" onClick={() => void updates.install()} disabled={updates.status === "installing"}>
                    {updateActionLabel()}
                  </button>
                ) : (
                  <button className="btn btn--secondary btn--small" onClick={() => void updates.check(true)} disabled={updates.checking}>
                    Check for updates
                  </button>
                )}
              </div>
              {!backend.isAndroid && (
              <div className="signins">
                <p className="meta"><strong>Sign-ins</strong> · for sites that only share video with logged-in users</p>
                {signins.map((s) => (
                  <div className="signin-row" key={s.id}>
                    <span className="signin-row__name"><CheckIcon /> {s.label}</span>
                    <button className="btn btn--ghost btn--small" onClick={() => void signOut(s.id)}>Sign out</button>
                  </div>
                ))}
                <div className="signin-add">
                  <select className="select" value={signinPick} onChange={(e) => setSigninPick(e.target.value)} aria-label="Site">
                    {SITES.filter((s) => !signins.some((x) => x.id === s.id)).map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn--secondary btn--small"
                    disabled={signins.some((x) => x.id === signinPick)}
                    onClick={() => { const site = SITES.find((s) => s.id === signinPick); if (site) { setAboutOpen(false); openSignIn(site) } }}
                  >
                    Sign in
                  </button>
                </div>
              </div>
              )}
              <p className="meta">Powered by yt-dlp and ffmpeg. Released under the MIT licence.</p>
              <p className="meta">Only download what you have the right to keep, and be excellent to creators.</p>
              <div className="links">
                <button className="btn btn--secondary" onClick={() => void backend.openUrl(ORIGINAL_REPO)}>
                  <ExternalIcon /> pablostanley/yoinks
                </button>
                <button className="btn btn--secondary" onClick={() => void backend.openUrl(ORIGINAL_PROFILE)}>
                  <ExternalIcon /> {ORIGINAL_AUTHOR}
                </button>
              </div>
              <div className="modal__actions">
                <button className="btn btn--primary" onClick={() => setAboutOpen(false)}>Close</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

// ── Downloads list ───────────────────────────────────────────────
function progressText(job: Job): string {
  const { progress, processing, refreshing } = job
  if (processing) return "Processing…"
  if (!progress) return refreshing ? "Link expired — grabbing a fresh one…" : "Starting…"
  const percent = progress.totalBytes ? Math.min(1, progress.downloadedBytes / progress.totalBytes) : 0
  const parts = progress.totalParts > 1 ? `part ${progress.part + 1}/${progress.totalParts}` : ""
  return progress.totalBytes
    ? [
        `${Math.round(percent * 100)}%`,
        progress.speed ? formatSpeed(progress.speed) : "",
        progress.eta ? `${formatEta(progress.eta)} left` : "",
        parts,
      ].filter(Boolean).join(" · ")
    : [`${formatBytes(progress.downloadedBytes)} downloaded`, parts].filter(Boolean).join(" · ")
}

function JobRow({
  job,
  onCancel,
  onRetry,
  onDismiss,
  onOpen,
  onSignIn,
}: {
  job: Job
  onCancel: (id: string) => void
  onRetry: (job: Job) => void
  onDismiss: (id: string) => void
  onOpen: (path: string, how?: "open" | "show") => void
  onSignIn: (site: SignInSite) => void
}) {
  const percent = job.processing
    ? 1
    : job.progress?.totalBytes
      ? Math.min(1, job.progress.downloadedBytes / job.progress.totalBytes)
      : 0

  return (
    <li className="job">
      <div className="job__main">
        {job.kind === "audio" ? <MusicIcon /> : <VideoIcon />}
        <div className="job__text">
          <span className="row__name">{job.title}</span>
          {job.status === "queued" && <span className="row__sub">Waiting for a free slot…</span>}
          {job.status === "fetching" && <span className="row__sub"><span className="spinner" /> Looking up the best format…</span>}
          {job.status === "running" && <span className="row__sub">{job.label} · {progressText(job)}</span>}
          {job.status === "done" && (
            <span className="row__sub row__sub--success"><CheckIcon /> Saved to {tildify(job.filepath!.replace(/\/[^/]+$/, ""))}</span>
          )}
          {job.status === "error" && <span className="row__sub row__sub--error">{job.message}</span>}
        </div>
        <div className="job__actions">
          {isActive(job) && <button className="btn btn--danger-ghost btn--small" onClick={() => onCancel(job.id)}>Cancel</button>}
          {job.status === "done" && (
            <button className="btn btn--secondary btn--small" onClick={() => void onOpen(job.filepath!, backend.isAndroid ? "open" : "show")}>
              {backend.isAndroid ? "Open" : "Show"}
            </button>
          )}
          {job.status === "error" && job.signIn && (
            <button className="btn btn--primary btn--small" onClick={() => onSignIn(job.signIn!)}>Sign in</button>
          )}
          {job.status === "error" && !job.signIn && <button className="btn btn--secondary btn--small" onClick={() => onRetry(job)}>Retry</button>}
          {!isActive(job) && (
            <button className="btn btn--ghost btn--small" onClick={() => onDismiss(job.id)} aria-label="Dismiss">✕</button>
          )}
        </div>
      </div>
      {job.status === "running" && (
        <div className="progress"><div className="progress__fill" style={{ width: `${percent * 100}%` }} /></div>
      )}
    </li>
  )
}
