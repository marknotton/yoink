import { PROGRESS_PREFIX } from "./args.js"
import type { Progress } from "./types.js"

// ── Reading yt-dlp's output while it downloads ───────────────────
// Feed it stdout one line at a time. It reports progress, notices when ffmpeg takes over, and
// remembers which files were written (for cleaning up a cancelled download) and the final path.

export type TrackerEvent = { type: "progress"; progress: Progress } | { type: "processing" }

const toNumber = (value: string | undefined): number | undefined => {
  if (!value || value === "NA" || value === "None") return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

const isAbsolutePath = (line: string) => line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line)

export class DownloadTracker {
  private part = 0
  private totalParts = 1
  private lastDownloaded = 0
  private files: string[] = []
  private final = ""

  /** Feed one line. Returns an event when the line means something to a UI, otherwise nothing. */
  feed(rawLine: string): TrackerEvent | undefined {
    const line = rawLine.trim()
    if (!line) return undefined

    if (line.startsWith(PROGRESS_PREFIX)) {
      const [downloaded, total, estimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split("|")
      const downloadedBytes = toNumber(downloaded) ?? 0
      // bytes dropping back means yt-dlp moved on to the next stream (video, then audio)
      if (downloadedBytes < this.lastDownloaded) this.part++
      this.lastDownloaded = downloadedBytes
      return {
        type: "progress",
        progress: {
          downloadedBytes,
          totalBytes: toNumber(total) ?? toNumber(estimate),
          speed: toNumber(speed),
          eta: toNumber(eta),
          part: this.part,
          totalParts: this.totalParts,
        },
      }
    }

    // "[info] xxx: Downloading 1 format(s): 395+251": each id is one file
    if (line.includes("format(s):")) {
      this.totalParts = (line.split("format(s):")[1] ?? "").trim().split("+").length
      return undefined
    }

    if (line.includes("[Merger]") || line.includes("[ExtractAudio]")) {
      const target =
        /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1] ?? /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
      if (target) this.files.push(target)
      return { type: "processing" }
    }

    if (line.startsWith("[download] Destination: ")) {
      this.files.push(line.slice("[download] Destination: ".length))
      return undefined
    }

    // the one bare absolute path yt-dlp prints is the final file (from --print after_move:filepath)
    if (isAbsolutePath(line)) this.final = line
    return undefined
  }

  /** The finished file, once yt-dlp has printed it. Empty until then. */
  get filepath(): string {
    return this.final
  }

  /** Every file yt-dlp started writing: what to delete if the download is cancelled. */
  get destinations(): string[] {
    return [...this.files]
  }
}

/** The names a half-finished download can leave behind next to a destination. */
export const partialsOf = (destination: string): string[] => [destination, `${destination}.part`, `${destination}.ytdl`]
