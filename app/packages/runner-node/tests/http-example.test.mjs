// The HTTP example, run for real as a child process against the fake yt-dlp.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("the HTTP example: batch, SSE events, jobs, errors with codes, token protection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoink-http-"))
  const port = 8800 + Math.floor(Math.random() * 100)
  const child = spawn(process.execPath, [here("../examples/http-server.mjs")], {
    env: { ...process.env, YT_DLP: here("./fake-ytdlp.mjs"), FAKE_MODE: "replay:download-video.json", OUT_DIR: dir, COOKIES: path.join(dir, "c.txt"), PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  })
  const stopEvents = new AbortController()
  try {
    await new Promise((resolve) => child.stdout.on("data", (d) => String(d).includes("listening") && resolve()))
    const base = `http://127.0.0.1:${port}`
    const post = (p, body) => fetch(base + p, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))

    // live events over SSE
    const events = []
    const sse = await fetch(base + "/events", { signal: stopEvents.signal })
    ;(async () => {
      const reader = sse.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const m of String(Buffer.from(value)).matchAll(/data: (.*)\n\n/g)) events.push(JSON.parse(m[1]))
      }
    })().catch(() => {})

    const batch = await post("/batch", { text: "https://www.youtube.com/watch?v=jNQXAC9IVRw\nyoutu.be/jNQXAC9IVRw\n", quality: "best" })
    assert.equal(batch.status, 202)
    assert.equal(batch.body.jobs.length, 1)
    assert.equal(batch.body.duplicates, 1)

    for (let i = 0; i < 100; i++) {
      const jobs = await (await fetch(base + "/jobs")).json()
      if (jobs[0]?.status === "done") break
      await sleep(50)
    }
    const jobs = await (await fetch(base + "/jobs")).json()
    assert.equal(jobs[0].status, "done")
    assert.equal(jobs[0].filepath, "/OUT/Me at the zoo.mp4")
    assert.equal(events[0].type, "hello")
    assert.ok(events.some((e) => e.type === "job-done"), "progress and completion arrive as events")

    const probe = await post("/probe", { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" })
    assert.deepEqual(probe.body.choices.map((c) => c.label), ["240p", "144p", "Audio only"])
    assert.equal((await post("/download", { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", choice: 9 })).status, 400)
    assert.equal((await fetch(base + "/nope")).status, 404)
  } finally {
    stopEvents.abort() // close the live event stream, or the test process never exits
    child.kill("SIGTERM")
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the HTTP example refuses to listen on a network address without a token", async () => {
  const child = spawn(process.execPath, [here("../examples/http-server.mjs")], { env: { ...process.env, YT_DLP: "/x", HOST: "0.0.0.0" }, stdio: ["ignore", "ignore", "pipe"] })
  let err = ""
  child.stderr.on("data", (d) => (err += d))
  const code = await new Promise((r) => child.on("close", r))
  assert.notEqual(code, 0)
  assert.match(err, /without a TOKEN/)
})
