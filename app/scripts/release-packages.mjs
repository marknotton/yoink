#!/usr/bin/env node
// Publish the shared packages (@marknotton/yoink-core and -runner-node) as installable tarballs on a GitHub Release.
//
//   node scripts/release-packages.mjs [--dry-run] [--notes="..."]
//
// The version comes from packages/*/package.json (bump it there first). The tag is `packages-v<core version>`.
//
// !! The release is created with --latest=false, ON PURPOSE. The Yoink APP's updater reads
// !! /releases/latest/download/latest.json. If a package release ever became "Latest", that URL would stop
// !! returning latest.json and no installed app would ever find an update again.
//
// Consumers install from the tarball URLs (see packages/core/README.md), or from npm if you also run
//   yarn workspace @marknotton/yoink-core npm publish --access public   (and the same for runner-node)
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const argv = process.argv.slice(2)
const DRY = argv.includes("--dry-run")
const notes = argv.find((a) => a.startsWith("--notes="))?.slice(8)

const fail = (m) => (console.error(`\n✗ ${m}\n`), process.exit(1))
const step = (m) => console.log(`\n▸ ${m}`)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...opts }).trim()
const mutate = (cmd, args) => {
  console.log(`  $ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`)
  if (!DRY) execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" })
}

const pkg = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf8"))
const core = pkg("core")
const runnerNode = pkg("runner-node")
const REPO = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).githubRepo
const tag = `packages-v${core.version}`
console.log(`Packages ${core.name}@${core.version} + ${runnerNode.name}@${runnerNode.version}  →  ${REPO} ${tag}${DRY ? "  DRY RUN" : ""}`)

step("Preflight")
const ghUser = run("gh", ["api", "user", "-q", ".login"])
if (ghUser.toLowerCase() !== REPO.split("/")[0].toLowerCase()) fail(`The active GitHub account is “${ghUser}”, but ${REPO} belongs to “${REPO.split("/")[0]}”. Switch with: gh auth switch --user ${REPO.split("/")[0]}`)
console.log(`  releasing as ${ghUser}`)
try {
  run("gh", ["release", "view", tag, "--repo", REPO])
  fail(`${tag} already exists. Bump the version in packages/core/package.json (and runner-node's peer range if needed).`)
} catch (e) {
  if (e.status === undefined) throw e // our own fail() exited; anything else means "not found", which is what we want
}
if (!DRY && run("git", ["status", "--porcelain", "--untracked-files=no"])) fail("Commit your changes first, so the tag matches what was packed.")

step("Build and test")
for (const dir of ["core", "runner-node"]) {
  mutate("yarn", ["workspace", `@marknotton/yoink-${dir}`, "test"])
}

step("Pack")
const out = path.join(ROOT, "release-staging", "packages")
if (!DRY) (fs.rmSync(out, { recursive: true, force: true }), fs.mkdirSync(out, { recursive: true }))
const files = [`yoink-core-${core.version}.tgz`, `yoink-runner-node-${runnerNode.version}.tgz`].map((f) => path.join(out, f))
mutate("yarn", ["workspace", core.name, "pack", "--out", files[0]])
mutate("yarn", ["workspace", runnerNode.name, "pack", "--out", files[1]])

step("Prove they install into an empty project (npm) and import")
if (!DRY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoink-pack-check-"))
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"check","private":true,"type":"module"}')
  execFileSync("npm", ["install", "--no-audit", "--no-fund", ...files], { cwd: dir, stdio: "pipe" })
  const result = execFileSync(
    process.execPath,
    ["-e", 'Promise.all([import("@marknotton/yoink-core"), import("@marknotton/yoink-runner-node")]).then(([c, r]) => console.log(typeof c.createYoink, typeof r.createNodeRunner))'],
    { cwd: dir, encoding: "utf8" },
  ).trim()
  if (result !== "function function") fail(`The packed packages didn't import correctly (got "${result}").`)
  console.log("  ✓ installed with npm and imported")
  fs.rmSync(dir, { recursive: true, force: true })
}

step("Publish (as a NON-latest release, so app updates keep working)")
const body =
  notes ??
  `Installable packages for building your own app on Yoink's engine.\n\n- ${core.name}@${core.version}\n- ${runnerNode.name}@${runnerNode.version}\n\nInstall both from these files (see packages/core/README.md).`
mutate("gh", ["release", "create", tag, "--repo", REPO, "--title", `Packages ${core.version}`, "--notes", body, "--latest=false", ...(DRY ? [] : files)])

// belt and braces: the app's update manifest must still be what /releases/latest serves
if (!DRY) {
  const latest = JSON.parse(run("gh", ["release", "view", "--repo", REPO, "--json", "tagName", "-q", "."]))
  if (latest.tagName === tag) fail(`${tag} became the repo's Latest release. That breaks app updates. Fix it now: gh release edit <app tag> --latest --repo ${REPO}`)
  console.log(`  ✓ Latest is still ${latest.tagName} (the app's update manifest is untouched)`)
}

const base = `https://github.com/${REPO}/releases/download/${tag}`
console.log(`\n✓ ${DRY ? "Dry run complete. Nothing was published." : `Published ${tag}`}\n  yarn add ${base}/yoink-core-${core.version}.tgz ${base}/yoink-runner-node-${runnerNode.version}.tgz`)
