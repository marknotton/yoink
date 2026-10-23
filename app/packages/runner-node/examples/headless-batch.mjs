#!/usr/bin/env node
// The smallest useful integration: read links from a file (or stdin), download the best quality of each, print progress.
//   YT_DLP=/opt/yt-dlp FFMPEG=/opt/ffmpeg node examples/headless-batch.mjs links.txt [--audio] [--out ./downloads]
import fs from "node:fs"
import { createYoink } from "@marknotton/yoink-core"
import { createNodeRunner } from "../dist/index.js"

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith("--"))
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "./downloads"
const text = fs.readFileSync(file ?? 0, "utf8") // a file, or stdin

const runner = createNodeRunner({ ytDlp: process.env.YT_DLP, ffmpeg: process.env.FFMPEG })
const yoink = createYoink({ runner, outputDir: out })

yoink.subscribe(({ type, job }) => {
  if (type === "job-done") console.log(`✓ ${job.title} → ${job.filepath}`)
  if (type === "job-error") console.log(`✗ ${job.url}: ${job.error.code} — ${job.error.message}`)
})

const { jobs, duplicates } = yoink.batch(text, { quality: args.includes("--audio") ? "audio" : "best" })
console.log(`${jobs.length} link(s) found${duplicates ? `, ${duplicates} duplicate(s) ignored` : ""}`)
await yoink.idle()
await runner.dispose()
