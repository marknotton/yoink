# @marknotton/yoink-runner-node

Runs yt-dlp from Node for [`@marknotton/yoink-core`](../core/README.md). Use it for servers, NAS tools, CLIs and tests.
It's also the **reference implementation of the `Runner` seam**: if you're writing a Runner for another platform,
[`src/index.ts`](./src/index.ts) is the behaviour to match.

```js
import { createYoink } from "@marknotton/yoink-core"
import { createNodeRunner } from "@marknotton/yoink-runner-node"

const runner = createNodeRunner({
  ytDlp: "/opt/yt-dlp",        // required, full path: nothing is looked up on PATH
  ffmpeg: "/opt/ffmpeg",       // needed to merge video+audio and to make mp3
  cookiesFile: "/data/cookies.txt",  // saved logins (optional)
})
const yoink = createYoink({ runner, outputDir: "/downloads" })
```

## What it does

- Streams yt-dlp's stdout/stderr **line by line as it arrives** (handles one enormous line, `\r\n`, UTF-8 split
  across chunks, a final unterminated line).
- Adds `--ffmpeg-location` and any `extraArgs`.
- For a run with `login: true`, gives yt-dlp **its own private copy** of the cookie file and deletes it after
  (yt-dlp rewrites the file on exit, so concurrent runs must not share one).
- `cancel()` sends **SIGTERM** (not SIGKILL): yt-dlp's standalone binary is a launcher that must pass it on.
- `storeInfo()` saves a lookup so downloads can skip re-extracting; `removeFiles()` cleans up after a cancel;
  `dispose()` deletes the temporary lookup files.

## Logins on a server

A server can't show a login page. `cookiesFileAuthenticator(file)` keeps a `cookies.txt`:

```js
import { cookiesFileAuthenticator } from "@marknotton/yoink-runner-node"
import { SITES } from "@marknotton/yoink-core"

const auth = cookiesFileAuthenticator("/data/cookies.txt")
const yoink = createYoink({ runner, outputDir: "/downloads", authenticator: auth })

// the user logs in to the site in a normal browser and exports its cookies as cookies.txt, then:
await auth.importCookies(uploadedText)
await yoink.signIn(SITES.find((s) => s.id === "reddit")) // resolves because a login now exists; retries waiting jobs
```

## Examples (run them)

- [`examples/headless-batch.mjs`](./examples/headless-batch.mjs): links from a file, best quality of each.
- [`examples/http-server.mjs`](./examples/http-server.mjs): the engine as an HTTP + Server-Sent-Events service
  for apps in any language. Localhost-only unless you set `HOST` and `TOKEN`.

## Tests

```sh
yarn test                                   # 12 tests, no network (fake yt-dlp)
YT_DLP=/path/yt-dlp FFMPEG=/path/ffmpeg yarn test   # + a real download with an empty environment
```
