import { test } from "node:test"
import assert from "node:assert/strict"
import { createYoink, memoryStorage, SITES } from "../dist/index.js"
import { fakeRunner, fixture, sleep, zooScript } from "./helpers.mjs"

const ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
const REDDIT = "https://www.reddit.com/r/singularity/comments/1xd5von/claude_made_a_documentary_about_life_after_the/"
const reddit = SITES.find((s) => s.id === "reddit")

const make = (runner, extra = {}) => createYoink({ runner, outputDir: "/Downloads", ...extra })
const eventsOf = (yoink) => {
  const seen = []
  yoink.subscribe((e) => seen.push(e))
  return seen
}

test("looking a link up gives choices, and a second look uses the cache", async () => {
  const runner = fakeRunner(zooScript())
  const yoink = make(runner)
  const first = await yoink.probe(ZOO)
  assert.equal(first.title, "Me at the zoo")
  assert.deepEqual(first.choices.map((c) => c.label), ["240p", "144p", "Audio only"])
  assert.equal(first.fromCache, undefined)
  assert.equal(first.login, false)
  const second = await yoink.probe(ZOO)
  assert.equal(second.fromCache, true)
  assert.equal(runner.calls.length, 1, "yt-dlp ran once")
  await yoink.probe(ZOO, { refresh: true })
  assert.equal(runner.calls.length, 2, "refresh goes back to yt-dlp")
})

test("a download reports progress, then finishes with the file's path", async () => {
  const runner = fakeRunner(zooScript())
  const downloaded = []
  const yoink = make(runner, { onDownloaded: (job) => downloaded.push(job.filepath) })
  const events = eventsOf(yoink)
  const probe = await yoink.probe(ZOO)
  const job = yoink.download(probe, probe.choices[0])
  assert.equal(job.status, "running")
  assert.equal(job.label, "240p")
  await yoink.idle()
  const done = yoink.getJobs()[0]
  assert.equal(done.status, "done")
  assert.equal(done.filepath, "/OUT/Me at the zoo.mp4")
  assert.deepEqual(downloaded, ["/OUT/Me at the zoo.mp4"], "onDownloaded ran")
  const progress = events.filter((e) => e.type === "job-updated" && e.job.progress).map((e) => e.job.progress)
  assert.ok(progress.length >= 20)
  assert.ok(events.some((e) => e.type === "job-updated" && e.job.processing), "'processing' was reported while ffmpeg merged")
  assert.ok(events.some((e) => e.type === "job-done"))
  // the command the runner was given
  const args = runner.calls.at(-1).args
  assert.equal(args.at(-1), "/Downloads/%(title).60s.%(ext)s")
  assert.equal(runner.calls.at(-1).login, false)
})

test("a lookup the runner can save is reused, so the download starts without re-extracting", async () => {
  const runner = fakeRunner(zooScript(), { storeInfo: async () => "/tmp/info-1.json" })
  const yoink = make(runner)
  const probe = await yoink.probe(ZOO)
  assert.equal(probe.infoRef, "/tmp/info-1.json")
  yoink.download(probe, probe.choices[2])
  await yoink.idle()
  assert.deepEqual(runner.calls.at(-1).args.slice(0, 2), ["--load-info-json", "/tmp/info-1.json"])
})

test("if the saved lookup has gone stale, it downloads again with a fresh extraction", async () => {
  const video = fixture("download-video.json")
  const probeJson = JSON.stringify(fixture("probe-zoo.json"))
  const runner = fakeRunner(
    (req) => {
      if (req.args.includes("-J")) return { stdout: [probeJson] }
      if (req.args.includes("--load-info-json")) return { stdout: [], stderr: ["ERROR: [youtube] x: HTTP Error 403: Forbidden"], exitCode: 1 }
      return { stdout: video.stdout }
    },
    { storeInfo: async () => "/tmp/stale.json" },
  )
  const yoink = make(runner)
  const events = eventsOf(yoink)
  const probe = await yoink.probe(ZOO)
  yoink.download(probe, probe.choices[0])
  await yoink.idle()
  assert.equal(yoink.getJobs()[0].status, "done")
  assert.ok(events.some((e) => e.type === "job-updated" && e.job.refreshing), "the UI could say 'grabbing a fresh one'")
  const downloads = runner.calls.filter((c) => !c.args.includes("-J"))
  assert.equal(downloads.length, 2)
  assert.ok(downloads[0].args.includes("--load-info-json"))
  assert.ok(!downloads[1].args.includes("--load-info-json"))
})

test("errors carry a code a UI can render its own words for", async () => {
  const needs = fixture("error-needs-login.json")
  const gone = fixture("error-unavailable.json")
  const runner = fakeRunner((req) => {
    if (req.args.includes("https://www.youtube.com/watch?v=aaaaaaaaaaa")) return { ...gone, stdout: [] }
    return { ...needs, stdout: [] }
  })
  const yoink = make(runner)
  await assert.rejects(yoink.probe(REDDIT), (e) => {
    assert.equal(e.code, "NEEDS_LOGIN")
    assert.equal(e.site.id, "reddit", "which sign-in would unlock it")
    assert.equal(e.hadLogin, false)
    return true
  })
  await assert.rejects(yoink.probe("https://www.youtube.com/watch?v=aaaaaaaaaaa"), (e) => e.code === "UNAVAILABLE" && e.message === "This video is unavailable")
})

test("a site that wants a login is retried with the saved sign-in, and only then", async () => {
  const needs = fixture("error-needs-login.json")
  const runner = fakeRunner((req) => (req.login ? zooScript()(req) : { ...needs, stdout: [] }))
  const authenticator = { signIn: async () => {}, signOut: async () => {} }
  const yoink = make(runner, { authenticator, storage: memoryStorage() })

  await assert.rejects(yoink.probe(REDDIT), (e) => e.code === "NEEDS_LOGIN", "nothing saved yet")
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].login, false)

  await yoink.signIn(reddit)
  assert.deepEqual(yoink.signedIn(), ["reddit"])
  const probe = await yoink.probe(REDDIT)
  assert.equal(probe.login, true)
  assert.deepEqual(runner.calls.slice(1).map((c) => c.login), [false, true], "anonymous first, then with the login")
  yoink.download(probe, probe.choices[0])
  await yoink.idle()
  assert.equal(runner.calls.at(-1).login, true, "the download uses it too")
})

test("YouTube doesn't get your Reddit login just because you have one", async () => {
  const runner = fakeRunner(zooScript())
  const yoink = make(runner, { authenticator: { signIn: async () => {}, signOut: async () => {} } })
  await yoink.signIn(reddit)
  await yoink.probe(ZOO)
  assert.deepEqual(runner.calls.map((c) => c.login), [false], "an ordinary link is looked up anonymously")
})

test("signing in retries every job that was refused for lack of it", async () => {
  const needs = fixture("error-needs-login.json")
  const runner = fakeRunner((req) => (req.login ? zooScript()(req) : { ...needs, stdout: [] }))
  const yoink = make(runner, { authenticator: { signIn: async () => {}, signOut: async () => {} } })
  const batch = yoink.batch(`${REDDIT}\nhttps://www.reddit.com/r/x/comments/2/y/`)
  await batch.done
  assert.deepEqual(yoink.getJobs().map((j) => j.error?.code), ["NEEDS_LOGIN", "NEEDS_LOGIN"])
  await yoink.signIn(reddit)
  await yoink.idle()
  assert.deepEqual(yoink.getJobs().map((j) => j.status), ["done", "done"])
})

test("a batch finds every link, skips duplicates, and runs a few at a time", async () => {
  const runner = fakeRunner(zooScript({ delay: 1 }))
  const yoink = make(runner, { concurrency: 2 })
  const text = `my list:\n${ZOO}\nyoutu.be/jNQXAC9IVRw\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://example.com/a\nhttps://example.com/b\n`
  const { jobs, duplicates, done } = yoink.batch(text)
  assert.equal(jobs.length, 4)
  assert.equal(duplicates, 1)
  assert.ok(jobs.every((j) => j.status === "queued"))
  await done
  assert.ok(runner.peak <= 2, `at most 2 at once (saw ${runner.peak})`)
  assert.equal(yoink.getJobs().filter((j) => j.status === "done").length, 4)
  assert.deepEqual(yoink.getJobs().map((j) => j.url).slice(0, 2), jobs.slice(0, 2).map((j) => j.url), "pasted order is kept")
})

test("a batch's audio option picks the audio row for every link", async () => {
  const runner = fakeRunner(zooScript())
  const yoink = make(runner)
  await yoink.batch(ZOO, { quality: "audio" }).done
  const job = yoink.getJobs()[0]
  assert.equal(job.kind, "audio")
  assert.equal(job.label, "Audio · mp3")
  assert.equal(job.filepath, "/OUT/Me at the zoo.mp3")
})

test("one failing link never stops the rest", async () => {
  const gone = fixture("error-unavailable.json")
  const runner = fakeRunner((req) => (req.args.includes("-J") && req.args.includes("https://example.com/bad") ? { ...gone, stdout: [] } : zooScript()(req)))
  const yoink = make(runner)
  await yoink.batch(`${ZOO}\nhttps://example.com/bad\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ`).done
  const byUrl = Object.fromEntries(yoink.getJobs().map((j) => [j.url, j]))
  assert.equal(byUrl["https://example.com/bad"].status, "error")
  assert.equal(byUrl["https://example.com/bad"].error.code, "UNAVAILABLE")
  assert.equal(byUrl[ZOO].status, "done")
  yoink.retry(byUrl["https://example.com/bad"].id) // a retry starts from the lookup again
  await yoink.idle()
})

test("cancelling stops the run, removes the job, and deletes partial files", async () => {
  let release
  const hang = new Promise((r) => (release = r))
  const removed = []
  const video = fixture("download-video.json")
  const runner = fakeRunner(
    (req) => (req.args.includes("-J") ? { stdout: [JSON.stringify(fixture("probe-zoo.json"))] } : { stdout: video.stdout.slice(0, 8), hang }),
    { removeFiles: async (paths) => removed.push(...paths) },
  )
  const yoink = make(runner)
  const probe = await yoink.probe(ZOO)
  const job = yoink.download(probe, probe.choices[0])
  await sleep(10)
  await yoink.cancel(job.id)
  release()
  await sleep(10)
  assert.deepEqual(runner.cancelled, [job.id])
  assert.equal(yoink.getJobs().length, 0, "removed from the list")
  assert.ok(removed.includes("/OUT/Me at the zoo.f133.mp4") && removed.includes("/OUT/Me at the zoo.f133.mp4.part"))
})

test("the host decides: which format a batch picks, and where files go", async () => {
  const runner = fakeRunner(zooScript())
  const yoink = make(runner, {
    policy: {
      chooseFormat: (choices) => choices.find((c) => c.label === "144p"),
      outputTemplate: ({ title }) => `/nas/${title.toLowerCase().replace(/\W+/g, "-")}/%(title).60s.%(ext)s`,
    },
  })
  await yoink.batch(ZOO).done
  assert.equal(yoink.getJobs()[0].label, "144p")
  assert.equal(runner.calls.at(-1).args.at(-1), "/nas/me-at-the-zoo/%(title).60s.%(ext)s")
})

test("sign-ins are remembered between sessions", async () => {
  const storage = memoryStorage()
  const auth = { signIn: async () => {}, signOut: async () => {} }
  const a = make(fakeRunner(zooScript()), { storage, authenticator: auth })
  await a.signIn(reddit)
  const b = make(fakeRunner(zooScript()), { storage, authenticator: auth })
  await b.ready
  assert.deepEqual(b.signedIn(), ["reddit"])
  await b.signOut(reddit)
  assert.deepEqual(b.signedIn(), [])
})

test("signing in without an authenticator says so plainly", async () => {
  const yoink = make(fakeRunner(zooScript()))
  await assert.rejects(yoink.signIn(reddit), /isn't available/)
})
