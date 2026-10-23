// Re-records tests/fixtures/*.json by running a real yt-dlp. Not part of `yarn test` (it needs the network
// and the bundled binaries); run it by hand when yt-dlp's output format might have changed:
//   YT_DLP=/path/to/yt-dlp FFMPEG=/path/to/ffmpeg node tests/record-fixtures.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildChoices, downloadArgs, pickChoice, probeArgs } from "../dist/index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const YT_DLP = process.env.YT_DLP
const FFMPEG = process.env.FFMPEG
if (!YT_DLP || !FFMPEG) throw new Error("Set YT_DLP and FFMPEG to the paths of the binaries.")

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(YT_DLP, args, { env: {} })
    const out = [], err = []
    let ob = "", eb = ""
    const split = (buf, chunk, sink) => { buf += chunk; const lines = buf.split("\n"); buf = lines.pop(); lines.forEach((l) => sink.push(l)); return buf }
    child.stdout.on("data", (c) => (ob = split(ob, c, out)))
    child.stderr.on("data", (c) => (eb = split(eb, c, err)))
    child.on("close", (code) => { if (ob) out.push(ob); if (eb) err.push(eb); resolve({ code, out, err }) })
  })
}
const save = (name, data) => fs.writeFileSync(path.join(here, "fixtures", name), JSON.stringify(data, null, 2) + "\n")
const ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"

// 1. a lookup. Keep only the fields the engine reads, so the fixture stays small.
const probe = await run(probeArgs(ZOO))
const info = JSON.parse(probe.out.join("\n"))
const slim = {
  title: info.title, uploader: info.uploader, duration: info.duration,
  formats: info.formats.map(({ format_id, ext, vcodec, acodec, height, abr, tbr, filesize, filesize_approx }) => ({ format_id, ext, vcodec, acodec, height, abr, tbr, filesize, filesize_approx })),
}
save("probe-zoo.json", slim)

// 2 + 3. real downloads: a video (two streams merged by ffmpeg) and an mp3
const choices = buildChoices(slim)
for (const [name, quality] of [["download-video.json", "best"], ["download-audio.json", "audio"]]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoink-fixture-"))
  const choice = pickChoice(choices, quality)
  const args = downloadArgs({ url: ZOO, choice, outputTemplate: `${dir}/%(title).60s.%(ext)s` })
  const r = await run([...args, "--ffmpeg-location", FFMPEG])
  const scrub = (s) => s.split(dir).join("/OUT")
  save(name, { choice: choice.label, exitCode: r.code, stdout: r.out.map(scrub), stderr: r.err.map(scrub) })
  fs.rmSync(dir, { recursive: true, force: true })
}

// 4 + 5. the real errors
const reddit = await run(probeArgs("https://www.reddit.com/r/singularity/comments/1xd5von/claude_made_a_documentary_about_life_after_the/"))
save("error-needs-login.json", { exitCode: reddit.code, stderr: reddit.err })
const gone = await run(probeArgs("https://www.youtube.com/watch?v=aaaaaaaaaaa"))
save("error-unavailable.json", { exitCode: gone.code, stderr: gone.err })
console.log("recorded fixtures in", path.join(here, "fixtures"))
