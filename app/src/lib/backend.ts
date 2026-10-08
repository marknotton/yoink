import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { LogicalSize } from "@tauri-apps/api/dpi"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { open } from "@tauri-apps/plugin-dialog"
import { readText } from "@tauri-apps/plugin-clipboard-manager"
import type { Progress } from "./ytdlp"

export const isAndroid = /Android/i.test(navigator.userAgent)

export type ProbeResult = { info: string; infoPath: string }
export type DownloadOptions = { url: string; infoPath: string | null; choiceArgs: string[]; outDir: string }
export type DownloadHandlers = { onProgress: (p: Progress) => void; onProcessing: () => void }

export const probe = (url: string) => invoke<ProbeResult>("probe", { url })
export const cancelDownload = (jobId: string) => invoke("cancel_download", { jobId })
export const openDownloads = () => invoke("open_downloads")
export const reveal = (path: string) => invoke("reveal", { path })
export const fileExists = (path: string) => invoke<boolean>("file_exists", { path }).catch(() => false)
export const openFile = (path: string) => invoke("open_file", { path })
export const openUrl = (url: string) => invoke("open_url", { url })
export const defaultOutDir = () => invoke<string>("default_out_dir")

// ── Progress: events on desktop, polling on Android ──────────────
// The Kotlin plugin has no event bridge, so while a download is pending we
// ask it for a snapshot of this job twice a second.
type AndroidProgress = Progress & { active: boolean; processing: boolean }

export async function download(jobId: string, opts: DownloadOptions, handlers: DownloadHandlers): Promise<string> {
  if (!isAndroid) {
    const unlisten = await Promise.all([
      listen<Progress & { jobId: string }>("download-progress", (e) => e.payload.jobId === jobId && handlers.onProgress(e.payload)),
      listen<string>("download-processing", (e) => e.payload === jobId && handlers.onProcessing()),
    ])
    try {
      return await invoke<string>("download", { jobId, ...opts })
    } finally {
      unlisten.forEach((fn) => fn())
    }
  }

  const timer = setInterval(async () => {
    try {
      const p = await invoke<AndroidProgress>("download_progress", { jobId })
      if (!p.active) return
      if (p.processing) handlers.onProcessing()
      else if (p.downloadedBytes > 0) handlers.onProgress(p)
    } catch {
      // a missed poll just means a slightly stale bar
    }
  }, 500)
  try {
    return await invoke<string>("download", { jobId, ...opts })
  } finally {
    clearInterval(timer)
  }
}

export async function chooseFolder(current: string): Promise<string | undefined> {
  if (isAndroid) return undefined // always Download/Yoink
  const dir = await open({ directory: true, defaultPath: current || undefined, title: "Save videos to" })
  return typeof dir === "string" ? dir : undefined
}

// Desktop only: the window hugs its content. On Android the OS owns the size.
export function fitWindowHeight(height: number) {
  if (isAndroid) return
  void getCurrentWindow().setSize(new LogicalSize(window.innerWidth, height))
}

// Read natively first: Android's web view blocks navigator.clipboard.readText(), and on
// macOS the native read avoids the little "Paste" bubble.
export async function readClipboardText(): Promise<string> {
  try {
    return (await readText()) ?? ""
  } catch {
    return navigator.clipboard.readText()
  }
}
