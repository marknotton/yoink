import { isProbablyUrl } from "./platforms"
import type { DownloadChoice } from "./ytdlp"

// ── Pulling links out of whatever got pasted ─────────────────────
// Handles a tidy list, an email, a chat thread, a spreadsheet column: anything
// with links in it. Scheme-less links ("youtu.be/abc") are accepted too.

export const MAX_BATCH = 200

const WITH_SCHEME = /https?:\/\/[^\s<>"'`]+/gi
// a bare domain followed by a path, e.g. youtu.be/abc or www.tiktok.com/@x/video/1
const BARE = /(?:^|[\s(<])((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"'`]+)/gi

// share links carry tracking noise that makes the same video look like a different link
const TRACKING = /^(utm_.*|fbclid|igshid|gclid|si|feature)$/i

function clean(raw: string): string {
  // trailing punctuation belongs to the sentence, not the link
  return raw.replace(/[.,;:!?)\]}>'"]+$/, "")
}

const YOUTUBE_HOST = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i
const YOUTUBE_ID = /^[\w-]{11}$/

/** One canonical form per video, so duplicates can be spotted. */
export function normaliseUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const host = u.hostname.toLowerCase()
  let id: string | undefined
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0]
  else if (YOUTUBE_HOST.test(host)) {
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)
    id = u.pathname === "/watch" ? (u.searchParams.get("v") ?? undefined) : m?.[1]
  }
  if (id && YOUTUBE_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`

  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key)
  u.hash = ""
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") // /a/ and /a are the same page
  return u.toString().replace(/\/$/, "")
}

export type ExtractedLinks = { urls: string[]; duplicates: number; truncated: boolean }

export function extractUrls(text: string): ExtractedLinks {
  // keep each match's position so the queue follows the order they were pasted in
  const found: { at: number; url: string }[] = []
  for (const m of text.matchAll(WITH_SCHEME)) found.push({ at: m.index ?? 0, url: clean(m[0]) })
  // bare links, with the https:// ones blanked out (same length, so positions still line up)
  const masked = text.replace(WITH_SCHEME, (hit) => " ".repeat(hit.length))
  for (const m of masked.matchAll(BARE)) {
    found.push({ at: (m.index ?? 0) + m[0].length - m[1].length, url: `https://${clean(m[1])}` })
  }
  found.sort((x, y) => x.at - y.at)

  const seen = new Set<string>()
  const urls: string[] = []
  let duplicates = 0
  for (const { url: raw } of found) {
    if (!isProbablyUrl(raw)) continue
    const key = normaliseUrl(raw)
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    urls.push(key)
  }
  return { urls: urls.slice(0, MAX_BATCH), duplicates, truncated: urls.length > MAX_BATCH }
}

// ── Choosing the format for a batch ──────────────────────────────
export type BatchQuality = "best" | "audio"

// buildChoices lists video rows tallest first, then the audio row, so the best
// video is simply the first video row
export function pickChoice(choices: DownloadChoice[], quality: BatchQuality): DownloadChoice | undefined {
  if (quality === "audio") return choices.find((c) => c.kind === "audio") ?? choices[0]
  return choices.find((c) => c.kind === "video") ?? choices[0]
}

// ── A small work queue: at most `limit` at a time ────────────────
// Each lane takes the next item as soon as it's free, so a slow download
// doesn't hold up the others.
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await worker(item)
      } catch {
        // the worker reports its own failures; one bad link must not stop the rest
      }
    }
  })
  await Promise.all(lanes)
}
