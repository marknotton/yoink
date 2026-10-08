# Yoink

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="yoink" width="288">
</picture>

A desktop and Android app for downloading videos. Paste a link, pick a quality, done.

It works with YouTube, X/Twitter, Instagram, Threads, TikTok and 1,800+ other sites. It's a graphical version of
[yoinks](https://github.com/pablostanley/yoinks) by Pablo Stanley, for people who would rather not use a
terminal.

<p align="center">
  <img src="assets/gui-home.png" alt="Yoink home screen" width="49%">
  <img src="assets/gui-formats.png" alt="Yoink format picker" width="49%">
</p>

## Features

- **Paste and go.** Paste a link anywhere on the first screen and it fetches straight away.
- **A sensible format list.** One row per resolution with an estimated size, plus audio-only mp3. If a video
  only comes in one quality, it asks whether you want video with audio, or audio only.
- **Plays everywhere on Apple devices.** It prefers H.264 and AAC, so files open in QuickTime and Quick Look.
  Above 1080p, YouTube only offers VP9 and AV1, and those rows are labelled so you know what you're getting.
- **Several downloads at once.** Start one, go back, paste another. Each has its own progress bar and cancel
  button.
- **Recent links** with titles, and a Clear button.
- **Self-contained.** yt-dlp and ffmpeg are bundled, so a Mac with nothing installed can run it.
- **Updates itself.** It checks this repo's Releases and offers new versions in the app. On Android it offers
  the download.
- **Android version.** Files are saved to `Download/Yoink` and you get a notification when they finish.

<p align="center">
  <img src="assets/gui-downloads.png" alt="Yoink running several downloads at once" width="49%">
  <img src="assets/gui-about.png" alt="Yoink About dialog" width="49%">
</p>

## Install

Download the latest build from [Releases](https://github.com/marknotton/yoink/releases).

**macOS (Apple Silicon).** Open the `.dmg` and drag Yoink to Applications. The app isn't notarised, so the first
time you open it, right-click it and choose **Open**. If macOS says the app is "damaged", run this once:

```sh
xattr -cr /Applications/Yoink.app
```

**Android.** Open the `.apk` on your phone and allow installs from that source when asked. Requires Android 7 or
newer on a 64-bit ARM device.

Both apps check for updates after launch. **About → Check for updates** does it on demand.

## Build from source

The app lives in [`app/`](app) and is built with [Tauri v2](https://tauri.app) (Rust) and React. You'll need
[Rust](https://rustup.rs), Node 18+ and Yarn 4 (`corepack enable`).

```sh
cd app
yarn install
yarn tauri:dev      # run while developing
yarn tauri:build    # build Yoink.app and a .dmg
```

`yarn setup` (run for you by those commands) downloads the yt-dlp and ffmpeg binaries the app bundles. Output
is in `app/src-tauri/target/release/bundle/`.

**Android** also needs the Android SDK and NDK, and JDK 21:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/<your-ndk-version>
export JAVA_HOME=/path/to/jdk-21
yarn tauri android build --debug --apk --target aarch64
```

On Android, yt-dlp, Python and ffmpeg come from
[youtubedl-android](https://github.com/yausername/youtubedl-android).

Publishing releases (signing keys, the update manifest) is covered in
[`app/docs/RELEASING.md`](app/docs/RELEASING.md).

## About this fork

This is a fork of [pablostanley/yoinks](https://github.com/pablostanley/yoinks), so I can bring in his changes
as they land. Everything at the root of the repo (`src/`, `package.json`) is the original terminal app,
untouched. Everything in [`app/`](app) is the GUI.

I'm not a terminal person, so I yoinked yoinks and gave it a window.

**It is entirely vibe-coded.** I described what I wanted, an AI ([Claude Code](https://claude.com/claude-code))
wrote it, and I tested and steered. It hasn't been audited and has no automated tests beyond the checks built
into the release scripts. It's been tried on an Apple Silicon Mac and a Pixel. Use it at your own risk.

To pull in upstream changes:

```sh
git fetch upstream
git merge upstream/main
```

The root `README.md` will conflict; keep this one. If the original changes how downloads work, the matching
logic is in [`app/src/lib/ytdlp.ts`](app/src/lib/ytdlp.ts) and
[`app/src-tauri/src/desktop.rs`](app/src-tauri/src/desktop.rs).

For comparison, the original in a terminal:

<img src="assets/download-options.png" alt="The original yoinks running in a terminal" width="55%">

## Fair use

This is a personal-archiving tool. Downloading content may violate a platform's terms of service. Only
download what you have the right to keep.

## Credits

Yoink is based on [**yoinks**](https://github.com/pablostanley/yoinks), created by
[Pablo Stanley](https://github.com/pablostanley). The concept, the download flow and the original terminal
interface are his work. This project is not affiliated with or endorsed by him.

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://ffmpeg.org),
[Tauri](https://tauri.app) and [youtubedl-android](https://github.com/yausername/youtubedl-android). Written
with [Claude Code](https://claude.com/claude-code).

## Licence

[MIT](LICENSE). The original copyright, held by Pablo Stanley, is retained.
