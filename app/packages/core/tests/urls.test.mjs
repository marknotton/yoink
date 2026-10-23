import { test } from "node:test"
import assert from "node:assert/strict"
import { extractUrls, normaliseUrl, pickChoice, runPool, MAX_BATCH } from "../dist/index.js"

test("pulls links out of messy text, in the order pasted, without duplicates", () => {
  const messy = `Hey, check these out!
https://www.youtube.com/watch?v=jNQXAC9IVRw&si=abc123 (the first one)
youtu.be/jNQXAC9IVRw?feature=shared  <- same video again
Also "https://youtu.be/_OBlgSz8sSM", and https://www.youtube.com/shorts/dQw4w9WgXcQ.
www.tiktok.com/@scout2015/video/6718335390845095173?utm_source=x
https://x.com/user/status/123456789?s=20.
not a link, just words. file.txt is not a link either
https://youtu.be/jNQXAC9IVRw`
  const r = extractUrls(messy)
  assert.deepEqual(r.urls, [
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=_OBlgSz8sSM",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.tiktok.com/@scout2015/video/6718335390845095173",
    "https://x.com/user/status/123456789?s=20",
  ])
  assert.equal(r.duplicates, 2)
})

test("edge cases", () => {
  assert.deepEqual(extractUrls("").urls, [])
  assert.deepEqual(extractUrls("nothing here, just prose.").urls, [])
  assert.equal(normaliseUrl("https://example.com/a/?utm_campaign=z&keep=1#frag"), "https://example.com/a?keep=1")
  assert.equal(normaliseUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
  const big = extractUrls(Array.from({ length: MAX_BATCH + 25 }, (_, i) => `https://example.com/v/${i}`).join("\n"))
  assert.equal(big.urls.length, MAX_BATCH)
  assert.equal(big.truncated, true)
})

test("picks the best video, or the audio row, for a batch", () => {
  const choices = [{ kind: "video", label: "2160p" }, { kind: "video", label: "1080p" }, { kind: "video", label: "144p" }, { kind: "audio", label: "Audio only" }]
  assert.equal(pickChoice(choices, "best").label, "2160p")
  assert.equal(pickChoice(choices, "audio").label, "Audio only")
  assert.equal(pickChoice([{ kind: "audio", label: "Audio only" }], "best").label, "Audio only")
  assert.equal(pickChoice([], "best"), undefined)
})

test("the queue never exceeds its limit, finishes everything, and survives a failing item", async () => {
  let live = 0, peak = 0, done = 0
  await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
    live++; peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 5 + (i % 4) * 4))
    live--; done++
    if (i === 4) throw new Error("one bad link")
  })
  assert.equal(done, 12)
  assert.equal(peak, 3)
})
