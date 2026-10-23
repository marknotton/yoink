import { test } from "node:test"
import assert from "node:assert/strict"
import { cleanError, DownloadTracker, looksUnavailable, needsLogin, partialsOf } from "../dist/index.js"
import { fixture } from "./helpers.mjs"

function replay(name) {
  const tracker = new DownloadTracker()
  const events = []
  for (const line of fixture(name).stdout) {
    const e = tracker.feed(line)
    if (e) events.push(e)
  }
  return { tracker, events }
}

test("a video downloaded as two streams: progress, a part change, then processing", () => {
  const { tracker, events } = replay("download-video.json")
  const progress = events.filter((e) => e.type === "progress").map((e) => e.progress)
  assert.equal(progress.length, 20, "10 progress lines per stream")
  assert.ok(progress.every((p) => p.totalParts === 2), "yt-dlp announced 133+140, so two parts")
  assert.equal(progress[0].part, 0)
  assert.equal(progress.at(-1).part, 1, "the byte counter dropped back, so it's now the second stream")
  assert.equal(progress[0].totalBytes, 433081)
  assert.equal(progress[0].speed, undefined, "NA means unknown")
  assert.equal(progress[1].eta, 0)
  assert.equal(events.at(-1).type, "processing", "ffmpeg's [Merger] line comes last")
  assert.equal(tracker.filepath, "/OUT/Me at the zoo.mp4")
})

test("it remembers every file written, for cleaning up after a cancel", () => {
  const { tracker } = replay("download-video.json")
  assert.deepEqual(tracker.destinations, ["/OUT/Me at the zoo.f133.mp4", "/OUT/Me at the zoo.f140.m4a", "/OUT/Me at the zoo.mp4"])
  assert.deepEqual(partialsOf("/OUT/a.mp4"), ["/OUT/a.mp4", "/OUT/a.mp4.part", "/OUT/a.mp4.ytdl"])
})

test("an mp3 extraction: one part, then processing, and the mp3 is the final file", () => {
  const { tracker, events } = replay("download-audio.json")
  const progress = events.filter((e) => e.type === "progress").map((e) => e.progress)
  assert.ok(progress.every((p) => p.totalParts === 1 && p.part === 0))
  assert.equal(events.filter((e) => e.type === "processing").length, 1)
  assert.equal(tracker.filepath, "/OUT/Me at the zoo.mp3")
  assert.ok(tracker.destinations.includes("/OUT/Me at the zoo.mp3"))
})

test("lines that mean nothing to a UI produce no event", () => {
  const t = new DownloadTracker()
  assert.equal(t.feed(""), undefined)
  assert.equal(t.feed("[youtube] abc: Downloading webpage"), undefined)
  assert.equal(t.feed("Deleting original file /OUT/x.webm (pass -k to keep)"), undefined)
  assert.equal(t.filepath, "", "nothing printed a final path yet")
})

test("Windows-style absolute paths count as the final file too", () => {
  const t = new DownloadTracker()
  t.feed("C:\\Users\\me\\Downloads\\clip.mp4")
  assert.equal(t.filepath, "C:\\Users\\me\\Downloads\\clip.mp4")
})

test("real error output is cleaned and classified", () => {
  const login = fixture("error-needs-login.json").stderr.join("\n")
  assert.match(cleanError(login), /^Account authentication is required\./)
  assert.ok(needsLogin(cleanError(login)))
  const gone = fixture("error-unavailable.json").stderr.join("\n")
  assert.equal(cleanError(gone), "This video is unavailable")
  assert.ok(looksUnavailable(cleanError(gone)))
  assert.ok(!needsLogin(cleanError(gone)))
  assert.equal(cleanError("WARNING: something\nsome other output"), "")
  assert.equal(cleanError("ERROR: Unsupported URL: https://example.com/x"), "Unsupported URL: https://example.com/x", "no tag, so nothing is stripped")
  assert.equal(cleanError("ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found"), "Unable to download webpage: HTTP Error 404: Not Found")
})
