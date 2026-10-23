// Real yt-dlp, real ffmpeg, real network. Skipped unless you point it at the binaries:
//   YT_DLP=/path/to/yt-dlp FFMPEG=/path/to/ffmpeg yarn test
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createYoink } from "@marknotton/yoink-core"
import { createNodeRunner } from "../dist/index.js"

const { YT_DLP, FFMPEG } = process.env
const skip = !YT_DLP || !FFMPEG ? "set YT_DLP and FFMPEG to run the real-download test" : false
const ZOO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"

test("headless: a batch of one link, as audio and as the best video, with the real tools", { skip, timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoink-it-"))
  const runner = createNodeRunner({ ytDlp: YT_DLP, ffmpeg: FFMPEG, env: {} }) // empty env: nothing from PATH
  const yoink = createYoink({ runner, outputDir: dir })
  try {
    const probe = await yoink.probe(ZOO)
    assert.equal(probe.title, "Me at the zoo")

    await yoink.batch(ZOO, { quality: "audio" }).done
    const mp3 = yoink.getJobs()[0]
    assert.equal(mp3.status, "done", JSON.stringify(mp3.error))
    assert.ok(mp3.filepath.startsWith(dir) && mp3.filepath.endsWith(".mp3"))
    assert.ok(fs.statSync(mp3.filepath).size > 100_000, "a real mp3 was written")

    yoink.clearFinished()
    await yoink.batch(ZOO, { quality: "best" }).done
    const mp4 = yoink.getJobs()[0]
    assert.equal(mp4.status, "done", JSON.stringify(mp4.error))
    assert.ok(mp4.filepath.endsWith(".mp4") && fs.statSync(mp4.filepath).size > 100_000)

    const leftovers = fs.readdirSync(dir).filter((f) => /\.(part|ytdl|f\d+\..+)$/.test(f))
    assert.deepEqual(leftovers, [], "no half-finished pieces left behind")
  } finally {
    await runner.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
