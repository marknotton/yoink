# @marknotton/yoink-core

The headless engine behind [Yoink](../../../README.md), a video downloader built on yt-dlp.

It does everything *except* draw a screen or touch the operating system:

- finds every link in any pasted text, tidies and de-duplicates them
- looks a link up and turns yt-dlp's format list into a short list of choices (with sizes)
- builds the yt-dlp command lines, and **reads yt-dlp's output** to report progress
- runs jobs: single downloads, batches (a few at a time), cancel, retry
- handles sites that need a login, and tells your UI when to offer one
- classifies errors into codes your UI can put its own words to

There is **no UI, no DOM, no Node API, and no runtime dependency** in this package. It runs in Node, a
browser, a WebView, Deno or Bun. The only platform-specific thing you write is a small `Runner`: "start
yt-dlp with these arguments and stream me its lines".

> **AI agents:** read [`AGENTS.md`](./AGENTS.md) first. The full reference is in [`docs/`](./docs).

## Install

Two packages: the engine, and (for Node) a ready-made runner. The runner declares the engine as a **peer
dependency**, so install them together and you get exactly one copy of the engine.

**From the tarballs on a GitHub Release** (works with npm, yarn and pnpm; no registry account needed):

```sh
yarn add https://github.com/marknotton/yoink/releases/download/packages-v0.1.0/yoink-core-0.1.0.tgz \
         https://github.com/marknotton/yoink/releases/download/packages-v0.1.0/yoink-runner-node-0.1.0.tgz
```

**From npm**, once published (`yarn workspace @marknotton/yoink-core npm publish --access public`):

```sh
yarn add @marknotton/yoink-core @marknotton/yoink-runner-node
```

**Inside this repo** (a workspace): `"@marknotton/yoink-core": "workspace:*"`. That's how the Yoink app itself uses it.

**Updating:** point the URL at the newer `packages-vX.Y.Z` release (or `yarn up` for npm). Versions follow semver:
breaking changes only in a major version.

> **Not supported: installing straight from the git repo** (`github:marknotton/yoink`, `yarn add …git#workspace=…`).
> The packages live under `app/`, and the repository root is a different project (the original terminal app), so
> the package manager can't find them there. (Yarn 4 also refuses git dependencies unless the repo is listed in
> `approvedGitRepositories` in `.yarnrc.yml`.) Use the tarballs or npm.

> **Maintainers:** `yarn release:packages` builds, tests, packs, proves the tarballs install into an empty
> project, and publishes the release **as non-latest**. That flag matters: the Yoink *app's* updater reads
> `/releases/latest/download/latest.json`, so a package release must never become the repo's "Latest".

## Thirty seconds

```js
import { createYoink } from "@marknotton/yoink-core"
import { createNodeRunner } from "@marknotton/yoink-runner-node"

const runner = createNodeRunner({ ytDlp: "/opt/bin/yt-dlp", ffmpeg: "/opt/bin/ffmpeg" })
const yoink = createYoink({ runner, outputDir: "/volume1/downloads" })

yoink.subscribe((event) => {
  if (event.type === "job-updated" && event.job.progress) {
    const { downloadedBytes, totalBytes } = event.job.progress
    console.log(event.job.title, Math.round((downloadedBytes / (totalBytes ?? Infinity)) * 100) + "%")
  }
})

// any text with links in it; the best quality of each, three at a time
const { jobs, duplicates } = yoink.batch(`
  Here's the list:
  https://www.youtube.com/watch?v=jNQXAC9IVRw
  youtu.be/jNQXAC9IVRw          <- same video again, found once
  https://vimeo.com/76979871
`)
console.log(`${jobs.length} links, ${duplicates} duplicate(s) ignored`)

await yoink.idle()
console.log(yoink.getJobs().map((j) => `${j.status}: ${j.title} -> ${j.filepath ?? j.error?.message}`))
```

## The idea in one picture

```
 your UI (any platform, any framework)          ← you write this: it renders Job objects
        │  calls methods, listens to events
        ▼
 @marknotton/yoink-core  (this package)         ← the logic, written once, tested
        │  asks for 3 things through "ports"
        ▼
 Runner · Authenticator · Storage               ← small adapters per platform
   run yt-dlp   sign in      remember things
```

Because the engine only exposes **plain data** (`Job` objects) and **events**, a phone UI, a TV remote
UI, a desktop window and a NAS web page can all drive it differently without any of them touching yt-dlp.

## What you control

| You decide | How |
| --- | --- |
| How yt-dlp is run on this platform | implement `Runner` (required) |
| What the screens look like and say | render `Job`s; map `error.code` to your own wording |
| Which format a batch picks | `policy.chooseFormat` |
| Where files go and what they're called | `policy.outputTemplate`, `outputDir`, `onDownloaded` |
| How many run at once | `concurrency` |
| How a user signs in | implement `Authenticator` |
| Where the cache is kept | implement `Storage` |

Every one of these has a sensible default except the `Runner`.

## Documentation

| File | For |
| --- | --- |
| [`AGENTS.md`](./AGENTS.md) | AI coding agents: rules, a decision tree, a verification checklist |
| [`llms.txt`](./llms.txt) | A compact index for LLMs |
| [`docs/CONTEXT.md`](./docs/CONTEXT.md) | What Yoink is, why this package exists, how it came about |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | How it works inside, and why it is shaped this way |
| [`docs/API.md`](./docs/API.md) | Every function, type, event and error code |
| [`docs/PORTS.md`](./docs/PORTS.md) | Writing a `Runner`, `Authenticator` and `Storage` for your platform |
| [`docs/RECIPES.md`](./docs/RECIPES.md) | Worked integrations: NAS service, HTTP server, React, Tauri, Android TV |
| [`docs/YT-DLP-NOTES.md`](./docs/YT-DLP-NOTES.md) | Hard-won facts about yt-dlp, ffmpeg, cookies and bundling |
| [`docs/MIGRATION.md`](./docs/MIGRATION.md) | Moving an app that has its own copy of this logic onto the package |

## Tests

```sh
yarn test                      # 36 tests, no network needed
```

The parser and error handling are tested against **real recordings** of yt-dlp's output
(`tests/fixtures/`). If yt-dlp changes its output, re-record them with `tests/record-fixtures.mjs`.

## Licence

MIT. Yoink is based on [yoinks](https://github.com/pablostanley/yoinks) by Pablo Stanley.
