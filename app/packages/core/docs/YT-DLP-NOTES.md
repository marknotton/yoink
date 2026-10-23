# yt-dlp, ffmpeg and cookies: hard-won notes

Facts learned building Yoink, each of which cost real debugging. Read before bundling binaries or writing a Runner.

## Getting the binaries (no installer, no Python)

| What | Where | Notes |
| --- | --- | --- |
| yt-dlp, macOS | `yt-dlp_macos` from yt-dlp's GitHub releases | A **universal2** PyInstaller build: one file runs on Apple Silicon and Intel. |
| yt-dlp, Linux | `yt-dlp_linux`, `yt-dlp_linux_aarch64` | Standalone. |
| yt-dlp, Windows | `yt-dlp.exe` | Standalone. |
| ffmpeg (static) | e.g. `eugeneware/ffmpeg-static` releases (`ffmpeg-darwin-arm64`, `ffmpeg-darwin-x64`, …) | Only `ffmpeg` is needed; merging and mp3 work without `ffprobe`. |

Check a bundled binary links only system libraries: `otool -L <binary>` (macOS) should list only `/usr/lib/*` and
`/System/*`. Never use Homebrew-built binaries: they point at Homebrew dylibs that don't exist elsewhere.

The standalone yt-dlp unpacks itself on every start, so a run costs ~1 s before any network. That's normal.

**yt-dlp goes stale.** Sites change weekly; a pinned binary slowly breaks. Plan to update it (`yt-dlp -U` for
standalone builds, or re-download). On Android the library can self-update in the background.

## macOS packaging traps

- **Hardened runtime breaks the bundled yt-dlp.** Ad-hoc signing with the hardened-runtime flag makes macOS refuse
  to let yt-dlp load the Python library it unpacks ("different Team IDs"). Turn hardened runtime **off** (it's only
  needed for notarisation), or add the `com.apple.security.cs.disable-library-validation` entitlement.
- **An unsealed bundle is reported as "damaged"** when downloaded through a browser (quarantine flag + a bundle
  with no sealed resources). Sign the *whole* bundle ad-hoc (`codesign --force --deep --sign -`), or notarise.
- Verify with `codesign --verify --deep --strict App.app`, and run the bundled yt-dlp from the *signed* copy.

## Reading the output

- Use `--newline --no-quiet --progress --progress-template "download:YOINK|…" --print after_move:filepath
  --no-simulate`. **`--print` implies `--quiet`**, which hides progress and the `[Merger]` lines, so `--no-quiet`
  is required. (`args.ts` already does this.)
- **Progress fields are `NA`/`None` when unknown.** Speed and ETA are often unknown at the start; `total_bytes` is
  often only an *estimate* (`total_bytes_estimate`).
- **Two streams = two progress runs.** Separate video and audio download one after the other and the byte counter
  restarts at 0 in between. The parser counts a "part" each time it drops.
- **`Downloading 1 format(s): 133+140`**: the `+`-separated ids are how many files to expect.
- The **final path is the last bare absolute-path line** (from `--print after_move:filepath`); it's the only
  reliable way to learn the real filename after merging and renaming.
- `[Merger] Merging formats into "…"` and `[ExtractAudio] Destination: …` mean the download finished and ffmpeg is
  working. Show "Processing…".
- Errors are `ERROR: [extractor] video-id: message` on **stderr**. Take the last one.

## Cancelling

Send **SIGTERM**, never SIGKILL. The standalone yt-dlp is a launcher that spawns the real process; SIGTERM is
forwarded, SIGKILL orphans it and it keeps downloading. After a cancel, delete the files the output named plus
`<file>.part` and `<file>.ytdl`.

## Saved lookups (`--load-info-json`)

Saving the lookup's JSON and passing it back makes a download start almost instantly (no re-extraction). But the
media URLs inside it **expire (about an hour for YouTube)**. So: reuse it for ~1 h, and when a download fails with
one, retry once with a fresh extraction. The engine does both.

## Cookies (logins)

- yt-dlp reads **Netscape-format cookies.txt**: header `# Netscape HTTP Cookie File`, then seven tab-separated
  fields per cookie. HttpOnly cookies are written as `#HttpOnly_<domain>`. Session cookies need an expiry (use
  ~1 year ahead) or they're discarded.
- **yt-dlp rewrites the cookie file on exit.** Several runs sharing it can corrupt it. **Give each run a private
  copy** and delete it after. This matters as soon as a batch runs more than one yt-dlp at once.
- **Only send a login when the site asks for one.** The first attempt is anonymous; retry with the login on
  `NEEDS_LOGIN`. (Sending an account's cookies to every site is pointless, and YouTube warns that using cookies
  with yt-dlp can get an account flagged.)
- Make the cookie file `0600`. Never log cookie values. If you must show diagnostics, show **names** only.

## Sites

**Reddit** blocks anonymous requests outright (even the JSON endpoint returns 403). *Every* Reddit video needs a
login: `Account authentication is required. Use --cookies-from-browser or --cookies`. Anonymous visitors get a
`token_v2` cookie whose JWT `sub` is `"loid"`; a logged-in one's `sub` is `"user"`. A `reddit_session` cookie may be
absent for a logged-in session, so test the token, not just the name. Emailed "magic links" open in the user's
browser, not your app.

**YouTube:**
- H.264 (`avc1`) video is offered **up to 1080p only**; above that it's VP9/AV1. QuickTime/Quick Look can't play
  VP9/AV1 inside an mp4 (VLC can). Pair H.264 with m4a (AAC), not Opus.
- yt-dlp may warn that no JavaScript runtime was found. It works today, but extraction without one is deprecated.
- "Sign in to confirm you're not a bot" means it wants cookies (`NEEDS_LOGIN`).
- DASH formats usually have **no `filesize`**; estimate `tbr × 1000 / 8 × duration`. If you show only the audio
  track's size for every resolution, every row looks identical.

**Instagram / X / TikTok / Threads** often need a login too. Embedded sign-in windows work for them; Google sign-in
(for YouTube) often refuses embedded windows.

## Android

- The `youtubedl-android` library bundles Python, yt-dlp and ffmpeg inside the APK.
- **Turn R8/minification OFF for release builds.** It scrambles the library's reflection-based internals and the app
  crashes a second after launch (`ExceptionInInitializerError: class n7 is not a concrete class` on the init thread).
  Debug builds don't run R8, which is why this only shows up in release.
- Save finished files through **MediaStore** (`Downloads` collection, `RELATIVE_PATH = "Download/<App>"`): no
  storage permission needed on modern Android. Find them again by display name + path (use `LIKE` on the folder).
- `POST_NOTIFICATIONS` needs a runtime request on Android 13+.
- `WebView` sign-in: remove `; wv` from the user agent string.

## Playlists, and other things deliberately unsupported

Every command uses `--no-playlist`. A playlist link downloads the single video it points at. Playlists are
"many items from one link", a different problem (and a different UI).
