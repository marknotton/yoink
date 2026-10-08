import { formatBytes } from "./format"

// ── Types mirrored from yt-dlp's -J output ───────────────────────
type RawFormat = {
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

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  formats?: RawFormat[]
}

export type DownloadChoice = {
  label: string
  detail: string
  kind: "video" | "audio"
  args: string[]
}

export type Progress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  totalParts: number
}

const MAX_VIDEO_CHOICES = 8

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === "mp4") score += 10_000
  if (f.vcodec?.startsWith("avc")) score += 5_000
  return score
}

// DASH formats rarely report a filesize, but they do report a bitrate, so
// estimate from that rather than showing only the audio track's size
function sizeOf(f: RawFormat | undefined, duration?: number): number {
  if (!f) return 0
  const exact = f.filesize ?? f.filesize_approx
  if (exact) return exact
  return f.tbr && duration ? Math.round(((f.tbr * 1000) / 8) * duration) : 0
}

// ── One choice per resolution, plus audio-only mp3 ───────────────
export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
  const byBitrate = (a: RawFormat, b: RawFormat) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0)
  // AAC (m4a) is what QuickTime expects inside an mp4; Opus isn't reliably played
  const bestAudio = [...audioOnly.filter((f) => f.ext === "m4a")].sort(byBitrate)[0] ?? [...audioOnly].sort(byBitrate)[0]
  const audioSize = sizeOf(bestAudio, info.duration)

  const videos = formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.height)
  const heights = [...new Set(videos.map((f) => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const atHeight = videos.filter((f) => f.height === height)
    // YouTube only offers H.264 up to 1080p; above that it's VP9/AV1, which
    // QuickTime and Quick Look can't play inside an mp4 (VLC can)
    const h264 = atHeight.filter((f) => f.vcodec?.startsWith("avc"))
    const best = [...(h264.length ? h264 : atHeight)].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== "none"
    const videoSize = sizeOf(best, info.duration)
    // no usable size for the video stream means no honest total — show none
    const size = videoSize > 0 ? videoSize + (muxed ? 0 : audioSize) : 0
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ""
    const video = h264.length ? `bv*[height=${height}][vcodec^=avc1]` : `bv*[height=${height}]`
    choices.push({
      kind: "video",
      label: `${height}p`,
      detail: `mp4${sizeLabel}`,
      args: [
        "-f",
        `${video}+ba[ext=m4a]/${video}+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        "--merge-output-format",
        "mp4",
      ],
    })
  }

  // if every resolution claims the same size, the extra rows are just noise
  if (choices.length > 1) {
    const sizes = new Set(choices.map((c) => c.detail))
    if (sizes.size === 1 && choices[0].detail.includes("~")) choices.length = 1
  }

  if (choices.length === 0) {
    choices.push({ kind: "video", label: "Best available", detail: "mp4", args: ["-f", "bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b", "--merge-output-format", "mp4"] })
  }

  // a single quality isn't a choice of quality — it's video or audio
  if (choices.length === 1) {
    choices[0].detail = `${choices[0].label === "Best available" ? "" : `${choices[0].label} · `}${choices[0].detail}`
    choices[0].label = "Video with audio"
  }

  choices.push({
    kind: "audio",
    label: "Audio only",
    detail: audioSize > 0 ? `mp3 · ~${formatBytes(audioSize)}` : "mp3",
    args: ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"],
  })

  return choices
}
