# Migrating an app onto the package

For an app that **already has its own copy** of this logic (copied from Yoink, or written independently), or for
Yoink's own app, which is part-way through the same move.

## 1. Map what you have to what the package provides

| If your app has code that… | Delete it and use |
| --- | --- |
| finds links in pasted text, strips junk, de-duplicates | `extractUrls`, `normaliseUrl` |
| turns yt-dlp's format list into rows, estimates sizes | `buildChoices` |
| picks "best" or "audio" | `pickChoice`, or `policy.chooseFormat` |
| builds yt-dlp command lines | `probeArgs`, `downloadArgs` (never hand-build them) |
| parses `YOINK|…` progress lines, `[Merger]`, final path | `DownloadTracker` |
| decides a job's status, progress, "processing" | `Job` and `subscribe` |
| looks up then downloads each link of a batch, a few at a time | `yoink.batch` |
| retries with a fresh lookup / with a login | the engine does it (the retry ladder) |
| classifies "needs login", "unavailable" | `error.code` |
| knows which sites need which login | `SITES`, `siteForUrl` |
| caches lookups | the engine + a `Storage` |
| runs the process, streams lines, cancels | **keep** this, as your `Runner` |

What stays in your app: screens, wording, the Runner, the Authenticator, settings, history, navigation.

## 2. Steps

1. **Add the dependency** (`@marknotton/yoink-core`, plus `@marknotton/yoink-runner-node` on Node).
2. **Swap the pure helpers first** (links, formats, args, parser, sites, errors). They're stateless, so each swap is
   a find-and-replace with the same behaviour. Run your existing tests.
3. **Write the `Runner`** by reshaping your current "run yt-dlp" code to the contract in PORTS.md (stream lines;
   resolve `{exitCode, cancelled}`; copy cookies per run; SIGTERM on cancel). *Delete your parsing from it.*
4. **Create the engine** with that Runner, then replace your job state with `getJobs()`/`subscribe()`.
5. **Replace your batch/queue/retry code** with `yoink.batch`, `retry`, `cancel`.
6. **Replace your error handling** with a `switch (job.error.code)` that picks *your* wording.
7. **Add the Authenticator** if you offer sign-in.
8. **Delete the old code.** Leaving two implementations is the problem being solved.
9. Run the verification checklist in `AGENTS.md`.

## 3. Behaviour that may change (deliberately)

- **Error messages** no longer include the video id (`aaaaaaaaaaa: This video is unavailable` → `This video is
  unavailable`); the `[extractor]` tag was already dropped.
- **Cookie handling** is per-run copies. If you shared one cookie file between concurrent runs, you now don't.
- **Login is retried only on `NEEDS_LOGIN`**, once, and only if a sign-in is saved.
- **Batch jobs look up and download independently**, so the first file can finish before the last link is looked up.

## 4. Status of the Yoink app itself

The package was extracted from the app, so the app is the first consumer to migrate. Honest status:

| Part | State |
| --- | --- |
| Pure TypeScript (formats, links, sites, errors, args) | **Done.** The app's `src/lib` files are re-exports of the package; its formats, batch link-finding and site list now come from it (verified with a Mac build, an Android build and a real batch download). |
| Job queue, batch, retry and login policy (in `App.tsx`) | In the package, but the app still has its **own copy** in `App.tsx` until its UI is moved onto `getJobs()`/`subscribe()`. This is the next step, and the largest. |
| Rust runner/parser (`desktop.rs`) | Duplicates `DownloadTracker`. To become a thin line-streaming `Runner`. |
| Kotlin runner/parser (`YoinkPlugin.kt`) | Same, for Android. Needs a line channel (polling) to JS. |
| Sign-in window (`signin.rs`) | Stays in Rust as the desktop `Authenticator`'s native half. |

Do the Rust and Kotlin step on **one platform at a time, with real downloads tested** on that platform before the
next: it changes the shipping download path.

## 5. If something doesn't fit

Don't fork the logic into your app. Use `policy`, the ports, `onDownloaded` and events. If the engine genuinely
can't express what you need, that's a gap in the package: note it, and add the seam there.
