import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cookiesFileAuthenticator, createNodeRunner } from "../dist/index.js"

const FAKE = fileURLToPath(new URL("./fake-ytdlp.mjs", import.meta.url))
const runner = (mode, extra = {}) => createNodeRunner({ ytDlp: FAKE, env: { ...process.env, FAKE_MODE: mode }, ...extra })
const collect = () => {
  const out = [], err = []
  return { out, err, handlers: { onStdout: (l) => out.push(l), onStderr: (l) => err.push(l) } }
}
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "yoink-runner-test-"))

test("passes the arguments through, and adds ffmpeg's location and any extras", async () => {
  const c = collect()
  const r = await runner("echo", { ffmpeg: "/opt/ffmpeg", extraArgs: ["--proxy", "p"] }).run({ runId: "a", args: ["-J", "https://x"] }, c.handlers)
  assert.equal(r.exitCode, 0)
  assert.deepEqual(JSON.parse(c.out[0]), ["-J", "https://x", "--ffmpeg-location", "/opt/ffmpeg", "--proxy", "p"])
})

test("handles one enormous line, stderr, and a failing exit code", async () => {
  const c = collect()
  const r = await runner("long").run({ runId: "a", args: [] }, c.handlers)
  assert.equal(r.exitCode, 3)
  assert.equal(c.out.length, 1)
  assert.equal(c.out[0].length, 500_000)
  assert.deepEqual(c.err, ["ERROR: [youtube] abc: boom"])
})

test("cancelling sends SIGTERM and reports the run as cancelled", async () => {
  const c = collect()
  const r = runner("sleep")
  const running = r.run({ runId: "slow", args: [] }, c.handlers)
  while (c.out.length === 0) await new Promise((res) => setTimeout(res, 10))
  await r.cancel("slow")
  const result = await running
  assert.equal(result.cancelled, true)
  assert.ok(c.out.includes("got SIGTERM"), "yt-dlp was asked to stop, not killed outright, so it can clean up")
  assert.equal(result.exitCode, 143)
})

test("a login gives each run its own copy of the cookie file, and tidies it up", async () => {
  const dir = tmpdir()
  const cookiesFile = path.join(dir, "cookies.txt")
  fs.writeFileSync(cookiesFile, "# Netscape HTTP Cookie File\n.reddit.com\tTRUE\t/\tTRUE\t0\treddit_session\tabc\n")
  const r = runner("cookies", { cookiesFile })
  const [a, b] = await Promise.all(
    [1, 2].map(async (n) => {
      const c = collect()
      await r.run({ runId: `r${n}`, args: [], login: true }, c.handlers)
      return JSON.parse(c.out[0])
    }),
  )
  assert.notEqual(a.path, cookiesFile, "never the shared file")
  assert.notEqual(a.path, b.path, "and never shared between concurrent runs")
  assert.equal(a.exists, true)
  assert.match(a.first, /reddit_session/)
  assert.equal(fs.existsSync(a.path), false, "deleted afterwards")
  const c = collect()
  await r.run({ runId: "anon", args: [] }, c.handlers)
  assert.equal(JSON.parse(c.out[0]).path, null, "without login, no cookies are passed at all")
})

test("asking for a login when none is saved carries on anonymously", async () => {
  const c = collect()
  await runner("cookies", { cookiesFile: path.join(tmpdir(), "missing.txt") }).run({ runId: "a", args: [], login: true }, c.handlers)
  assert.equal(JSON.parse(c.out[0]).path, null)
})

test("saved lookups are written to a file and removed by dispose()", async () => {
  const r = runner("echo")
  const file = await r.storeInfo('{"title":"x"}')
  assert.equal(fs.readFileSync(file, "utf8"), '{"title":"x"}')
  await r.dispose()
  assert.equal(fs.existsSync(file), false)
})

test("removeFiles deletes what exists and ignores what doesn't", async () => {
  const dir = tmpdir()
  const a = path.join(dir, "a.mp4.part")
  fs.writeFileSync(a, "x")
  await runner("echo").removeFiles([a, path.join(dir, "nope")])
  assert.equal(fs.existsSync(a), false)
})

test("the cookies-file authenticator imports, finds, and forgets a site's login", async () => {
  const file = path.join(tmpdir(), "nested", "cookies.txt")
  const auth = cookiesFileAuthenticator(file)
  const reddit = { id: "reddit", label: "Reddit", domains: ["reddit.com"] }
  const x = { id: "x", label: "X", domains: ["x.com"] }
  assert.equal(await auth.has(reddit), false)

  const first = await auth.importCookies("# Netscape HTTP Cookie File\n.reddit.com\tTRUE\t/\tTRUE\t0\treddit_session\tone\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t0\tauth_token\ttwo\n")
  assert.deepEqual(first, { added: 2, domains: ["reddit.com", "x.com"] })
  assert.equal(await auth.has(reddit), true)
  assert.equal(await auth.has(x), true)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "a login is private to this user")

  await auth.importCookies(".reddit.com\tTRUE\t/\tTRUE\t0\treddit_session\tnewer\n") // replaces, doesn't duplicate
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("reddit"))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /newer/)

  await auth.signOut(reddit)
  assert.equal(await auth.has(reddit), false)
  assert.equal(await auth.has(x), true, "other sites are untouched")
  await assert.rejects(auth.signIn(reddit), /export its cookies/)
})
