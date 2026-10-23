import fs from "node:fs"
import { fileURLToPath } from "node:url"

export const fixture = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A Runner that replays what a real yt-dlp printed. `script(request)` returns
 * { stdout: string[], stderr?: string[], exitCode?: number, delay?: number }; every call is recorded.
 */
export function fakeRunner(script, extras = {}) {
  const calls = []
  const cancelled = []
  let live = 0
  const runner = {
    calls,
    cancelled,
    peak: 0,
    async run(request, handlers) {
      calls.push(request)
      live++
      runner.peak = Math.max(runner.peak, live)
      try {
        const out = await script(request, calls.length)
        for (const line of out.stdout ?? []) {
          if (out.delay) await sleep(out.delay)
          handlers.onStdout(line)
        }
        for (const line of out.stderr ?? []) handlers.onStderr(line)
        if (out.hang) await out.hang
        return { exitCode: out.exitCode ?? 0, cancelled: cancelled.includes(request.runId) }
      } finally {
        live--
      }
    },
    async cancel(runId) {
      cancelled.push(runId)
    },
    ...extras,
  }
  return runner
}

/** The usual script: a lookup returns the recorded JSON; a download replays the recorded output. */
export function zooScript({ delay = 0 } = {}) {
  const probe = fixture("probe-zoo.json")
  const video = fixture("download-video.json")
  const audio = fixture("download-audio.json")
  return (request) => {
    if (request.args.includes("-J")) return { stdout: [JSON.stringify(probe)], delay }
    const isAudio = request.args.includes("--audio-format")
    const recorded = isAudio ? audio : video
    return { stdout: recorded.stdout, exitCode: recorded.exitCode, delay }
  }
}
