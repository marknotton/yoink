// The engine driving a real child process through the Node runner. Only yt-dlp itself is replaced.
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createYoink } from "@marknotton/yoink-core"
import { createNodeRunner } from "../dist/index.js"

const FAKE = fileURLToPath(new URL("./fake-ytdlp.mjs", import.meta.url))

test("engine + node runner: look a link up and download it, end to end", async () => {
  const runner = createNodeRunner({ ytDlp: FAKE, env: { ...process.env, FAKE_MODE: "replay:download-video.json" } })
  const yoink = createYoink({ runner, outputDir: "/Downloads" })
  const probe = await yoink.probe("https://www.youtube.com/watch?v=jNQXAC9IVRw")
  assert.deepEqual(probe.choices.map((c) => c.label), ["240p", "144p", "Audio only"])
  assert.ok(probe.infoRef, "the node runner saves the lookup for the download to reuse")
  const events = []
  yoink.subscribe((e) => events.push(e.type))
  yoink.download(probe, probe.choices[0])
  await yoink.idle()
  const job = yoink.getJobs()[0]
  assert.equal(job.status, "done")
  assert.equal(job.filepath, "/OUT/Me at the zoo.mp4")
  assert.ok(events.includes("job-done"))
  await runner.dispose()
})
