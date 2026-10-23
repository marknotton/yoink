# API reference

All of this is exported from `@marknotton/yoink-core`. Types are in `src/types.ts`; the engine is `src/engine.ts`.

- [`createYoink`](#createyoinkoptions) · [Yoink methods](#the-yoink-object) · [Events](#events)
- [Data types](#data-types) · [Errors](#errors) · [Ports](#ports) · [Pure helpers](#pure-helpers)

---

## `createYoink(options)`

```ts
import { createYoink } from "@marknotton/yoink-core"
const yoink = createYoink({ runner, outputDir: "/downloads" })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `runner` | `Runner` | **required** | How to run yt-dlp here. See [PORTS](./PORTS.md). |
| `outputDir` | `string \| () => string` | **required** | Where files go. A function is re-read for every download, so users can change the folder at any time. |
| `storage` | `Storage` | in-memory | Persists the lookup cache and the signed-in sites. |
| `authenticator` | `Authenticator` | none | Needed only if you offer sign-in. Without it, `signIn()` rejects. |
| `policy.chooseFormat` | `(choices, {quality, url}) => Choice \| undefined` | tallest video, or the audio row | Which format a batch picks. |
| `policy.outputTemplate` | `({url, title, choice}) => string` | `<outputDir>/%(title).60s.%(ext)s` | The full yt-dlp output template: directory **and** name. |
| `concurrency` | `number` | `3` | How many batch links are looked up and downloaded at once. Single `download()` calls are not limited. |
| `cacheTtlMs` | `number` | 24 hours | How long a lookup (the format list) is reused. |
| `infoRefTtlMs` | `number` | 1 hour | How long a lookup's saved download links are trusted. They expire quickly. |
| `onDownloaded` | `(job) => void \| Promise<void>` | none | After a file is saved: move it, tag it, notify. Errors are swallowed. |
| `now`, `newId` | functions | `Date.now`, counter | For tests. |

Returns a [`Yoink`](#the-yoink-object).

---

## The `Yoink` object

### `ready: Promise<void>`
Resolves once saved state is loaded. Every method waits for it, so you rarely need it.

### `probe(url, { refresh? }) → Promise<Probe>`
Looks a link up. Order of events:

1. Cache hit (and not `refresh`)? Return it with `fromCache: true`.
2. Run yt-dlp **without** a login.
3. Only if the site says it needs a login (`NEEDS_LOGIN`) **and** a sign-in is saved: run again **with** it.
4. Build choices, cache, return.

Rejects with a [`YoinkError`](#errors). `NEEDS_LOGIN` carries `site` so you can offer the right sign-in.
A lookup made with a login has `probe.login === true`; its download uses the login too.

### `download(probe, choice) → Job`
Starts at once and returns the new `Job` (status `"running"`). Watch it with `subscribe`. Not queued, not limited.

### `batch(input, { quality? }) → BatchResult`
`input` is **any text** containing links, or an array of strings. Finds the links (in order, de-duplicated,
tracking junk removed, YouTube spellings normalised, max 200), creates one `queued` job per link, and runs them
`concurrency` at a time: look up → pick a format → download. A link already downloading is skipped.

`quality`: `"best"` (default; the tallest video) or `"audio"` (mp3). Override per-link with `policy.chooseFormat`.

```ts
type BatchResult = {
  jobs: Job[]          // the new jobs, in pasted order
  duplicates: number   // links found twice
  truncated: boolean   // more than 200 found
  done: Promise<void>  // resolves when every job in this batch has finished or failed
}
```

One bad link never stops the rest.

### `getJobs() → Job[]`
Newest first. Returns a copy; jobs are immutable snapshots, replaced on every change.

### `cancel(jobId) → Promise<void>`
Stops the run (SIGTERM via the runner), deletes partial files if the runner can, and **removes** the job.

### `retry(jobId)`
For a job with `status: "error"`. If it had got as far as a download, downloads again with a fresh lookup. If it
failed during the lookup (batch only), starts from the lookup again.

### `dismiss(jobId)` · `clearFinished()`
Remove finished or failed jobs. Running jobs are left alone.

### `subscribe(listener) → unsubscribe`
See [Events](#events). Listener exceptions are swallowed.

### `idle() → Promise<void>`
Resolves when no job is `queued`, `fetching` or `running`. For scripts.

### `signIn(site) → Promise<void>` · `signOut(site) → Promise<void>` · `signedIn() → string[]`
`signIn` calls `authenticator.signIn(site)`, records the site as signed in, then **retries every job that
failed with `NEEDS_LOGIN` for that site**. `signedIn()` returns site ids, e.g. `["reddit"]`.

---

## Events

```ts
type YoinkEvent =
  | { type: "job-added";   job: Job }
  | { type: "job-updated"; job: Job }   // progress ticks, status changes, label/title once known
  | { type: "job-removed"; job: Job }   // cancelled or dismissed
  | { type: "job-done";    job: Job }
  | { type: "job-error";   job: Job }
  | { type: "signins-changed"; signedIn: string[] }
```

`job-updated` fires very often during a download (every progress line). Throttle in your UI if rendering is costly.
`job-done` / `job-error` fire **in addition to** the `job-updated` for the same change.

---

## Data types

### `Job`
```ts
type Job = {
  id: string
  url: string
  title: string          // the link itself until the real title is known
  label: string          // "1080p" | "Audio · mp3" | "Queued"
  kind: "video" | "audio"
  status: "queued" | "fetching" | "running" | "done" | "error"
  progress?: Progress
  processing: boolean    // downloaded; ffmpeg is merging or converting
  refreshing: boolean    // the saved lookup went stale; re-extracting
  login: boolean         // this job uses the saved sign-in
  quality?: "best" | "audio"   // set for batch jobs
  filepath?: string      // when status is "done"
  error?: YoinkErrorInfo // when status is "error"
}
```

Status flow: `queued → fetching → running → done`, or `→ error` from any of the last three. (`download()` starts
at `running`.)

### `Progress`
```ts
type Progress = {
  downloadedBytes: number
  totalBytes?: number    // may be an estimate; undefined if unknown
  speed?: number         // bytes per second
  eta?: number           // seconds
  part: number           // 0-based: which file is downloading
  totalParts: number     // 2 when video and audio are separate streams
}
```
When `totalParts > 1`, the byte counter **restarts** for each part. A progress bar should say "part 2 of 2"
or compute `(part + fraction) / totalParts`.

### `Probe`
```ts
type Probe = {
  url: string
  title: string; uploader?: string; duration?: number   // seconds
  choices: Choice[]
  login: boolean
  infoRef?: string       // runner handle to the saved lookup; may be absent or expired
  fetchedAt: number
  fromCache?: boolean
}
```

### `Choice`
```ts
type Choice = {
  label: string   // "1080p" | "Audio only" | "Video with audio"
  detail: string  // "mp4 · ~122 MB"
  kind: "video" | "audio"
  args: string[]  // the yt-dlp options; the engine uses these, you normally never touch them
}
```
Rows are tallest-first with one audio row last. If a link has one quality, the video row is "Video with audio".
Above 1080p on YouTube the rows are VP9/AV1, which QuickTime/Quick Look can't play inside mp4 (VLC can).

### `SignInSite` and `MarkerRule`
```ts
type SignInSite = {
  id: string; label: string
  loginUrl: string       // where to send the user
  cookieUrls: string[]   // where the site's cookies live
  markers: MarkerRule[]  // proof of a login; [] means "can't tell, ask the user"
  domains: string[]      // forget these on sign-out
  note?: string
}
type MarkerRule = { name: string; jwtSubNot?: string[] }
```
Built in: `SITES` (Reddit, Instagram, X/Twitter, TikTok, Facebook, Threads, YouTube). `siteForUrl(url)` returns a
generic entry for any other host.

---

## Errors

`probe()` and `signIn()` reject with `YoinkError`; a failed `Job` carries the same data as `job.error`.

```ts
class YoinkError extends Error { code: YoinkErrorCode; site?: SignInSite; hadLogin?: boolean }
type YoinkErrorInfo = { code: YoinkErrorCode; message: string; site?: SignInSite; hadLogin?: boolean }
```

| Code | Meaning | What your UI should do |
| --- | --- | --- |
| `NEEDS_LOGIN` | The site only shares this with signed-in users. `site` says which login. `hadLogin: true` means a saved login was tried and refused (expired). | Offer sign-in for `site`. Words differ if `hadLogin`. |
| `UNAVAILABLE` | Private, removed, geo-blocked, or the link is wrong. | Say so. Retrying won't help. |
| `NO_FORMATS` | The lookup worked but nothing is downloadable. | Say so. |
| `CANCELLED` | The user cancelled. | (Cancelled jobs are removed, so you rarely see this.) |
| `FAILED` | Anything else. | Show `message` (yt-dlp's text, cleaned) and offer retry. |

`message` is yt-dlp's text with the `[extractor]` tag and video id removed. It's for logs and a "details" line,
not for headlines.

---

## Ports

Interfaces your host implements. Full guidance and examples: [PORTS](./PORTS.md).

```ts
interface Runner {
  run(request: RunRequest, handlers: RunHandlers): Promise<RunResult>
  cancel(runId: string): Promise<void>
  storeInfo?(json: string): Promise<string>      // optional: lets downloads skip re-extracting
  removeFiles?(paths: string[]): Promise<void>  // optional: clean up after a cancel
}
type RunRequest  = { runId: string; args: string[]; login?: boolean }
type RunHandlers = { onStdout(line: string): void; onStderr(line: string): void }
type RunResult   = { exitCode: number | null; cancelled: boolean }

interface Storage { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
interface Authenticator { signIn(site: SignInSite): Promise<void>; signOut(site: SignInSite): Promise<void> }
```

`memoryStorage()` is the default `Storage`.

---

## Pure helpers

Use these on their own if you don't need the engine. None of them has side effects.

| Function | What it does |
| --- | --- |
| `extractUrls(text) → { urls, duplicates, truncated }` | Links from any text: with or without `https://`, in pasted order, tidied, de-duplicated, max `MAX_BATCH` (200). |
| `normaliseUrl(url)` | One canonical form per video (YouTube's many spellings → `watch?v=ID`), tracking params and fragments removed. |
| `isProbablyUrl(text)` | Is this an http(s) link? |
| `buildChoices(videoInfo) → Choice[]` | Format rows from yt-dlp's `-J` output. |
| `pickChoice(choices, "best" \| "audio")` | The tallest video, or the audio row. |
| `probeArgs(url)` · `downloadArgs({url, infoRef?, choice, outputTemplate})` | The yt-dlp command lines. |
| `new DownloadTracker()` → `.feed(line)` | Reads yt-dlp stdout. Returns `{type:"progress", progress}`, `{type:"processing"}` or nothing. `.filepath`, `.destinations`. |
| `partialsOf(path)` | `[path, path.part, path.ytdl]`: what a cancelled download can leave behind. |
| `cleanError(stderr)` · `needsLogin(msg)` · `looksUnavailable(msg)` | Error text handling. |
| `SITES` · `siteForUrl(url)` · `isSignInLink(url)` · `detectPlatform(url)` | Sites. `isSignInLink` spots emailed "log me in" links so they're never downloaded as videos. |
| `runPool(items, limit, worker)` | At most `limit` at once; one failing item doesn't stop the others. |
| `formatBytes` · `formatDuration` · `formatSpeed` · `formatEta` · `tildify` | Display helpers (optional). |
