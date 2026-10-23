import { test } from "node:test"
import assert from "node:assert/strict"
import { buildChoices, downloadArgs, pickChoice, probeArgs } from "../dist/index.js"
import { fixture } from "./helpers.mjs"

const info = fixture("probe-zoo.json")

test("a real lookup becomes one row per resolution, tallest first, then audio", () => {
  const choices = buildChoices(info)
  assert.deepEqual(choices.map((c) => c.label), ["240p", "144p", "Audio only"])
  assert.deepEqual(choices.map((c) => c.kind), ["video", "video", "audio"])
  assert.match(choices[0].detail, /^mp4 · ~/, "a size is estimated")
  assert.deepEqual(choices[2].args, ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"])
})

test("video rows prefer H.264 + AAC so Apple's players can open the file", () => {
  const [best] = buildChoices(info)
  assert.ok(best.args[1].includes("vcodec^=avc1"))
  assert.ok(best.args[1].includes("ba[ext=m4a]"))
  assert.deepEqual(best.args.slice(2), ["--merge-output-format", "mp4"])
})

test("a single quality becomes 'video with audio', not a quality choice", () => {
  const one = { title: "x", duration: 10, formats: [{ format_id: "a", vcodec: "avc1", acodec: "none", height: 360, tbr: 800 }, { format_id: "b", vcodec: "none", acodec: "mp4a", ext: "m4a", abr: 128 }] }
  const choices = buildChoices(one)
  assert.deepEqual(choices.map((c) => c.label), ["Video with audio", "Audio only"])
  assert.match(choices[0].detail, /^360p · mp4/)
})

test("a site with nothing but audio, or nothing at all, still gets sensible rows", () => {
  assert.deepEqual(buildChoices({ title: "x" }).map((c) => c.label), ["Video with audio", "Audio only"])
})

test("an unknown size is left out rather than faked", () => {
  const noSize = { title: "x", formats: [{ format_id: "a", vcodec: "avc1", acodec: "mp4a", height: 720 }] }
  assert.equal(buildChoices(noSize)[0].detail, "720p · mp4")
})

test("batch picking: the tallest video, or the audio row", () => {
  const choices = buildChoices(info)
  assert.equal(pickChoice(choices, "best").label, "240p")
  assert.equal(pickChoice(choices, "audio").label, "Audio only")
})

test("the command lines", () => {
  assert.deepEqual(probeArgs("https://x/y"), ["-J", "--no-playlist", "--no-warnings", "https://x/y"])
  const choice = buildChoices(info)[0]
  const args = downloadArgs({ url: "https://x/y", choice, outputTemplate: "/out/%(title).60s.%(ext)s" })
  assert.equal(args[0], "https://x/y", "the link, when there's no saved lookup")
  assert.ok(args.includes("--no-quiet"), "or the progress and [Merger] lines would be hidden")
  assert.deepEqual(args.slice(args.indexOf("--print"), args.indexOf("--print") + 3), ["--print", "after_move:filepath", "--no-simulate"])
  assert.equal(args.at(-1), "/out/%(title).60s.%(ext)s")
  const withInfo = downloadArgs({ url: "https://x/y", infoRef: "/tmp/info.json", choice, outputTemplate: "/o" })
  assert.deepEqual(withInfo.slice(0, 2), ["--load-info-json", "/tmp/info.json"])
  assert.ok(!withInfo.includes("https://x/y"))
})
