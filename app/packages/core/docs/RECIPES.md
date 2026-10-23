# Recipes

Worked integrations. Each uses only the public API. All code here is either run by the test suite or typechecked
against the real types (noted per recipe).

1. [A NAS or home-server service (Node)](#1-a-nas-or-home-server-service-node) · tested
2. [Another language: the HTTP server](#2-another-language-the-http-server) · tested
3. [A command-line tool](#3-a-command-line-tool) · tested
4. [A desktop or mobile app (Tauri / Electron / WebView)](#4-a-desktop-or-mobile-app-tauri--electron--webview)
5. [React: a hook that renders jobs](#5-react-a-hook-that-renders-jobs) · typechecked
6. [Android TV and other living-room UIs](#6-android-tv-and-other-living-room-uis)
7. [Policies: choose formats and name folders your way](#7-policies-choose-formats-and-name-folders-your-way) · tested
8. [Using just a piece](#8-using-just-a-piece)

---

## 1. A NAS or home-server service (Node)

Your tool runs on a NAS and has its own web UI. Let the engine do the downloading; you keep the UX.

```js
import { createYoink } from "@marknotton/yoink-core"
import { createNodeRunner, cookiesFileAuthenticator } from "@marknotton/yoink-runner-node"

const runner = createNodeRunner({
  ytDlp: "/volume1/apps/yt-dlp_linux",     // explicit paths: no PATH, no Python
  ffmpeg: "/volume1/apps/ffmpeg",
  cookiesFile: "/volume1/apps/yoink/cookies.txt",
})
const yoink = createYoink({
  runner,
  outputDir: "/volume1/media/incoming",
  authenticator: cookiesFileAuthenticator("/volume1/apps/yoink/cookies.txt"),
  concurrency: 2,                           // be gentle on a small CPU
  onDownloaded: async (job) => {
    // hand the finished file to the rest of your system: rename, index, notify…
    await myLibrary.add({ path: job.filepath, title: job.title, source: job.url })
  },
})

// your UI/API calls these:
yoink.batch(textFromYourForm, { quality: "best" })
yoink.subscribe((event) => myWebSocket.broadcast(event))   // live progress to your UI
```

A job that fails with `NEEDS_LOGIN` carries the `site`. A server can't show a login page, so your UI says
"Reddit needs a login: upload a cookies.txt". Then:

```js
const authenticator = cookiesFileAuthenticator("/volume1/apps/yoink/cookies.txt")
await authenticator.importCookies(uploadedText)   // save the login
await yoink.signIn(site)                          // resolves because a login now exists; the engine records it
                                                  // and retries every job that was waiting on that site
```

`signIn` on the cookies-file authenticator succeeds exactly when a login for the site has been imported.

*Verified by:* `packages/runner-node/tests/integration.test.mjs` (real yt-dlp + ffmpeg, empty environment).

## 2. Another language: the HTTP server

Python, Go, PHP, a shell script, a mobile app: anything that can make HTTP calls. Run the example server:

```sh
YT_DLP=/opt/yt-dlp FFMPEG=/opt/ffmpeg OUT_DIR=/volume1/downloads \
  node packages/runner-node/examples/http-server.mjs
```

```sh
curl -X POST localhost:8787/batch -d '{"text":"https://youtu.be/jNQXAC9IVRw https://vimeo.com/76979871","quality":"best"}'
curl localhost:8787/jobs
curl -N localhost:8787/events            # live events (Server-Sent Events)
```

| Method + path | Does |
| --- | --- |
| `POST /batch` `{text \| urls, quality}` | Starts a batch → `{jobs, duplicates, truncated}` |
| `POST /probe` `{url}` | Looks a link up → `Probe` (the formats to choose from) |
| `POST /download` `{url, choice}` | Downloads one of the probe's choices (index) → `Job` |
| `GET /jobs` | All jobs |
| `GET /events` | SSE stream of every `YoinkEvent`, starting with `{"type":"hello","jobs":[…]}` |
| `POST /jobs/:id/retry` · `DELETE /jobs/:id` | Retry · cancel |
| `POST /jobs/clear-finished` | Clear finished and failed |
| `POST /signin/cookies` `{cookies}` | Import a cookies.txt login |

Errors come back as `{error, code, site}` with `code` one of the engine's error codes (HTTP 422), so a non-JS client
can still branch on `NEEDS_LOGIN`.

It listens on `127.0.0.1` only. To expose it, set `HOST` **and** `TOKEN`; it refuses to start without a token on a
network address. Put it behind your own TLS/reverse proxy: it is an *example*, not a hardened product.

*Verified by:* `tests/http-example.test.mjs` (starts the server, batches, reads SSE, checks errors and the token rule).

## 3. A command-line tool

```sh
YT_DLP=/opt/yt-dlp FFMPEG=/opt/ffmpeg node packages/runner-node/examples/headless-batch.mjs links.txt --audio --out ./music
```

`examples/headless-batch.mjs` is ~25 lines: read text, `yoink.batch(text)`, print on `job-done`/`job-error`, `await
yoink.idle()`.

## 4. A desktop or mobile app (Tauri / Electron / WebView)

Put `createYoink` in your **frontend** (or Electron's main process), give it a `Runner` for your shell (see
[PORTS](./PORTS.md)), a `Storage` backed by the webview's storage, and an `Authenticator` that opens a sign-in
window. Your UI renders `getJobs()` and re-renders on `subscribe`.

```ts
import { createYoink } from "@marknotton/yoink-core"

export const yoink = createYoink({
  runner: tauriRunner,                       // PORTS.md sketch
  storage: localStorageStorage,              // PORTS.md
  authenticator: desktopWindowAuthenticator, // PORTS.md: open window, poll markers, save cookies
  outputDir: () => settings.downloadFolder,  // a function: the user can change it any time
})
```

Everything else (formats, batches, retries, error codes) comes from the engine. The app contributes only the
platform adapters and its screens.

## 5. React: a hook that renders jobs

The engine's state is plain data plus a subscribe function.

```tsx
import { useEffect, useState } from "react"
import type { Job, Yoink } from "@marknotton/yoink-core"

export function useJobs(yoink: Yoink): Job[] {
  const [jobs, setJobs] = useState<Job[]>(() => yoink.getJobs())
  useEffect(() => yoink.subscribe(() => setJobs(yoink.getJobs())), [yoink]) // subscribe() returns the unsubscribe
  return jobs
}
```

(`getJobs()` returns a new array on every call, so don't hand it straight to `useSyncExternalStore`: it would
re-render forever. Copying into state on each event is correct and cheap.)

Render from `Job` fields only (`status`, `progress`, `label`, `error.code`). For high-frequency `job-updated`
events, throttle in your component (e.g. `requestAnimationFrame`), not in the engine.

*Verified by:* typechecked against the package's types (see MIGRATION.md for how the Yoink app itself renders).

## 6. Android TV and other living-room UIs

The engine is the same; the *experience* is yours. Things that differ on a TV:

- **No keyboard, no paste.** Getting links in is the hard part. Options: a **second-screen** page (the TV shows a
  short code or QR; the user opens it on their phone and pastes links there; your service forwards them to
  `yoink.batch(text)`), a share-target from the phone app, or a watch-folder of text files on the NAS.
- **Focus-driven navigation.** Render `Job`s as a list of focusable rows. The engine never assumes a pointer.
- **Progress for a distance.** A big bar and a short label from `job.label` + `job.progress`. Use
  `formatBytes`/`formatEta` from the package if you like.
- **Sign-in on a TV.** Don't make users type passwords with a remote. Implement `Authenticator.signIn` as a
  second-screen flow ([PORTS](./PORTS.md) §Platform patterns) or import cookies exported elsewhere.
- **Wording.** Map `error.code` to short, plain sentences. `NEEDS_LOGIN` → "Sign in to <site> on your phone".
- **Where files go.** `outputDir` / `policy.outputTemplate` → the TV's media folder, or a NAS share.

Because Jobs are plain data, the same engine instance can run on the NAS while the TV, the phone and a desktop
all show its state (see recipe 2).

## 7. Policies: choose formats and name folders your way

```ts
const yoink = createYoink({
  runner,
  outputDir: "/media/incoming",
  policy: {
    // never more than 1080p, even when "best" would be 4K
    chooseFormat: (choices, { quality }) =>
      quality === "audio"
        ? choices.find((c) => c.kind === "audio")
        : choices.find((c) => c.kind === "video" && parseInt(c.label) <= 1080) ?? choices.find((c) => c.kind === "video"),

    // /media/incoming/<site>/<title>.<ext>
    outputTemplate: ({ url, choice }) => {
      const site = new URL(url).hostname.replace(/^www\./, "")
      return `/media/incoming/${site}/%(title).80s.%(ext)s`
    },
  },
})
```

`outputTemplate` is a full yt-dlp output template, so any yt-dlp field works (`%(uploader)s`, `%(upload_date)s`).
Return an absolute path. yt-dlp creates missing folders.

*Verified by:* `engine.test.mjs`, "the host decides: which format a batch picks, and where files go".

## 8. Using just a piece

Everything in the package is importable alone, with no engine and no runner:

```ts
import { extractUrls, buildChoices, DownloadTracker } from "@marknotton/yoink-core"

extractUrls(pastedText).urls          // links, tidied and de-duplicated
buildChoices(videoInfoFromYtDlp)      // the format rows, with sizes
const t = new DownloadTracker(); t.feed(line) // read yt-dlp output in your own runner
```

Useful when you already have a downloader and only want the hard-won parts: the link finder, the H.264-preferring
format picker, or the output parser.
