#!/usr/bin/env node
// A stand-in for yt-dlp, controlled by FAKE_MODE, so the runner can be tested without the network.
import fs from "node:fs"
import { fileURLToPath } from "node:url"
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE ?? "echo"
const fixtures = fileURLToPath(new URL("../../core/tests/fixtures/", import.meta.url))
const out = (s) => process.stdout.write(s + "\n")

if (mode === "echo") {
  out(JSON.stringify(args))
} else if (mode === "cookies") {
  const i = args.indexOf("--cookies")
  out(JSON.stringify({ path: i >= 0 ? args[i + 1] : null, exists: i >= 0 && fs.existsSync(args[i + 1]), first: i >= 0 ? fs.readFileSync(args[i + 1], "utf8").split("\n")[1] : null }))
} else if (mode === "long") {
  out("x".repeat(500_000)) // one enormous line, like a lookup's JSON
  process.stderr.write("ERROR: [youtube] abc: boom\n")
  process.exitCode = 3 // not process.exit(): that would drop whatever hasn't flushed from the pipe yet
} else if (mode === "sleep") {
  process.on("SIGTERM", () => { out("got SIGTERM"); process.exit(143) })
  out("started")
  setTimeout(() => {}, 30_000)
} else if (mode.startsWith("replay:")) {
  const recorded = JSON.parse(fs.readFileSync(fixtures + mode.slice(7), "utf8"))
  if (args.includes("-J")) out(JSON.stringify(JSON.parse(fs.readFileSync(fixtures + "probe-zoo.json", "utf8"))))
  else for (const line of recorded.stdout) out(line)
}
