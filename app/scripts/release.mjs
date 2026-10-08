#!/usr/bin/env node
// Bump, build, sign, write latest.json and publish a GitHub Release.
//
//   node scripts/release.mjs [patch|minor|major|current] [--targets=mac,android]
//        [--notes="..."] [--dry-run] [--no-build] [--no-publish]
//
// GitHub Releases is the only distribution channel. latest.json, attached to
// every release, is the single source of truth every client reads.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { passwordFromEnvOrPrompt } from "./lib/prompt.mjs"
import { buildManifest } from "./lib/manifest.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TAURI_DIR = path.join(ROOT, "src-tauri")
const STAGING = path.join(ROOT, "release-staging")
const PKG = path.join(ROOT, "package.json")
const CONF = path.join(TAURI_DIR, "tauri.conf.json")
const CARGO = path.join(TAURI_DIR, "Cargo.toml")
const KEY = path.join(TAURI_DIR, "signing", "updater.key")
const KEYSTORE_PROPS = path.join(TAURI_DIR, "signing", "keystore.properties")
const TAURI = path.join(ROOT, "node_modules", ".bin", "tauri")
const TARGET = process.env.CARGO_TARGET_DIR ?? path.join(TAURI_DIR, "target")

// ── Args ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const bump = argv.find((a) => !a.startsWith("--")) ?? "patch"
const targets = (option("targets") ?? "mac,android").split(",").map((t) => t.trim())
const DRY = flag("dry-run")
const NO_BUILD = flag("no-build")
const NO_PUBLISH = flag("no-publish")

const fail = (message) => {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}
// a dry run should still show the plan before any keys exist
const needs = (message) => (DRY ? console.warn(`  ⚠ (dry run) ${message}`) : fail(message))
const step = (message) => console.log(`\n▸ ${message}`)
const read = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...opts }).trim()
// anything that changes the world goes through here, so --dry-run can show it instead
const mutate = (cmd, args, opts = {}) => {
  console.log(`  $ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`)
  if (DRY) return
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts })
}

if (!["patch", "minor", "major", "current"].includes(bump)) fail(`Unknown bump “${bump}”. Use patch, minor, major or current.`)
for (const t of targets) if (!["mac", "android"].includes(t)) fail(`Unknown target “${t}”. Use mac and/or android.`)

const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"))
const REPO = pkg.githubRepo
if (!REPO) fail("package.json needs a githubRepo field, e.g. owner/repo.")
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`

function nextVersion(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!m) fail(`Can't parse version “${current}”.`)
  let [maj, min, pat] = m.slice(1).map(Number)
  if (bump === "major") [maj, min, pat] = [maj + 1, 0, 0]
  else if (bump === "minor") [min, pat] = [min + 1, 0]
  else if (bump === "patch") pat += 1
  return `${maj}.${min}.${pat}`
}
const version = nextVersion(pkg.version)
// Prefixed because this repo is a fork: Pablo's original tags (v0.1.1, v0.2.0, v0.3.x…)
// come along with it, and a plain vX.Y.Z would collide with them.
const tag = `app-v${version}`

// ── Platform keys ────────────────────────────────────────────────
const hostTriple = read("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1] ?? ""
const macArch = hostTriple.startsWith("aarch64") ? "aarch64" : "x86_64"
const MAC_KEY = `darwin-${macArch}`
const ANDROID_KEY = "android-arm64"

console.log(`Yoink ${pkg.version} → ${version}  (${tag})  [${targets.join(", ")}]${DRY ? "  DRY RUN" : ""}${NO_PUBLISH ? "  NO PUBLISH" : ""}`)

// ── Preflight: fail in seconds, not after a ten-minute build ─────
step("Preflight")
const wantsMac = targets.includes("mac")
const wantsAndroid = targets.includes("android")

let ghUser = ""
try {
  ghUser = read("gh", ["api", "user", "-q", ".login"])
} catch {
  fail("The GitHub CLI isn't signed in. Run: gh auth login")
}
// Several accounts can be signed in at once, but only the active one publishes.
// Releasing from the wrong one is easy to do and annoying to undo.
const owner = REPO.split("/")[0]
console.log(`  releasing as GitHub user “${ghUser}” to ${REPO}`)
if (ghUser.toLowerCase() !== owner.toLowerCase()) {
  fail(`The active GitHub account is “${ghUser}”, but ${REPO} belongs to “${owner}”.\nSwitch with: gh auth switch --user ${owner}`)
}

// The release commit only adds the version files. Anything else uncommitted
// would be missing from the tagged source, so insist on a clean tree.
if (!NO_PUBLISH && !DRY) {
  let dirty = ""
  try {
    dirty = read("git", ["status", "--porcelain", "--untracked-files=no"])
  } catch {
    // not a git checkout: nothing to protect
  }
  if (dirty) fail(`You have uncommitted changes. Commit them first, so the tag contains what you built:\n${dirty}`)
}

let releaseExists = false
try {
  read("gh", ["release", "view", tag, "--repo", REPO])
  releaseExists = true
} catch {
  // not found is what we want
}
if (releaseExists && !NO_BUILD) fail(`${tag} already exists on GitHub. Bump the version, or use --no-build to re-publish its files.`)

const conf = JSON.parse(fs.readFileSync(CONF, "utf8"))
if (conf.plugins?.updater?.endpoints?.[0] !== MANIFEST_URL) {
  fail(`tauri.conf.json's updater endpoint doesn't match ${MANIFEST_URL}`)
}

let password = ""
if (wantsMac) {
  if (!fs.existsSync(KEY)) needs("No updater key. Run once: yarn updater:keygen")
  else if (!conf.plugins?.updater?.pubkey || !conf.bundle?.createUpdaterArtifacts) needs("tauri.conf.json has no updater pubkey. Run: yarn updater:keygen")
}
if (wantsMac && fs.existsSync(KEY)) {
  password = await passwordFromEnvOrPrompt("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Updater key password (empty if none): ")

  // With a key configured, `tauri build` only finds a wrong password after
  // compiling everything. Try a real signature up front instead.
  const probe = path.join(os.tmpdir(), `yoink-sign-probe-${process.pid}`)
  fs.writeFileSync(probe, "probe")
  const signed = spawnSync(TAURI, ["signer", "sign", "-f", KEY, "-p", password, probe], { encoding: "utf8" })
  fs.rmSync(probe, { force: true })
  fs.rmSync(`${probe}.sig`, { force: true })
  if (signed.status !== 0) {
    fail(`Couldn't sign with the updater key (wrong password?).\n${(signed.stderr || signed.stdout).trim()}\nRe-run with the right TAURI_SIGNING_PRIVATE_KEY_PASSWORD.`)
  }
  console.log("  ✓ updater key signs")
}
if (wantsAndroid) {
  if (!fs.existsSync(KEYSTORE_PROPS)) needs("No Android keystore. Run once: yarn android:keystore (an unsigned APK can't be installed).")
  else console.log("  ✓ android keystore present")
}

// A failed bundle_dmg.sh leaves its disk image mounted, and that breaks every later build.
function detachStaleImages() {
  if (process.platform !== "darwin") return
  const bundleDir = path.join(TARGET, "release", "bundle")
  let info = ""
  try {
    info = read("hdiutil", ["info"])
  } catch {
    return
  }
  for (const block of info.split(/^={10,}$/m)) {
    const image = /image-path\s*:\s*(.+)/.exec(block)?.[1]?.trim()
    if (!image?.startsWith(bundleDir)) continue
    for (const dev of new Set(block.match(/\/dev\/disk\d+(?=\s|$)/gm) ?? [])) {
      console.log(`  detaching stale disk image ${dev} (${path.basename(image)})`)
      if (!DRY) spawnSync("hdiutil", ["detach", dev, "-force"], { stdio: "ignore" })
    }
  }
}
if (wantsMac) detachStaleImages()

// ── 1. Bump the version everywhere, once ─────────────────────────
step(`Version ${version}`)
function mirrorVersion() {
  pkg.version = version
  fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`)
  conf.version = version
  fs.writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`)
  const cargo = fs.readFileSync(CARGO, "utf8")
  fs.writeFileSync(CARGO, cargo.replace(/^version = ".*"$/m, `version = "${version}"`))
}
if (bump === "current") console.log("  keeping the current version")
else if (DRY) console.log(`  would write ${version} to package.json, tauri.conf.json and Cargo.toml`)
else {
  mirrorVersion()
  console.log("  package.json, tauri.conf.json and Cargo.toml updated")
}

// ── 2. Build ─────────────────────────────────────────────────────
const buildStart = Date.now()
const buildEnv = { ...process.env }
if (wantsMac) {
  buildEnv.TAURI_SIGNING_PRIVATE_KEY = fs.existsSync(KEY) ? fs.readFileSync(KEY, "utf8") : "" // contents, not a path
  buildEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password
}
if (wantsAndroid) {
  const sdk = buildEnv.ANDROID_HOME ?? path.join(os.homedir(), "Library", "Android", "sdk")
  buildEnv.ANDROID_HOME = sdk
  if (!buildEnv.NDK_HOME) {
    const ndks = fs.existsSync(path.join(sdk, "ndk")) ? fs.readdirSync(path.join(sdk, "ndk")).sort() : []
    if (ndks.length) buildEnv.NDK_HOME = path.join(sdk, "ndk", ndks.at(-1))
  }
  if (!buildEnv.JAVA_HOME && process.platform === "darwin") {
    try {
      buildEnv.JAVA_HOME = read("/usr/libexec/java_home", ["-v", "21"])
    } catch {
      // fall through; gradle will say what it needs
    }
  }
}

if (NO_BUILD) step("Skipping build (--no-build): using the last build's files")
else {
  if (wantsMac) {
    step("Building macOS")
    mutate("bash", ["scripts/setup.sh"]) // fetch the bundled yt-dlp and ffmpeg if they aren't there yet
    mutate(TAURI, ["build"], { env: buildEnv })
  }
  if (wantsAndroid) {
    step("Building Android (arm64)")
    mutate(TAURI, ["android", "build", "--apk", "--split-per-abi", "--target", "aarch64"], { env: buildEnv })
  }
}

// ── 3. Collect artifacts under stable, space-free names ──────────
step("Staging artifacts")
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
// newest by mtime, because Tauri moves its outputs between versions
function newest(dir, test) {
  const files = walk(dir).filter(test).map((p) => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)
  const hit = files[0]
  if (hit && !NO_BUILD && !DRY && hit.t < buildStart) fail(`Found ${path.relative(ROOT, hit.p)} but it's older than this build. Did the build really produce it?`)
  return hit?.p
}

const staged = [] // files to upload
const built = {} // manifest entries
const base = `https://github.com/${REPO}/releases/download/${tag}`

if (!DRY) {
  fs.rmSync(STAGING, { recursive: true, force: true })
  fs.mkdirSync(STAGING, { recursive: true })
}
const stage = (src, name) => {
  const dest = path.join(STAGING, name)
  if (!DRY) fs.copyFileSync(src, dest)
  staged.push(dest)
  return dest
}

if (wantsMac) {
  const bundle = path.join(TARGET, "release", "bundle")
  const dmg = DRY ? "<dmg>" : newest(path.join(bundle, "dmg"), (p) => p.endsWith(".dmg"))
  const tar = DRY ? "<app.tar.gz>" : newest(path.join(bundle, "macos"), (p) => p.endsWith(".app.tar.gz"))
  if (!dmg) fail("No .dmg was produced.")
  if (!tar) fail("No .app.tar.gz was produced. Is createUpdaterArtifacts on? (yarn updater:keygen)")
  const sigPath = `${tar}.sig`
  if (!DRY && !fs.existsSync(sigPath)) console.warn("  ⚠ No .sig for the macOS build. Auto-update will NOT offer this platform until it's signed.")

  const dmgName = `Yoink_${version}_${macArch}.dmg`
  const tarName = `Yoink_${version}_${macArch}.app.tar.gz`
  stage(dmg, dmgName)
  stage(tar, tarName)
  built[MAC_KEY] = {
    label: `macOS (${macArch === "aarch64" ? "Apple Silicon" : "Intel"})`,
    installerUrl: `${base}/${dmgName}`,
    url: `${base}/${tarName}`,
    signature: !DRY && fs.existsSync(sigPath) ? fs.readFileSync(sigPath, "utf8").trim() : "<signature>",
    size: DRY ? 0 : fs.statSync(dmg).size,
  }
}

if (wantsAndroid) {
  const apkRoot = path.join(TAURI_DIR, "gen", "android", "app", "build", "outputs", "apk")
  const apk = DRY ? "<apk>" : newest(apkRoot, (p) => p.endsWith(".apk") && /arm64/.test(p) && /release/.test(p))
  if (!apk) fail("No arm64 release APK was produced.")
  if (/unsigned/.test(apk)) fail("The APK is unsigned, so Android would refuse it. Run yarn android:keystore, and check app/build.gradle.kts reads src-tauri/signing/keystore.properties.")
  const apkName = `yoink-${version}-arm64.apk`
  stage(apk, apkName)
  built[ANDROID_KEY] = {
    label: "Android (ARM64)",
    installerUrl: `${base}/${apkName}`,
    size: DRY ? 0 : fs.statSync(apk).size,
  }
}

// ── 4. latest.json, carrying forward what we didn't rebuild ──────
step("Writing latest.json")
let previous = null
try {
  const res = await fetch(MANIFEST_URL, { headers: { "Cache-Control": "no-cache" } })
  if (res.ok) previous = await res.json()
  else console.log(`  no published manifest yet (${res.status}): this will be the first`)
} catch (e) {
  console.warn(`  ⚠ couldn't fetch the published manifest (${e.message}). Platforms you aren't building now may be dropped!`)
  if (!DRY && !NO_PUBLISH) fail("Refusing to publish without knowing what to carry forward. Check your connection and retry.")
}
const notes = option("notes") ?? `Yoink ${version}`
const manifest = buildManifest({ previous, built, version, notes, pubDate: new Date().toISOString() })
const manifestPath = path.join(STAGING, "latest.json")
if (!DRY) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify(manifest, null, 2).split("\n").map((l) => `  ${l}`).join("\n"))

if (NO_PUBLISH) {
  console.log(`\n✓ Staged in ${path.relative(ROOT, STAGING)}. Nothing was published (--no-publish).`)
  process.exit(0)
}

// ── 5. Commit the bump so the tag points at it ───────────────────
step("Committing the version bump")
const top = read("git", ["rev-parse", "--show-toplevel"])
const rel = (p) => path.relative(top, p)
if (bump !== "current") {
  mutate("git", ["-C", top, "add", rel(PKG), rel(CONF), rel(CARGO), rel(path.join(TAURI_DIR, "Cargo.lock"))])
  mutate("git", ["-C", top, "commit", "-m", `Release ${tag}`])
}
mutate("git", ["-C", top, "push"])
const sha = DRY ? "<sha>" : read("git", ["-C", top, "rev-parse", "HEAD"])

// ── 6. Publish: draft → upload → manifest LAST → go live ─────────
// A draft is invisible to /releases/latest, so no client can see a manifest
// that points at a file that hasn't finished uploading.
step("Publishing")
if (releaseExists) {
  mutate("gh", ["release", "upload", tag, "--repo", REPO, "--clobber", ...staged])
  mutate("gh", ["release", "upload", tag, "--repo", REPO, "--clobber", manifestPath])
} else {
  mutate("gh", ["release", "create", tag, "--repo", REPO, "--draft", "--target", sha, "--title", `Yoink v${version}`, "--notes", notes])
  mutate("gh", ["release", "upload", tag, "--repo", REPO, ...staged])
  mutate("gh", ["release", "upload", tag, "--repo", REPO, manifestPath])
}
mutate("gh", ["release", "edit", tag, "--repo", REPO, "--draft=false", "--latest"])

console.log(`\n✓ ${DRY ? "Dry run complete. Nothing was built, written or uploaded." : `Released ${tag}`}`)
console.log(`  Release:  https://github.com/${REPO}/releases/tag/${tag}`)
console.log(`  Manifest: ${MANIFEST_URL}`)
