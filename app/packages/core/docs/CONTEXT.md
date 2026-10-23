# Context: what Yoink is and why this package exists

*Background for an AI (or person) who needs the whole picture before changing or integrating anything.*

## What Yoink is

A small graphical app, for macOS and Android, for downloading video and audio. Paste a link, pick a quality, done.
It works with anything yt-dlp supports: YouTube, X/Twitter, Instagram, Threads, TikTok, Reddit and 1,800+ other sites.

It does **not** implement downloading. It drives two existing programs:

- **yt-dlp** finds the media and downloads it.
- **ffmpeg** merges separate video and audio streams, and converts audio to mp3.

Almost all the value is in driving those two well and presenting the choices clearly.

## Why it exists

It's a personal tool. It is a GUI version of **yoinks**, a terminal app by Pablo Stanley
(github.com/pablostanley/yoinks); the repo is a fork of it so upstream changes can be merged. The owner prefers
windows to terminals and wanted the same flow on a Mac and a phone. It is sideloaded, not in any app store.
Built quickly with AI assistance ("vibe-coded") and tested by hand.

## What the user can do

- Paste a link (or any text with many links) and pick a format: one row per resolution with a size estimate, or
  audio-only mp3. A video with one quality asks "video with audio" or "audio only".
- **Batch:** paste a whole list; each link is looked up and the best quality downloaded, three at a time. One bad
  link doesn't stop the others.
- Several downloads at once, each with its own progress, cancel, retry.
- Recent links, a fetch cache (re-opening a link is instant), and "file still exists, open now?".
- **Sign in** to sites that need it (Reddit and others): a login window; the session is kept on the device.
- Self-updating from GitHub Releases (Mac: in-app install; Android: download the APK).

## The shape of the repository

```
yoinks/                       the repo root is Pablo's original terminal app: leave it untouched
└── app/                      the GUI (Tauri v2 + React + TypeScript) and the shared packages
    ├── src/                  the React UI + Tauri/Android adapters
    ├── src-tauri/            Rust (desktop) and the Android project (Kotlin plugin)
    ├── packages/core/        @marknotton/yoink-core: the headless engine  ← this package
    ├── packages/runner-node/ @marknotton/yoink-runner-node: run yt-dlp from Node
    └── docs/RELEASING.md     how releases and updates work (GitHub Releases; signed)
```

## Why a headless package

The download logic had ended up in four places: TypeScript (formats, batch), Rust (running yt-dlp, parsing
progress), Kotlin (the same, again, for Android) and the React app (queueing, retry and login policy). Other apps
the owner builds (a NAS download manager; Mac, Android and Android TV front ends) need the same functionality with
completely different UX. Copying the source into each would double the code and let the copies drift.

So the logic that is *not* UX is in `@marknotton/yoink-core`, UI-free, with one small seam (`Runner`) for the
platform. A host app writes its own screens and its own Runner, and gets everything else, including future fixes by
updating the package.

## Where things stand

- **The package is complete, tested and documented** (36 core tests against real yt-dlp recordings; 9 runner tests; a
  real-binary end-to-end test; an HTTP example with tests).
- **The Yoink app uses the package for its pure TypeScript** (formats, links, sites, errors). It has **not yet** been
  moved onto the package's job engine or `Runner`: `App.tsx` still has its own queue/retry/login code, and the Rust
  and Kotlin still contain their own runners and parsers. See [MIGRATION](./MIGRATION.md) for the plan.
- **Install:** tarballs on a GitHub Release or npm. Installing from the git repo does not work (see the README).
- Sign-in is implemented for macOS (a window, cookie detection by token claims). **Android sign-in is not built yet.**

## Glossary

| Term | Meaning |
| --- | --- |
| **probe / lookup** | Asking yt-dlp what formats a link has (`yt-dlp -J`). |
| **choice** | One row a user can pick: a resolution or "audio only". |
| **job** | One download (or one link in a batch), with a status and progress. |
| **Runner** | The platform adapter that starts yt-dlp and streams its lines. |
| **Authenticator** | The platform adapter that lets a user sign in to a site. |
| **sidecar** | A bundled helper program shipped inside a Tauri app (yt-dlp and ffmpeg are sidecars). |
| **infoRef** | A handle to a saved lookup so a download can skip re-extracting. Expires in about an hour. |
| **marker** | A cookie (or token claim) that proves a login, so a sign-in window can close itself. |
| **upstream** | Pablo Stanley's original `yoinks` repo. |

## What to read next

`README.md` → `AGENTS.md` → `docs/ARCHITECTURE.md` → `docs/API.md` → `docs/PORTS.md` → `docs/RECIPES.md`.
