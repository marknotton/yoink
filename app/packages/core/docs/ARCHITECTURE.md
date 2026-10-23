# Architecture

## The one decision everything follows from

**Only one thing is genuinely platform-specific: starting yt-dlp, streaming its lines, and stopping it.**
Everything else (what to run, how to read the output, which format to pick, when to retry, how to queue,
what an error means) is identical on every platform. So that part is written once, here, and the platform part
is shrunk to a ~100-line `Runner`.

Before this package existed, Yoink had that logic in four places: TypeScript (formats, batch), Rust (running
yt-dlp, parsing progress), Kotlin (the same, again, for Android) and the React app (queueing, retry policy, login
policy). They had drifted: the Rust and Kotlin parsers disagreed about edge cases, and a fix in one wasn't in the
other. Hence this package.

## Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ Host app: UI / API / CLI                                         │  you
│   renders Job objects · maps error codes to words                │
├──────────────────────────────────────────────────────────────────┤
│ createYoink  (engine.ts)                                         │
│   probe · download · batch · jobs · sign-in policy · events      │
├────────────────┬─────────────────┬───────────────────────────────┤
│ args.ts        │ parse.ts        │ formats.ts · pick.ts · urls.ts │  pure functions
│ command lines  │ DownloadTracker │ sites.ts · errors.ts · pool.ts │  (usable alone)
├────────────────┴─────────────────┴───────────────────────────────┤
│ Ports (ports.ts):  Runner · Authenticator · Storage              │  you, per platform
└──────────────────────────────────────────────────────────────────┘
```

Rules the layers keep:

- Pure modules import nothing but types. They have no state.
- The engine imports pure modules and the **port interfaces**, never an implementation.
- Nothing in this package touches a process, a file, a window or the network. (`URL` is the only global.)
- Everything that crosses the boundary to a UI is plain, serialisable data: `Job`, `Probe`, `Choice`, errors.

## Why the Runner works at the level of *lines*

Alternatives considered:

| Runner level | Result |
| --- | --- |
| "Download this URL, call me with progress" (high level) | Every platform re-implements parsing, cleanup, retry. This was the old Rust/Kotlin design. |
| **"Run these arguments, stream me each line"** (chosen) | Parsing, cleanup and policy live once. The runner is a thin pipe. |
| "Give me a yt-dlp library" | Not portable; ties you to Python. |

The cost: output has to be streamed to wherever the engine runs. On Node and in a desktop shell that's trivial. On
Android (Kotlin → JavaScript) it means a line channel; see PORTS.md.

## Flow: looking a link up

```
probe(url)
  ├─ cached and fresh? ──────────────────────────────► Probe (fromCache)
  ├─ runner.run(probeArgs(url), login:false)
  │     ok ─► parse JSON ─► buildChoices ─► (runner.storeInfo) ─► cache ─► Probe
  │     NEEDS_LOGIN and a sign-in is saved?
  │        └─ runner.run(probeArgs(url), login:true) ─► … as above, Probe.login = true
  └─ otherwise throw YoinkError(code)
```

Why "anonymous first": most links need no login, and sending a saved session to a site that doesn't need it
is pointless and, for some sites (YouTube), risks the account being flagged for automated use.

## Flow: a download (the retry ladder)

```
execute(job)
 └─ attempt(useInfo, login):  runner.run(downloadArgs(...)) while DownloadTracker reads each line
       exit 0 and a final path ─► done
       cancelled ─► delete partial files ─► stop
       otherwise ─► classify the error, then:
            NEEDS_LOGIN, no login used yet, one is saved ─► try again WITH the login
            used a saved lookup (infoRef)               ─► try again with a FRESH lookup (links expired)
            else                                         ─► status "error"
```

Two different failures look similar but need different cures, hence the ladder: *"the site wants a login"* and
*"the saved download links expired after an hour"*.

## Job state

```
        batch()                       download()
          │                               │
       queued ─► fetching ─► running ◄────┘
                    │           │  ▲
                    │           │  └── processing: true while ffmpeg merges / converts
                    ▼           ▼
                  error  ◄───── error ───► retry()  (back to fetching or running)
                                 running ─► done
   cancel() removes the job from any state
```

Jobs are **immutable snapshots**: every change replaces the object, so `===` comparisons and React-style
change detection work, and a UI can't corrupt engine state.

## The batch queue

`runPool(jobs, concurrency, processBatchJob)`: N lanes each take the next job when free, so one slow video
doesn't hold up the others. Each job does its **own** look-up and download (not "look everything up, then download
everything"), so the first file arrives quickly. A failing job is caught inside the worker; the pool never sees it.

## Sign-in

The engine doesn't know *how* to sign in; it knows *when* and *what happens next*:

1. A job fails with `NEEDS_LOGIN`, carrying the `SignInSite` that would unlock it.
2. Your UI calls `yoink.signIn(site)` → your `Authenticator.signIn(site)` does the platform's thing and resolves
   when a login is saved where the `Runner` can read it.
3. The engine records the site as signed in and retries every job that was waiting on it.
4. From then on, a lookup/download that fails with `NEEDS_LOGIN` is retried once with `login: true`.

The `Runner` and `Authenticator` must agree on where the saved login lives (usually one cookies.txt). The runner
copies it per run (see YT-DLP-NOTES §Cookies).

## What is *not* here, on purpose

- **Anything a user reads.** Wording belongs to the host: a TV, a phone and a terminal say it differently.
- **History / "recent" lists.** That's UX state. The engine gives you `done` jobs with titles and paths.
- **File management** (moving, deduplicating, library layout). Use `onDownloaded` and `policy.outputTemplate`.
- **Update checking / release tooling.** That's the Yoink *app*, not the engine.
- **Playlists.** Every command passes `--no-playlist`. A playlist is a different problem (many items per link).

## Design principles (what to preserve when changing it)

1. **One implementation per idea.** If you find yourself writing the same rule in a host, it belongs here.
2. **Data out, events for change.** No callbacks that return UI.
3. **Defaults for everything, override at the seams.** `policy`, ports, `onDownloaded`.
4. **Test against reality.** Parser tests use recorded yt-dlp output; change a regex → re-record and diff.
5. **Fail soft per item.** One bad link, one bad listener, one failed cleanup never takes down the rest.
