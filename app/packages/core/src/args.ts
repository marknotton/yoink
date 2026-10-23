import type { Choice } from "./types.js"

// ── The yt-dlp command lines, in one place ────────────────────────
// Hosts never write these. They give a Runner the arguments and it runs yt-dlp.

export const PROGRESS_PREFIX = "YOINK|"

// yt-dlp fills in the %(…)s fields. "NA" or "None" means unknown.
export const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  `%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

/** Look a link up: prints one JSON document describing the video. */
export function probeArgs(url: string): string[] {
  return ["-J", "--no-playlist", "--no-warnings", url]
}

export type DownloadArgsInput = {
  url: string
  /** a saved lookup (runner.storeInfo's return value): starts almost instantly, but its media links expire */
  infoRef?: string
  choice: Choice
  /** where and how to name the file, e.g. "/Users/me/Downloads/%(title).60s.%(ext)s" */
  outputTemplate: string
}

/**
 * Download a link. The runner adds anything platform-specific (the ffmpeg location, a private copy of
 * the saved login), so none of that appears here.
 */
export function downloadArgs({ url, infoRef, choice, outputTemplate }: DownloadArgsInput): string[] {
  return [
    ...(infoRef ? ["--load-info-json", infoRef] : [url]),
    ...choice.args,
    "--no-playlist",
    "--no-warnings",
    "--newline",
    // --print implies --quiet, which would hide the progress and the [Merger] / [ExtractAudio]
    // lines the parser relies on
    "--no-quiet",
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    // the final path, printed once the file is in place
    "--print",
    "after_move:filepath",
    "--no-simulate",
    "-o",
    outputTemplate,
  ]
}

/** The default file name: the title (capped at 60 characters) and the right extension. */
export const DEFAULT_FILENAME = "%(title).60s.%(ext)s"
