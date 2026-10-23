// Display helpers. Optional: the engine itself never calls these, UIs usually want them.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

export const formatSpeed = (bps: number) => (bps > 0 ? `${formatBytes(bps)}/s` : "")
export const formatEta = (seconds: number) => formatDuration(seconds)

// "/Users/mark/Downloads" → "~/Downloads"
export const tildify = (p: string) => p.replace(/^\/Users\/[^/]+/, "~")
