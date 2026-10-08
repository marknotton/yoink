# Releasing Yoink

Builds are published as **GitHub Releases** on this repo. There is no other update server.
Every release carries a `latest.json` manifest; every installed copy reads it to find out whether it's out of date.

The repo must stay **public**. An installed app has no GitHub token, so it can't read assets from a private repo.

> **Tags are `app-vX.Y.Z`, not `vX.Y.Z`.** This repo is a fork, so Pablo's original tags (`v0.1.1`, `v0.2.0`, `v0.3.x`) come
> with it. A plain `vX.Y.Z` would collide with them as soon as our version numbers caught up.

## One-time setup

You need two secrets. Make them once, and **back both up now** (password manager, encrypted drive, anywhere that isn't this laptop alone).

```sh
yarn updater:keygen     # macOS update-signing key
yarn android:keystore   # Android release keystore
```

| Secret | Lives in | If you lose it |
| --- | --- | --- |
| Updater key (+ its password) | `src-tauri/signing/updater.key` | Installed copies can **never auto-update again**. Everyone reinstalls by hand. |
| Android keystore (+ password) | `src-tauri/signing/yoink.jks`, `keystore.properties` | Android refuses updates signed with a different certificate. Everyone uninstalls and reinstalls, losing the app's data. |

Both are gitignored. `updater:keygen` also writes the public key into `tauri.conf.json` and switches
`createUpdaterArtifacts` on, so **commit that change**. Both commands refuse to overwrite an existing key unless you
type `REPLACE`, and they move the old one aside rather than deleting it.

### Things worth knowing

- **The first signed Android release can't install over a debug build.** Debug and release APKs have different
  certificates, so uninstall the debug one once. After that, updates install over the top.
- **The Android signing config lives in `src-tauri/gen/android/app/build.gradle.kts`**, which `tauri android init`
  regenerates. If you ever re-init and release APKs come out *unsigned*, re-apply the `keystoreProps` /
  `signingConfigs` / `signingConfig` blocks (they read `src-tauri/signing/keystore.properties`).
- `versionCode` must strictly increase, or Android rejects the APK as a downgrade. Tauri derives it from the
  version (`major*1,000,000 + minor*1,000 + patch`), so a normal bump is enough. Never re-publish a version with a
  different build.

## Releasing

Commit your work first. The script refuses to run on a dirty tree, so the tag always contains what was built.

```sh
yarn release patch                      # 0.1.0 → 0.1.1, both platforms
yarn release minor --notes="Playlists!" # 0.1.1 → 0.2.0
yarn release patch --targets=mac        # macOS only
yarn release patch --targets=android    # Android only
```

For CI, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (an empty value is valid) so it doesn't prompt.

What it does, in order: bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`; checks the signing key
really signs (before spending ten minutes compiling); builds; collects the files under stable names; writes
`latest.json`; commits the bump and pushes; then creates a **draft** release, uploads everything with the manifest last,
and only then flips it to published. That final flip is the moment the update goes live, so nobody can ever see a
manifest that points at a file that hasn't finished uploading.

| Flag | What it does |
| --- | --- |
| `--dry-run` | Prints every command and the manifest it would write. Builds, writes and uploads nothing. |
| `--no-build` | Re-stages and re-publishes the last build's files. Use it to fix a manifest. |
| `--no-publish` | Builds and stages into `release-staging/`, then stops before touching git or GitHub. |
| `--targets=mac,android` | Which platforms to build. |
| `--notes="…"` | Release notes, also shown in the in-app update prompt. |

### Releasing one platform

A single-platform release keeps the other platform's entry in `latest.json` with **its own version**, so each platform
is only ever told about its own newer builds. For the macOS entry, the script strips the updater `url` and `signature`
when carrying it forward (the updater compares the *top-level* version, and would otherwise install an old artifact and
then offer it again forever). The human installer link stays.

## How the apps use it

- **macOS** uses the Tauri updater: it downloads the signed `.app.tar.gz`, verifies it against the baked-in public key,
  installs and restarts.
- **Android** can't self-update, so it reads the same manifest and offers a **Download** button that opens the APK. The
  system installer does the rest, asking for confirmation.
- Both check about 10 seconds after launch, then hourly, and quietly ignore failures. "Later" hides a prompt for that
  version only. **About → Check for updates** is the manual version.
- The manifest is fetched through Tauri's HTTP plugin (from Rust), not the webview. GitHub's release CDN doesn't send
  CORS headers, so a webview `fetch` would be blocked.

## Fixing a bad manifest

If a release went out with a wrong URL or platform key, fix the code and re-publish the **same** version's files:

```sh
yarn release current --no-build
```

It uploads with `--clobber`, replacing the manifest and files on the existing release without a rebuild.
You can also edit `latest.json` by hand in `release-staging/` and upload it:

```sh
gh release upload app-vX.Y.Z release-staging/latest.json --clobber --repo marknotton/yoink
```

## Testing the whole chain

1. `yarn release patch` for version A, with both platforms, then install both.
2. `yarn release patch --targets=mac` for version B. The Mac should update in-app, the phone should **not** prompt,
   and the new `latest.json` should still list `android-arm64` at version A.
3. `yarn release patch --targets=android` for version C. The phone should offer the download and install it over the
   top without uninstalling.
