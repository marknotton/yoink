# Stack & Build Blueprint: cross-platform desktop + Android app

**Audience:** an AI coding agent asked to build a new tool using this exact stack and way of working.
**How to use:** follow it top to bottom. Placeholders: `<app>` (kebab-case name), `<App>` (display name), `<owner>` (GitHub user), `<repo>`, `<reverse.dns.id>` (e.g. `io.github.<owner>.<app>`). Where something is a trap, it's marked **TRAP**. Do not skip those.

The result: one TypeScript/React UI, shipped as a **macOS app** (Tauri v2, Rust) and an **Android APK** (same Tauri project, Kotlin plugin for native bits), **self-contained** (no installed prerequisites), **signed**, **self-updating from GitHub Releases**, released by **one command**, with the core logic in a **headless, tested, publishable package**.

---

## 1. Principles

1. **One UI codebase, two shells.** React renders everywhere. Platform differences live behind `cfg` gates in Rust and a Kotlin plugin, exposed to the UI through the same `invoke()` command names.
2. **Self-contained.** Anything the app shells out to is bundled inside it. Nothing relies on `PATH`, Homebrew or a preinstalled runtime.
3. **GitHub is the whole backend.** Source, CI-less releases, binary hosting and the update feed are all GitHub Releases. No server.
4. **Logic is pure and tested.** Parsing, planning and state machines are plain TypeScript with no UI or platform imports, so they run under `node --test`.
5. **One seam for side effects.** Anything that touches the outside world (spawn a process, fetch, read a file) goes through a small injected interface, so tests substitute a fake.
6. **Releases are scripted and guarded.** A human runs `yarn release patch`; the script refuses to run in unsafe states.
7. **Hand-written, minimal tooling.** No UI framework, no CSS framework, no state library. One CSS file, React state, small `src/lib` modules.

---

## 2. Toolchain (versions that worked together)

| Layer | Choice |
|---|---|
| Language (UI/logic) | TypeScript, `strict`, `noUnusedLocals`, `noUnusedParameters` |
| UI | React 19 (function components, hooks only) |
| Bundler | Vite 6 + `@vitejs/plugin-react` |
| Package manager | **Yarn 4.x via Corepack**, `nodeLinker: node-modules` (set in `.yarnrc.yml`) |
| Node | 22 |
| Desktop/mobile shell | **Tauri v2** (Rust, stable toolchain, edition 2021) |
| Rust | stable via rustup |
| Android | Tauri-generated Gradle project: AGP 9.3.x, Kotlin 2.2.x, Gradle 9.6.x, compileSdk/targetSdk 37, minSdk 24, **JDK 21**, NDK 30 |
| Tests | `node --test` (built in), `cargo test` for Rust |
| Styling | one hand-written `styles.css` using CSS custom properties |
| Distribution | GitHub Releases (`gh` CLI), minisign-signed updater artifacts |

Pin the package manager in `package.json`: `"packageManager": "yarn@4.x.y"`. Enable once with `corepack enable`.

**Pin the Vite major deliberately.** Newer majors raise their minimum Node/browser baselines. Choose, then stay.

---

## 3. Repository layout

The app lives in a subfolder of the repo (`app/`) when the repo root belongs to something else; otherwise it's the root. Everything below is relative to the app root.

```
package.json            scripts, version, workspaces, custom fields (githubRepo, npmUser)
.yarnrc.yml             nodeLinker: node-modules
tsconfig.json           strict, bundler resolution, "include": ["src"]
vite.config.ts          fixed port 1420, define() constants, build.target safari13
index.html
app-icon.png            1024px source icon (tauri icon generates the rest)
src/
  main.tsx  App.tsx  styles.css  icons.tsx  vite-env.d.ts
  lib/                  pure TS modules (parsing, planning, update check, backend facade)
src-tauri/
  Cargo.toml  build.rs  tauri.conf.json  tauri.android.conf.json
  capabilities/default.json   (desktop)   capabilities/mobile.json (android)
  icons/
  binaries/             bundled sidecars (gitignored, fetched by setup script)
  signing/              updater key (gitignored)
  src/lib.rs            shared commands + cfg-gated platform modules
  src/desktop.rs        macOS-only code      src/android.rs  Android-only bridge
  gen/android/          Tauri-generated Gradle project (committed, then hand-edited)
packages/               yarn workspaces: headless, publishable libraries
scripts/
  setup.sh              fetch sidecar binaries
  release.mjs           the release pipeline
  updater-keygen.mjs    one-time updater key creation
  android-keystore.mjs  one-time Android keystore creation
  lib/                  manifest builder, prompt helper, identity guards (unit-tested)
tests/                  node --test files for scripts/lib
docs/RELEASING.md       human runbook
```

**Monorepo rule:** yarn workspaces `["packages/*"]` at the app root. Libraries are plain TS compiled with `tsc`. The app imports them like any dependency.

**.gitignore (essentials):** `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen/schemas`, `.yarn`, `src-tauri/binaries/`, `src-tauri/signing/`, `*.jks`, `keystore.properties`, `release-staging/`, `packages/*/dist`.

---

## 4. Frontend

- **Vite config:** `server: { port: 1420, strictPort: true }`, `clearScreen: false`, `build: { target: "safari13" }`.
  - **TRAP:** the macOS webview is WebKit and Android's WebView lags too. Targeting `safari13` forces syntax down-levelling, but **it does not polyfill APIs**. Avoid `Array.prototype.at`, `structuredClone`, `Object.hasOwn`, and similar newer runtime APIs. Use plain indexing and older idioms.
- **Build-time constants** via `define`: `__APP_VERSION__` and `__GITHUB_REPO__`, read from `package.json`, declared in `vite-env.d.ts`. The About screen and update checker use them; nothing is hard-coded twice.
- **State:** React `useState`/`useRef`/`useEffect` in `App.tsx` and small hooks. No Redux/Zustand/router. Navigation is a `screen` state string.
- **Persistence:** `localStorage` for lightweight things (history, settings), always wrapped in try/catch with a typed loader that tolerates old shapes.
- **Backend facade:** `src/lib/backend.ts` is the only file that imports `@tauri-apps/api`. Everything else calls its typed functions. This keeps the UI testable and makes the platform seam obvious.
- **Styling:** `styles.css` with a `:root` token block (colours, radii, shadows, sizes), a base reset (`box-sizing`, system font stack, `-webkit-font-smoothing`, `user-select: none` except in `code`/inputs), then flat component classes. No Tailwind, no CSS-in-JS, no component library. Icons are inline SVG React components in one `icons.tsx`.
- **Native feel:** disable text selection/context menu on chrome, `cursor: default` on buttons, `overflow: hidden` on `html, body`, respect `env(safe-area-inset-*)` on mobile. Window height should size to content on desktop (measure content, call the window API to resize) rather than a fixed tall frame.

---

## 5. Tauri shell (Rust)

### 5.1 `tauri.conf.json` (shape)

```jsonc
{
  "productName": "<App>",
  "version": "0.1.0",                       // mirrored by the release script
  "identifier": "<reverse.dns.id>",         // set once; NEVER change after shipping
  "build": {
    "beforeDevCommand": "yarn dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "yarn build",
    "frontendDist": "../dist"
  },
  "app": { "windows": [{ "title": "<App>", "width": 520, "height": 600, "resizable": true }] },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "externalBin": ["binaries/<sidecar>"],
    "createUpdaterArtifacts": true,         // only once a signing key exists, see §10
    "macOS": { "signingIdentity": "-", "hardenedRuntime": false, "minimumSystemVersion": "11.0" }
  },
  "plugins": { "updater": { "pubkey": "<written by updater-keygen>", "endpoints": ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"] } }
}
```

**TRAP: choose `identifier` carefully and once.** It becomes the Android package name and the macOS bundle ID. Changing it later makes Android treat the app as a different app (no in-place update). Do not use your employer's domain for a personal project.

### 5.2 Platform split

- `Cargo.toml`: shared deps unconditional; desktop-only plugins under `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` (updater, process); Android-only deps under `[target.'cfg(target_os = "android")'.dependencies]`.
- `lib.rs` declares `#[cfg(desktop)] mod desktop;` and `#[cfg(target_os = "android")] mod android;`. Each command (`#[tauri::command]`) has the same name and signature on both platforms and dispatches to its module. The UI never knows which it is on.
- `tauri.android.conf.json` is auto-merged on Android builds: override `bundle.externalBin: []`, drop desktop-only bundle config, set mobile window options.
- **Capabilities are per platform.** `capabilities/default.json` (`"platforms": ["macOS","windows","linux"]`) lists desktop permissions incl. updater/process/shell; `capabilities/mobile.json` (`"platforms": ["android"]`) lists the minimal mobile set. Grant the minimum: `core:default`, plus only the plugin permissions actually used. Scope `http` to specific URL patterns; scope shell execution to the one bundled sidecar.

### 5.3 Plugins used

`tauri-plugin-http` (do network fetches **from Rust** to avoid webview CORS), `tauri-plugin-dialog`, `tauri-plugin-shell` (sidecar spawn, desktop), `tauri-plugin-clipboard-manager`, and desktop-only `tauri-plugin-updater` + `tauri-plugin-process` (relaunch after update). Frontend equivalents are the matching `@tauri-apps/plugin-*` packages.

**TRAP: CORS.** Browser `fetch` from the webview to GitHub release assets fails (the asset redirect has no CORS headers). Always use the http plugin's `fetch` for update checks and any third-party API.

### 5.4 Long-running work

Spawn child processes from Rust, stream stdout/stderr lines to the UI via `app.emit("event-name", payload)` (or a `Channel`), key each job by an id, keep a `Mutex<HashMap<id, Child>>` in managed state for cancellation. Cancel with SIGTERM, never SIGKILL, so children clean up partial files. Give each job its own temp/private files.

---

## 6. Bundled binaries ("sidecars")

- Declare in `bundle.externalBin: ["binaries/<name>"]`. Tauri expects files named `src-tauri/binaries/<name>-<target-triple>` (e.g. `-aarch64-apple-darwin`, `-x86_64-apple-darwin`, `-universal-apple-darwin`). Spawn by bare name through the shell plugin sidecar API.
- `scripts/setup.sh [--all]` downloads them (host triple by default; `--all` for arm64 + x86_64 + universal). Idempotent: skip what exists. Verify with `otool -L` that nothing links to Homebrew paths (`/opt/homebrew`, `/usr/local`); a sidecar that dynamically links a Homebrew dylib is not self-contained. Prefer upstream's static/universal2 builds.
- `yarn dev`, `tauri:dev`, `tauri:build` all run `setup` first via `pre*` scripts.
- On Android, bundled native tools can't be executables in the bundle; use an Android library that ships them (as a Gradle dependency) and call it from the Kotlin plugin.

---

## 7. macOS packaging & signing

- Bundles: `app` + `dmg`. Apple Silicon is primary; `tauri build --target universal-apple-darwin` for universal (needs all triples' sidecars).
- **Ad-hoc signing:** `"signingIdentity": "-"`. **TRAP:** without it the app is only linker-signed with no sealed resources, and Gatekeeper reports **"<App> is damaged"** (not just "unidentified developer"). Ad-hoc signing seals the bundle so users get the normal right-click → Open flow. No Apple Developer account needed. State in the README that the app isn't notarised and give the `xattr -cr /Applications/<App>.app` fallback.
- **`hardenedRuntime: false`. TRAP:** hardened runtime rejects loading a differently-signed bundled executable ("different Team IDs"), which breaks PyInstaller-style sidecars. If you later notarise properly, you'll need entitlements/library-validation changes and a real identity.
- **`bundle_dmg.sh` is flaky. TRAP:** a failed run leaves a mounted `rw.*.dmg` that makes every retry fail. The release script must `hdiutil detach` any stale `rw.*` images and retry (up to 3 times).
- Updater artifact on macOS is `<App>.app.tar.gz` + `.sig`. For local test builds without the private key: `TAURI_CONFIG='{"bundle":{"createUpdaterArtifacts":false}}' yarn tauri build`.

---

## 8. Android

### 8.1 Generation and configuration

`yarn tauri android init` generates `src-tauri/gen/android/`. Commit it, then hand-edit. Required choices:

- **arm64 only:** `tauri android build --apk --split-per-abi --target aarch64`. Add other ABIs only if needed (they bloat the APK with native libs).
- `gradle.properties`: `android.builtInKotlin=false`, `android.newDsl=false` (needed for the AGP 9 / Tauri plugin combination), plus `org.gradle.jvmargs` with enough heap.
- JDK 21, `ANDROID_HOME`, `NDK_HOME` set in the shell (document them in the README and check them in the release script preflight).
- **Release signing block** in `app/build.gradle.kts` reads `keystore.properties` from **outside `gen/`** (e.g. `src-tauri/signing/` or app root). **TRAP:** `tauri android init` regenerates `gen/` and silently wipes hand edits including the signing block. Keep a note in `RELEASING.md` of what to re-apply, and put as much config as possible in files outside `gen/`.
- **TRAP: R8/minification must be OFF for release** if any dependency relies on reflection or scrambled internals (observed: runtime `class X is not a concrete class` crash on launch). Set `isMinifyEnabled = false` and `optimization { enable = false }`. Debug builds hide this bug. **Always smoke-test the release APK, not just debug.**
- Legacy native-lib packaging (`useLegacyPackaging = true`) if bundled native executables must be extractable.

### 8.2 Kotlin plugin for native functionality

For anything the WebView can't do (MediaStore saves, notifications, opening files, running a native library): a class extending Tauri's `Plugin`, annotated `@TauriPlugin`, with `@Command` methods taking an `Invoke`, argument classes annotated `@InvokeArg`, results returned via `invoke.resolve(JSObject)` / `invoke.reject(msg)`. Run slow work on a background thread/executor; start Activities on the UI thread. Register from Rust: `Builder::new("<plugin>").setup(|app, api| { let h = api.register_android_plugin("<reverse.dns.id>", "<PluginClass>")?; app.manage(Handle(h)); Ok(()) })`, then call with `handle.0.run_mobile_plugin("command", args)`.

Saving user-visible files on modern Android: write through **MediaStore** (`Download/<App>`), not raw paths. For "Open" actions, look the file up by in-session URI first, then fall back to a MediaStore `LIKE` query on name; surface errors to the UI instead of failing silently.

### 8.3 Keystore and versioning

- `scripts/android-keystore.mjs` is a one-time script: creates the `.jks` **and** `keystore.properties` from the same password in one go, then verifies they agree (`keytool -list`). **TRAP:** Android refuses to install an update signed with a different certificate. Lose the keystore = every user must uninstall. Print a loud "BACK THIS UP" message. Gitignore both files.
- `versionCode` is **derived from the semver** (`major*10000 + minor*100 + patch`) by the release script so it always increases. `versionName` = semver.
- Lock orientation (portrait) in the manifest if the UI is phone-shaped. Request only the permissions you use.

---

## 9. Releases: one command

`yarn release [patch|minor|major|current] [--targets=mac,android] [--notes="…"] [--dry-run] [--no-build] [--no-publish]`

Implemented as a single `scripts/release.mjs` (Node ESM, no deps beyond `node:` built-ins, shells out to `yarn`, `gh`, `git`). Steps:

1. **Preflight** (fail fast, before the long build):
   - `gh auth status`: the **active** account must own `<owner>/<repo>`. (Many people have a work and a personal account. The script must *refuse*, not warn.)
   - Working tree clean.
   - Updater key present and a **signing probe** passes (sign a tiny file) *before* the 5-minute build, not after.
   - Android: SDK/NDK/JDK env present, keystore present.
2. **Version**: bump once, mirror into `package.json`, `tauri.conf.json`, `Cargo.toml`; derive Android `versionCode`.
3. **Build** each target (`tauri build` for mac; `tauri android build …` for Android). Retry the dmg step as in §7.
4. **Stage artifacts** under `release-staging/` with stable, **space-free** names (`<app>_<version>_aarch64.dmg`, `<app>_<version>_aarch64.app.tar.gz` + `.sig`, `<app>-<version>-arm64.apk`).
5. **Write `latest.json`** (§10), carrying forward platforms you didn't rebuild this time.
6. **Commit the version bump** so the tag points at it.
7. **Publish**: create a **draft** release → upload every artifact → upload `latest.json` **last** → publish with `--latest`. This order guarantees clients never see a manifest pointing at assets that aren't uploaded yet.

**Tag prefixing:** use `app-v<version>` (and `packages-v<version>` for libraries). **TRAP:** a fork inherits the upstream's tags (`v0.2.0` …), which collide and confuse "latest". Prefix from day one.

**TRAP: library releases must pass `--latest=false`**, otherwise a package release becomes the repo's "latest" and `/releases/latest/download/latest.json` stops resolving to the app's manifest, silently breaking every installed app's updater.

**TRAP: CDN lag.** Immediately after publishing, `/releases/latest` can serve the previous release for a short while. Don't treat that as a failed release; re-check after a minute.

`--dry-run` runs everything except publish/commit/tag and prints what it would do. Always dry-run first when touching the script.

---

## 10. Self-update plumbing

- **Channel:** only `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
- **Manifest** (one file for all platforms):

```jsonc
{
  "version": "1.2.3", "notes": "…", "pub_date": "ISO-8601",
  "platforms": {
    "darwin-aarch64": { "label": "macOS (Apple Silicon)", "version": "1.2.3",
      "url": ".../<app>_1.2.3_aarch64.app.tar.gz",   // the updater payload
      "signature": "<contents of .sig>",              // minisign
      "installerUrl": ".../<app>_1.2.3_aarch64.dmg",  // human download
      "size": 62769186 },
    "android-arm64": { "label": "Android (ARM64)", "version": "1.2.3",
      "installerUrl": ".../<app>-1.2.3-arm64.apk", "size": 64696726 }
  }
}
```

- **Per-platform versions + carry-forward:** if you release mac-only, copy the previous Android entry forward with *its own* older version. Clients compare against their platform's entry, so a mac-only release doesn't nag Android users. **TRAP:** when carrying a desktop entry forward from a previous version you must **strip `url`/`signature`** (or keep both consistent and valid); a mismatched pair makes the updater fail verification.
- **Desktop** uses `tauri-plugin-updater` (download, verify signature against the embedded public key, install, relaunch via the process plugin). **Android** can't self-install silently: the app fetches `latest.json` itself (via the Rust http plugin), compares versions, and offers to open the APK URL (system installer).
- **Signing key:** `yarn updater:keygen` runs `tauri signer generate`, writes the private key to `src-tauri/signing/` (gitignored), and writes the **public key into `tauri.conf.json`**. `createUpdaterArtifacts` is only switched on once a key exists. `tauri build` needs the private key via `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`); the release script supplies them. **TRAP:** lose this key and no installed copy can ever auto-update again. Back up key + password on day one, together with the Android keystore.
- UX: check shortly after launch (never block startup), a non-modal toast/banner when an update exists, an About → "Check for updates" action with clear states (checking / up to date / update available / error).
- The manifest builder lives in `scripts/lib/manifest.mjs` as a **pure function** with unit tests (carry-forward, stripping, version comparison).

---

## 11. Libraries & publishing (headless packages)

When logic should be reusable outside the UI:

- `packages/core` — **pure TypeScript, zero runtime deps**, no DOM and no Node types. Compiled with `tsc` (`module`/`moduleResolution: NodeNext`, explicit `.js` extensions in relative imports, `declaration: true`, `types: []`). If it needs a global like `URL`, add a minimal ambient declaration instead of pulling in DOM/Node libs. It defines the I/O interface(s) (e.g. `Runner`) and takes implementations as parameters (ports & adapters).
- `packages/runner-node` — a thin adapter implementing those interfaces with `node:child_process`/`fetch`. **`peerDependency`** on core (not a hard dependency, or consumers get duplicate copies and type mismatches).
- Each package: `exports` map with `types` + `import`, `files: ["dist", "README.md"]`, `prepack` builds.
- The app itself consumes the workspace packages; migrate pure logic first, platform glue (Rust/Kotlin) one platform at a time, testing real behaviour after each step.
- **Distribution verified by actually installing the tarball** (`npm pack`, then install into a clean npm project *and* a clean yarn 4 project). **TRAP:** git-URL installs don't work for monorepo subfolders; yarn 4 additionally blocks git deps unless `approvedGitRepositories` is set. Distribute via npm or release tarballs.
- **TRAP: multiple npm identities.** If you have work and personal npm accounts, `release:packages` must not rely on whatever you're logged into. Use a dedicated userconfig (`~/.npmrc-<app>`), an explicit `--registry https://registry.npmjs.org/`, an empty global config, `npm whoami` must equal a required `npmUser` field in `package.json`, and publishing is opt-in via `--npm`. The identity check is a tested module (`scripts/lib/npm-identity.mjs`).

---

## 12. Testing methodology

Runner: **`node --test`**, files named `*.test.mjs`, importing compiled output or `.mjs` libs. Scripts: `yarn test` (app + scripts), `yarn build:packages`, `yarn test:packages`.

1. **Pure logic gets unit tests**: parsers, URL/text extraction, format/plan selection, manifest building, version comparison, identity guards.
2. **Fixtures recorded from reality.** Capture real output from the external tool once (`tests/fixtures/*.json`, via a `record-fixtures.mjs` script), commit it, and test the parser against it. Hand-invented fixtures rot.
3. **Scripted fake runner** for engine/orchestration tests: a fake implementing the I/O interface that replays canned results and records calls.
4. **Fake executable** for the Node adapter: a tiny script that mimics the external CLI's stdout/stderr/exit codes so spawn/stream/cancel paths are exercised without the real tool.
5. **Opt-in integration test** against the real binary (env-gated, run with an **empty environment** to prove self-containment).
6. **Mutation checks:** after writing a test, deliberately break the code under test and confirm the test fails. A test that can't fail is not a test.
7. **Rust:** `#[cfg(test)]` unit tests for parsing and path logic.
8. **No leaked handles.** A test that leaves a socket/stream/timer open hangs `node --test`. Abort fetches/SSE streams in `finally`. **TRAP:** in fake executables use `process.exitCode = n` and let the event loop drain; `process.exit()` truncates piped stdout at the 64 KiB buffer.
9. Tests live **in the repo**, never in `/tmp`.

---

## 13. Verifying the real app (not just tests)

- **macOS UI:** drive the built `.app` with AppleScript/System Events (click, type), find the window ID with a small CGWindow helper, capture with `screencapture -l <windowid>`. Confirm layout, dialogs, and flows by screenshot.
- **Gatekeeper reality check:** copy the `.app`, `xattr -w com.apple.quarantine "0081;…;Safari;" <App>.app`, open it, and confirm you get the normal prompt, not "damaged".
- **Android:** `adb install -r`, `adb shell am start`, `adb logcat -s AndroidRuntime:E`. Test the **signed release** APK on a physical device, not only an emulator or a debug build.
- **Updater end-to-end:** install version N, publish N+1, confirm the app finds, verifies and installs it. Test the carry-forward case (publish a mac-only release and check Android sees no update).
- **Install paths:** for any published package, install the packed tarball into throwaway projects with each package manager you claim to support.

---

## 14. Working practices

- **Git worktrees for parallel work.** While a release builds, never edit the working tree it's building from. Do refactors in a separate worktree/branch; merge after the release.
- **Never run destructive git** (reset --hard, force-push, stash) without being asked. Use a WIP commit to park work.
- **Docs for AI** in any reusable package: `README.md`, `AGENTS.md` (conventions & do/don't), `llms.txt` (index), `docs/API.md`, `ARCHITECTURE.md`, `PORTS.md` (interfaces to implement), `RECIPES.md` (copy-paste examples), `MIGRATION.md`.
- `docs/RELEASING.md` is the human runbook: first-time key setup, backup checklist, how to release, flags, manifest format, account guards.
- Prefer deleting code to adding config. If a script grows a guard, add the unit test for the guard in the same change.
- When editing big files (CSS especially), diff the result against the previous version before committing. A block replace can silently delete neighbouring rules.
- Report what was verified and how. Distinguish "tests pass" from "I ran the real app and saw it work".

---

## 15. Bootstrap checklist (in order)

1. `git init`; `corepack enable`; create `package.json` (`packageManager`, `workspaces`, `githubRepo`, `npmUser`), `.yarnrc.yml`, `.gitignore`.
2. `yarn create vite` equivalent by hand: React 19, TS strict, Vite 6, `index.html`, `src/`, `vite.config.ts` as in §4.
3. `yarn tauri init`; set identifier, window, bundle options; add plugins + capabilities per platform (§5).
4. Write `scripts/setup.sh`; wire `pre*` scripts; confirm `yarn tauri:dev` runs offline.
5. Build `src/lib/backend.ts` facade + one real command end to end (UI → Rust → result).
6. Put pure logic in `src/lib` (or `packages/core`), write tests first-class, record fixtures.
7. `yarn tauri icon app-icon.png`; confirm the icon is *yours*, not the default Tauri logo (check macOS and Android).
8. `yarn tauri android init`; configure Gradle, signing block, R8 off, portrait lock; write the Kotlin plugin + Rust bridge.
9. Run `updater:keygen` and `android:keystore`; **back up both keys and passwords immediately**.
10. Write `release.mjs`, `lib/manifest.mjs` (+ tests), `RELEASING.md`. Dry-run it.
11. First release (`yarn release current`), install the artifacts on a real Mac and a real phone, then release a second version and confirm the in-app update.
12. Only then extract packages, publish, and write AI docs.

---

## 16. Pitfall index (quick scan)

| Area | Trap | Fix |
|---|---|---|
| macOS | "App is damaged" | `signingIdentity "-"` (ad-hoc seal) |
| macOS | Bundled exe won't launch (Team ID mismatch) | `hardenedRuntime: false` |
| macOS | dmg step fails then every retry fails | detach stale `rw.*.dmg`, retry |
| Android | Release crashes on launch, debug fine | R8/minify off; test release APK |
| Android | Signing config vanished | `android init` wipes `gen/`; keep notes/scripts outside it |
| Android | Can't update existing install | same keystore forever; same package id forever; increasing versionCode |
| Web | `fetch` blocked by CORS | do HTTP from Rust (http plugin) |
| Web | Runtime error on old webview | `.at()`, `structuredClone` etc. not available; target Safari 13 APIs |
| Updates | Pubkey/key lost | back up key + password; no recovery |
| Updates | Manifest 404 after library release | libraries `--latest=false` |
| Updates | Carry-forward breaks verification | strip `url`/`signature` on carried desktop entries |
| Releases | Manifest points at missing assets | draft → assets → manifest last → publish |
| Releases | Wrong GitHub account | preflight refuses unless active account owns repo |
| Releases | Tag collisions in a fork | `app-v` / `packages-v` prefixes |
| npm | Published as wrong account | dedicated userconfig + `npmUser` check, opt-in `--npm` |
| npm | Duplicate core copies | adapters use `peerDependencies` |
| Tests | Hang after pass | close/abort every stream and server |
| Tests | Truncated child output | `process.exitCode`, never `process.exit()` |
| Process | Edited tree mid-release | do work in a separate worktree |
