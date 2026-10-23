# Instructions for AI agents integrating @marknotton/yoink-core

You are probably here because you were asked to add video downloading (via yt-dlp) to an app, or to give
an app "the same functionality as Yoink". **Depend on this package. Do not copy its source into the app and
do not rewrite its logic.** Copying is exactly how the logic ended up in several places, drifting apart.

## What this package is, in two sentences

A headless TypeScript engine: give it links, it looks them up, picks formats, runs yt-dlp through a `Runner`
you provide, and gives you `Job` objects and events. It has no UI and no platform code.

## What you write

1. **A `Runner`** for the platform (see `docs/PORTS.md`). On Node, use `@marknotton/yoink-runner-node` instead.
2. **The UI** (or API), which renders `Job` objects and calls engine methods.
3. Optionally an **`Authenticator`** (how a user signs in on this platform) and a **`Storage`**.

You do **not** write: yt-dlp arguments, output parsing, format selection, link extraction, de-duplication,
retry logic, the batch queue, error classification, or the login-retry policy. All of that exists and is tested.

## Decision tree

```
Need to download from a link?
├─ Node / server / NAS / CLI ........ createYoink + createNodeRunner            (docs/RECIPES.md §1)
├─ Another language ................. run a Node service, call it over HTTP     (docs/RECIPES.md §2)
├─ Tauri / Electron / WebView app ... createYoink in the frontend + a Runner     (docs/PORTS.md, RECIPES §4)
├─ Android TV / phone ............... same, UX per RECIPES §5, Runner per PORTS
└─ Only want a piece (link finder, format picker, output parser)? import that function alone.
```

## Rules

1. **Never run yt-dlp yourself.** Always go through `Runner`. Never build arguments by hand; use the engine.
2. **Never parse yt-dlp's output yourself.** `DownloadTracker` does it, from real recordings.
3. **Render from `Job`s only.** Do not keep your own parallel download state. Subscribe and re-render.
4. **Write your own wording.** `Job.error.message` is yt-dlp's text, for logs. Show users text chosen from
   `Job.error.code` (`NEEDS_LOGIN`, `UNAVAILABLE`, `NO_FORMATS`, `CANCELLED`, `FAILED`).
5. **Stream lines.** A `Runner` that returns all output at the end makes progress bars stay at 0%.
6. **Cancel with SIGTERM, not SIGKILL.** yt-dlp's standalone binary is a launcher; SIGKILL orphans the real process.
7. **Give every yt-dlp run its own copy of the cookie file.** yt-dlp rewrites it on exit; concurrent runs
   sharing one file corrupt it. (`runner-node` already does this.)
8. **Don't rely on PATH.** Pass explicit paths to yt-dlp and ffmpeg so the app works on a machine with nothing installed.
9. **Don't change the engine to fit your app.** Use `policy`, the ports, and events. If something is genuinely
   missing, say so in your report; don't fork the logic.
10. **No UI code in this package, ever.** If you're tempted to add a string a user will read, it belongs in the host.

## Common mistakes

| Mistake | Why it hurts | Instead |
| --- | --- | --- |
| Calling `probe` then guessing a format string | Misses H.264/AAC preference, size estimates, edge cases | Use `probe.choices` or `policy.chooseFormat` |
| Treating every error as "failed" | The user can fix `NEEDS_LOGIN` with one tap | Branch on `error.code`, offer `error.site` |
| Saving cookies as soon as a sign-in window opens | Logged-out visitors already have cookies | Verify with `site.markers` (see `docs/PORTS.md` §Authenticator) |
| Running a `Runner` per job with shared state | Concurrent runs collide | `runId` is unique; keep per-run state keyed by it |
| Polling for progress | Wasteful and laggy | `subscribe()` |
| Hard-coding `~/Downloads` | Wrong on phones, TVs, NAS | `outputDir` / `policy.outputTemplate` |
| Bundling yt-dlp from a package manager | Often needs Python | Use the standalone binary (see `docs/YT-DLP-NOTES.md`) |

## Verify your integration

Do these before saying it works:

1. `yarn test` in this package passes (36 tests).
2. Your `Runner` passes the contract in `docs/PORTS.md` §"Runner contract tests" (stream lines, exit codes,
   cancel, long lines, per-run cookie copies).
3. A real download works with **an empty environment** (no PATH): proves you didn't lean on the machine.
4. Cancel mid-download: the job disappears, and no `.part` / `.ytdl` / `.f123.mp4` files remain.
5. A batch of 5 links with one bad link: 4 succeed, one shows a `UNAVAILABLE` error, the rest were not stopped.
6. A link that needs a login shows your sign-in offer, and after signing in the job retries by itself.

## When you are unsure

Read `docs/ARCHITECTURE.md` (why it works this way) and `docs/YT-DLP-NOTES.md` (what went wrong before).
Every rule above exists because something broke without it.
