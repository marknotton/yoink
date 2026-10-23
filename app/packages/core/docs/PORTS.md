# Ports: what you implement for your platform

The engine asks the outside world for three things. Only the **Runner** is required.

| Port | Required | Job | Reference implementation |
| --- | --- | --- | --- |
| `Runner` | yes | Start yt-dlp, stream its lines, stop it | `@marknotton/yoink-runner-node` |
| `Authenticator` | only if you offer sign-in | Let a user log in to a site; save the session | `cookiesFileAuthenticator` (server); desktop window, Android WebView and TV flows below |
| `Storage` | no | Remember the lookup cache and which sites are signed in | `memoryStorage()` (default) |

---

## Runner

```ts
interface Runner {
  run(request: RunRequest, handlers: RunHandlers): Promise<RunResult>
  cancel(runId: string): Promise<void>
  storeInfo?(json: string): Promise<string>
  removeFiles?(paths: string[]): Promise<void>
}
type RunRequest  = { runId: string; args: string[]; login?: boolean }
type RunHandlers = { onStdout(line: string): void; onStderr(line: string): void }
type RunResult   = { exitCode: number | null; cancelled: boolean }
```

### The contract

1. **Run yt-dlp with exactly `request.args`**, plus whatever your platform adds (see 4 and 5). Never reorder or
   edit the engine's arguments.
2. **Stream lines as they happen.** `onStdout` is called once per complete line, as it arrives. The progress bar
   depends on this. Don't buffer until exit.
3. **Lines can be enormous.** A lookup prints its whole JSON as *one* line (hundreds of KB). Don't cap line length.
   Split on `\n`, strip a trailing `\r`, decode UTF-8 across chunk boundaries, and flush any final unterminated line
   when the process ends.
4. **Supply ffmpeg.** If you bundle one, append `--ffmpeg-location <path>`. Without ffmpeg, merging video+audio and
   mp3 conversion fail.
5. **If `request.login` is true, add `--cookies <file>` pointing at your OWN COPY of the saved cookie file.**
   yt-dlp rewrites that file when it exits. Concurrent runs sharing one file corrupt it. Copy per run, delete
   afterwards. If no login is saved, carry on without it.
6. **Resolve with `{ exitCode, cancelled }`.** `exitCode` is `null` if the process was killed by a signal. `cancelled`
   must be `true` if `cancel(runId)` stopped it. Never reject for a non-zero exit; reject only if yt-dlp *couldn't
   start*.
7. **`cancel(runId)` must send SIGTERM (or the platform's polite equivalent), not SIGKILL.** The standalone yt-dlp
   is a launcher process; killing it hard leaves the real downloader running. Calling `cancel` for a run that
   already finished is a no-op.
8. **Never rely on PATH.** Take explicit paths so the app works on a machine with nothing installed.
9. **`storeInfo(json)` (optional)** saves a lookup's JSON where yt-dlp can read it back and returns a handle (a file
   path). The engine passes it as `--load-info-json <handle>`, which makes a download start almost instantly. If you
   don't implement it, every download re-extracts the link first (a few seconds slower).
10. **`removeFiles(paths)` (optional)** deletes files, ignoring ones that don't exist. Used to remove `.part` /
    `.ytdl` / `.f123.mp4` pieces after a cancel.

`runId` is unique among runs in flight (the engine uses the job id for downloads, `probe-<n>` for lookups).

### Contract tests

`packages/runner-node/tests/runner.test.mjs` is the executable specification. Port its cases to your platform:

| Case | What it proves |
| --- | --- |
| arguments pass through; ffmpeg location and extras are added | rules 1, 4 |
| one 500 KB line, stderr lines, exit code 3 | rules 2, 3, 6 |
| a run that sleeps, then `cancel` | rule 7: SIGTERM received, `cancelled: true` |
| two concurrent `login` runs | rule 5: different cookie files, both deleted afterwards |
| `login` with no saved file | rule 5: carries on anonymously |
| `storeInfo` then `dispose` | rule 9 |

It uses a fake yt-dlp executable (`tests/fake-ytdlp.mjs`) so it needs no network.

### Sketches for other platforms

> These show the *shape*. They're illustrative; adapt them to your stack.

**Tauri (desktop).** Rust spawns yt-dlp as a bundled sidecar and emits each line to the webview; JS adapts it to a Runner.

```ts
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { Runner } from "@marknotton/yoink-core"

export const tauriRunner: Runner = {
  async run({ runId, args, login }, { onStdout, onStderr }) {
    const off = await listen<{ runId: string; stream: "out" | "err"; line: string }>("ytdlp-line", (e) => {
      if (e.payload.runId !== runId) return
      ;(e.payload.stream === "out" ? onStdout : onStderr)(e.payload.line)
    })
    try {
      // Rust: spawn the sidecar with args (+ --ffmpeg-location, + --cookies <private copy> if login),
      // emit "ytdlp-line" for each line, return { exitCode, cancelled }
      return await invoke("run_ytdlp", { runId, args, login: !!login })
    } finally {
      off()
    }
  },
  cancel: (runId) => invoke("cancel_ytdlp", { runId }),
}
```

**Android (Kotlin).** The youtubedl-android library's `execute(request, processId, callback)` calls back per output line.
Keep a per-run line buffer in the plugin; the JavaScript runner drains it by polling a `drainLines(runId)` command
every ~300 ms (Tauri's Android plugins have no event channel), and `cancel` calls `destroyProcessById(runId)`.
The `Runner` contract is the same; only the transport differs.

**Electron.** Run `createNodeRunner` in the main process; expose `run`/`cancel` to the renderer over `ipcMain`/
`ipcRenderer` with the line callbacks sent as IPC messages. Or run `createYoink` itself in the main process and
send `YoinkEvent`s to the renderer. (The latter is simpler and usually better.)

**A remote worker.** A `Runner` can call a service: POST the arguments, read an SSE stream of lines. The engine
neither knows nor cares that yt-dlp is on another machine.

---

## Storage

```ts
interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}
```

Keys the engine uses: `signins` (an array of site ids) and `probe:<url>` (a cached `Probe`). Values are JSON-safe.
Failures to write are ignored, so a full disk or blocked storage degrades to "no cache", never to an error.

```ts
// browser / WebView
const localStorageStorage: Storage = {
  async get(k) { try { const v = localStorage.getItem(k); return v === null ? undefined : JSON.parse(v) } catch { return undefined } },
  async set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
  async delete(k) { try { localStorage.removeItem(k) } catch {} },
}
```

Don't use storage for secrets: the saved *login* belongs to the Runner/Authenticator (a private cookie file), not here.

---

## Authenticator

```ts
interface Authenticator {
  signIn(site: SignInSite): Promise<void>   // resolves once a login is saved where the Runner can read it
  signOut(site: SignInSite): Promise<void>
}
```

The engine only needs to know it worked. *How* is per-platform. The shared data you work from is `SignInSite`:
`loginUrl`, `cookieUrls`, `markers` (proof of a login), `domains`.

### The shape of a "show a login page" Authenticator (desktop, Android)

This is how Yoink's desktop app does it, and it took four attempts to get right; follow it closely.

1. **Open the site's own login page** (`site.loginUrl`) in an **isolated** browser session (incognito / its own
   data store), so nothing lingers and the user isn't auto-logged-in from an earlier session.
2. **Poll the window's cookies** for `site.cookieUrls` every ~1.5 s and test each `site.markers` rule:
   - a bare `{ name }` rule: *a cookie with this name exists*.
   - a rule with `jwtSubNot`: the cookie's value is a JWT; decode its payload **locally** and require that its
     `sub` claim is **not** one of the listed anonymous subjects.
   Reddit is why: a logged-out visitor already receives a `token_v2` cookie, but its `sub` is the literal
   `"loid"`; a logged-in one names the user. Counting "any token_v2" signed everyone in instantly.
3. When a marker is satisfied, **wait ~2 s** (the site sets more cookies just after), then **read all cookies for
   `site.cookieUrls`**.
4. **Write them to the cookie file the Runner uses** (Netscape `cookies.txt`):
   - seven tab-separated fields: `domain  includeSubdomains  path  secure  expiry  name  value`
   - HttpOnly cookies get a `#HttpOnly_` prefix on the domain
   - session cookies (no expiry) get an expiry about a year out, or yt-dlp drops them
   - **merge**: replace existing lines for the same domains, keep other sites
   - file permissions `0600`: it's a login
5. **Close the window, resolve.**
6. If `site.markers` is empty (unknown site), show a **Done** button instead of auto-detecting, and still refuse
   if no cookies were found. Offer "save anyway" only if you also show what was found (names only, never values).

**Never claim success without evidence of a login.** The most common bug is saving whatever cookies exist when
the user presses Done: a logged-out visitor has several.

### Three things users will do that you must handle

- **"Email me a link."** The magic link arrives in their mail app and opens in their *default browser*, which can't
  hand the session to your app. Offer a "paste the link here" box that **navigates the sign-in window** to it
  (accept only the site's own domains). And never let a pasted login link reach the downloader: it fails with
  "Unsupported URL". `isSignInLink(url)` recognises them.
- **"Continue with Google/Apple."** These often open a pop-up that embedded windows block, so the login never
  completes. Say "log in with email or username and password" in your UI.
- **Pasting while a dialog is open.** Don't treat text pasted into a dialog's own input as a link to download.

### Platform patterns

| Platform | Pattern |
| --- | --- |
| Desktop (Tauri/Electron) | A second window with the login page; read its cookie store (Tauri: `WebviewWindow::cookies_for_url`; Electron: `session.cookies.get`). |
| Android | A full-screen dialog with a `WebView`; read `CookieManager.getInstance().getCookie(url)` (gives `name=value; …`; write them as `.domain`, path `/`, secure, expiry +1 year). Remove the `; wv` from the user agent: some sites (Google) block WebViews. |
| **Android TV / living-room devices** | Typing a password with a remote is miserable, and many TV WebViews can't do it. Prefer a **second-screen** flow: show a short code/QR; the user signs in on their phone or computer (a tiny page you host, or the phone app); the cookies are handed to the TV. Or import a cookies file. Same port; different `signIn`. |
| Server / NAS | No UI. `cookiesFileAuthenticator(file)` keeps a cookies.txt; the user exports one from a logged-in browser and calls `importCookies(text)`. `signIn()` rejects with instructions. |

### Sign-out
Remove the lines for `site.domains` from the cookie file (and clear the window's own store if you kept one).

---

## What the Runner and Authenticator must agree on

The Authenticator **writes** the saved login; the Runner **reads** it (a private copy per run). They must point at
the same file. In `@marknotton/yoink-runner-node` that's the `cookiesFile` option and `cookiesFileAuthenticator(file)`.
