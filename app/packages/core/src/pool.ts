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
