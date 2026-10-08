import { useCallback, useEffect, useRef, useState } from "react"
import * as backend from "./lib/backend"
import { APP_VERSION, updateActionLabel, useUpdates } from "./lib/updates"
import { UpdateToast } from "./UpdateToast"
import { Logo } from "./logo"
import { ExternalIcon, UpdateAvailableIcon, AlertIcon, CheckIcon, ClockIcon, DownloadIcon, FolderIcon, MusicIcon, PasteIcon, VideoIcon } from "./icons"
import { formatDuration, formatEta, formatSpeed, formatBytes, tildify } from "./lib/format"
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
  | { name: "error"; message: string }

type Job = {
  id: string
  url: string
  title: string
  label: string
  kind: "video" | "audio"
  choiceArgs: string[]
  infoPath: string | null
  status: "running" | "done" | "error"
  progress?: Progress
  processing: boolean
  refreshing: boolean
  filepath?: string
  message?: string
}

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
type HistoryEntry = { url: string; title?: string }

// older versions stored bare URL strings
function loadHistory(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readStore(HISTORY_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((e): HistoryEntry[] => {
      if (typeof e === "string") return [{ url: e }]
      if (e && typeof e.url === "string") return [{ url: e.url, title: typeof e.title === "string" ? e.title : undefined }]
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

  // ── Probe ──────────────────────────────────────────────────────
  const startProbe = useCallback(async (target: string) => {
    const run = ++runRef.current
    setUrl(target)
    setPlatform(detectPlatform(target))
    setPhase({ name: "probing", status: "Fetching video info…" })
    try {
      const result = await backend.probe(target)
      if (run !== runRef.current) return
      const videoInfo = JSON.parse(result.info) as VideoInfo
      infoPathRef.current = result.infoPath
      const built = buildChoices(videoInfo)
      saveCache(target, {
        title: videoInfo.title,
        uploader: videoInfo.uploader,
        duration: videoInfo.duration,
        choices: built,
        infoPath: result.infoPath,
        fetchedAt: Date.now(),
      })
      setFromCache(false)
      setInfo(videoInfo)
      setChoices(built)
      setSelected(0)
      setPhase({ name: "picking" })
    } catch (e) {
      if (run !== runRef.current) return
      setPhase({ name: "error", message: errorText(e) })
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
      const text = e.clipboardData?.getData("text")?.trim() ?? ""
      if (!isProbablyUrl(text)) return
      e.preventDefault()
      setUrlInput(text)
      submit(text)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [phase.name, submit])

  const pasteFromClipboard = async () => {
    try {
      const text = (await backend.readClipboardText()).trim()
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
    const base = { url: job.url, choiceArgs: job.choiceArgs, outDir }
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
        const next = [{ url: job.url, title: job.title }, ...prev.filter((h) => h.url !== job.url)].slice(0, HISTORY_LIMIT)
        writeStore(HISTORY_KEY, JSON.stringify(next))
        return next
      })
    } catch (e) {
      if (cancelledRef.current.has(job.id)) return
      patchJob(job.id, { status: "error", message: errorText(e), progress: undefined, processing: false })
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

  const retryJob = (job: Job) => void runJob(job, null)
  const dismissJob = (id: string) => setJobs((list) => list.filter((j) => j.id !== id))
  const clearFinished = () => setJobs((list) => list.filter((j) => j.status === "running"))

  // ── Navigation ─────────────────────────────────────────────────
  const reset = (keepUrl = false) => {
    runRef.current++
    setInfo(undefined)
    setChoices([])
    setPlatform(undefined)
    if (!keepUrl) setUrlInput("")
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
        {(phase.name === "input" || phase.name === "probing") && (
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
                  <p className="note">YouTube, X, Instagram, Threads, TikTok and 1,800+ other sites.</p>
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
                {jobs.some((j) => j.status !== "running") && (
                  <button className="btn btn--ghost btn--small" onClick={clearFinished}>Clear finished</button>
                )}
              </span>
            </header>
            <ul className="list">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} onCancel={cancelJob} onRetry={retryJob} onDismiss={dismissJob} />
              ))}
            </ul>
          </section>
        )}

        {phase.name === "input" && history.length > 0 && (
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
          {phase.name === "input" && (
            <button className="btn btn--primary" onClick={() => submit(urlInput)} disabled={!urlInput.trim()}>
              Fetch formats
            </button>
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
              <button className="btn btn--primary" onClick={() => void startProbe(url)}>Try again</button>
            </>
          )}
        </div>
      </footer>

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
}: {
  job: Job
  onCancel: (id: string) => void
  onRetry: (job: Job) => void
  onDismiss: (id: string) => void
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
          {job.status === "running" && <span className="row__sub">{job.label} · {progressText(job)}</span>}
          {job.status === "done" && (
            <span className="row__sub row__sub--success"><CheckIcon /> Saved to {tildify(job.filepath!.replace(/\/[^/]+$/, ""))}</span>
          )}
          {job.status === "error" && <span className="row__sub row__sub--error">{job.message}</span>}
        </div>
        <div className="job__actions">
          {job.status === "running" && <button className="btn btn--danger-ghost btn--small" onClick={() => onCancel(job.id)}>Cancel</button>}
          {job.status === "done" && (
            <button className="btn btn--secondary btn--small" onClick={() => void backend.reveal(job.filepath!)}>
              {backend.isAndroid ? "Open" : "Show"}
            </button>
          )}
          {job.status === "error" && <button className="btn btn--secondary btn--small" onClick={() => onRetry(job)}>Retry</button>}
          {job.status !== "running" && (
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
