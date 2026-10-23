import { test } from "node:test"
import assert from "node:assert/strict"
import { buildManifest } from "../scripts/lib/manifest.mjs"

test("a single-platform release keeps the other platform, with its own version", () => {
  const A = buildManifest({
    previous: null, version: "1.3.0", notes: "A", pubDate: "x",
    built: { "darwin-aarch64": { installerUrl: "dmg130", url: "tar130", signature: "sig130", size: 1 }, "android-arm64": { installerUrl: "apk130", size: 2 } },
  })
  const B = buildManifest({ previous: A, version: "1.4.0", notes: "B", pubDate: "y", built: { "darwin-aarch64": { installerUrl: "dmg140", url: "tar140", signature: "sig140", size: 3 } } })
  assert.equal(B.version, "1.4.0")
  assert.equal(B.platforms["darwin-aarch64"].version, "1.4.0")
  assert.equal(B.platforms["android-arm64"].version, "1.3.0")
  assert.equal(B.platforms["android-arm64"].installerUrl, "apk130")
})

test("carried-forward desktop entries lose their updater url and signature", () => {
  const A = buildManifest({ previous: null, version: "1.3.0", notes: "", pubDate: "", built: { "darwin-aarch64": { installerUrl: "dmg", url: "tar", signature: "sig" } } })
  const C = buildManifest({ previous: A, version: "1.4.1", notes: "", pubDate: "", built: { "android-arm64": { installerUrl: "apk" } } })
  assert.equal(C.platforms["darwin-aarch64"].installerUrl, "dmg")
  assert.equal("url" in C.platforms["darwin-aarch64"], false)
  assert.equal("signature" in C.platforms["darwin-aarch64"], false)
  assert.equal(A.platforms["darwin-aarch64"].url, "tar", "inputs are not mutated")
})

test("versions compare numerically", async () => {
  // isNewerVersion lives in updates.ts alongside code that needs the browser, so lift just that function
  const { default: fs } = await import("node:fs")
  const src = fs.readFileSync(new URL("../src/lib/updates.ts", import.meta.url), "utf8")
  const fn = src.slice(src.indexOf("export function isNewerVersion"), src.indexOf("// GitHub's release CDN")).replace("export function", "function")
  const ts = (await import("typescript")).default
  const isNewerVersion = new Function(`${ts.transpileModule(fn, { compilerOptions: { target: "ES2020" } }).outputText}; return isNewerVersion`)()
  for (const [a, b, want] of [["1.10.0", "1.9.0", true], ["1.9.0", "1.10.0", false], ["1.4.0", "1.4.0", false], ["v1.4.1", "1.4.0", true], ["2.0.0", "1.99.99", true], ["1.4", "1.4.0", false]]) {
    assert.equal(isNewerVersion(a, b), want, `${a} vs ${b}`)
  }
})
