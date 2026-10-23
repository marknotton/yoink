import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Authenticator, RunHandlers, RunRequest, RunResult, Runner, SignInSite } from "@marknotton/yoink-core"

// ── Running yt-dlp from Node ──────────────────────────────────────
// The reference implementation of the Runner seam. If you're writing a Runner for another platform,
// this is the behaviour to match.

export type NodeRunnerOptions = {
  /** Full path to yt-dlp. Required: nothing is looked up on PATH, so it works on a machine with nothing installed. */
  ytDlp: string
  /** Full path to ffmpeg. Needed to merge video and audio, or make an mp3. Passed as --ffmpeg-location. */
  ffmpeg?: string
  /** A Netscape cookies.txt holding saved sign-ins. Runs that ask for a login get a private copy of it. */
  cookiesFile?: string
  /** Environment for yt-dlp. Default: this process's. */
  env?: NodeJS.ProcessEnv
  /** Extra arguments added to every run, e.g. ["--proxy", "socks5://…"]. */
  extraArgs?: string[]
}

export interface NodeRunner extends Runner {
  storeInfo(json: string): Promise<string>
  removeFiles(paths: string[]): Promise<void>
  /** Delete the temporary lookup files this runner wrote. Call when you're done. */
  dispose(): Promise<void>
}

// split a stream into lines as the chunks arrive; a lookup's JSON is one very long line
function lineSplitter(onLine: (line: string) => void) {
  let rest = ""
  return {
    push(chunk: string) {
      rest += chunk
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const line of lines) onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
    },
    end() {
      if (rest) onLine(rest)
      rest = ""
    },
  }
}

export function createNodeRunner(options: NodeRunnerOptions): NodeRunner {
  const children = new Map<string, ChildProcess>()
  const cancelled = new Set<string>()
  const infoFiles: string[] = []
  let counter = 0
  const tmp = (name: string) => path.join(os.tmpdir(), `yoink-${process.pid}-${++counter}-${name}`)

  async function run(request: RunRequest, handlers: RunHandlers): Promise<RunResult> {
    const args = [...request.args]
    if (options.ffmpeg) args.push("--ffmpeg-location", options.ffmpeg)
    args.push(...(options.extraArgs ?? []))

    // yt-dlp rewrites its cookie file when it exits, so each run gets its own copy
    let cookiesCopy: string | undefined
    if (request.login && options.cookiesFile) {
      cookiesCopy = tmp("cookies.txt")
      try {
        await fs.copyFile(options.cookiesFile, cookiesCopy)
        args.push("--cookies", cookiesCopy)
      } catch {
        cookiesCopy = undefined // no saved login after all: carry on anonymously
      }
    }

    try {
      return await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(options.ytDlp, args, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
        children.set(request.runId, child)
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        const out = lineSplitter(handlers.onStdout)
        const err = lineSplitter(handlers.onStderr)
        child.stdout.on("data", (c: string) => out.push(c))
        child.stderr.on("data", (c: string) => err.push(c))
        child.on("error", (e) => {
          children.delete(request.runId)
          reject(e)
        })
        child.on("close", (code) => {
          out.end()
          err.end()
          children.delete(request.runId)
          const wasCancelled = cancelled.delete(request.runId)
          resolve({ exitCode: code, cancelled: wasCancelled })
        })
      })
    } finally {
      if (cookiesCopy) await fs.rm(cookiesCopy, { force: true })
    }
  }

  async function cancel(runId: string): Promise<void> {
    const child = children.get(runId)
    if (!child) return
    cancelled.add(runId)
    // SIGTERM, not SIGKILL: yt-dlp's standalone build is a launcher that has to pass the signal on to the
    // real process, or that process is orphaned
    child.kill("SIGTERM")
  }

  async function storeInfo(json: string): Promise<string> {
    const file = tmp("info.json")
    await fs.writeFile(file, json)
    infoFiles.push(file)
    return file
  }

  async function removeFiles(paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => fs.rm(p, { force: true })))
  }

  async function dispose(): Promise<void> {
    await removeFiles(infoFiles.splice(0))
  }

  return { run, cancel, storeInfo, removeFiles, dispose }
}

// ── Logins on a server ────────────────────────────────────────────
// A server can't show a login page, so sign-ins arrive as a cookies.txt exported from a browser where
// the user is already logged in. This Authenticator keeps that file.

const HEADER = "# Netscape HTTP Cookie File"
const domainOf = (line: string) => (line.split("\t")[0] ?? "").replace(/^#HttpOnly_/, "").replace(/^\./, "").toLowerCase()
const isCookieLine = (line: string) => line.split("\t").length >= 7 && (!line.startsWith("#") || line.startsWith("#HttpOnly_"))
const matches = (domain: string, targets: string[]) => targets.some((t) => domain === t || domain.endsWith(`.${t}`) || t.endsWith(`.${domain}`))

export interface CookiesFileAuthenticator extends Authenticator {
  /** Add cookies from a cookies.txt (as exported by a browser extension), replacing the same domains. */
  importCookies(text: string): Promise<{ added: number; domains: string[] }>
  /** Is there a saved login for this site? `signIn(site)` resolves exactly when this is true. */
  has(site: SignInSite): Promise<boolean>
}

export function cookiesFileAuthenticator(file: string): CookiesFileAuthenticator {
  const read = async () => {
    try {
      return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(isCookieLine)
    } catch {
      return []
    }
  }
  const write = async (lines: string[]) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${HEADER}\n${lines.join("\n")}\n`, { mode: 0o600 }) // a login: private to this user
  }

  const has = async (site: SignInSite) => (await read()).some((l) => matches(domainOf(l), site.domains))

  return {
    // A server can't show a login page. This succeeds once a login for the site has been imported, so the
    // flow is: importCookies(text), then yoink.signIn(site), which records it and retries waiting jobs.
    async signIn(site) {
      if (await has(site)) return
      throw new Error(
        `Yoink can't open a login page on a server. Log in to ${site.label} in a browser, export its cookies as a cookies.txt ` +
          `(a browser extension can do this), and pass the text to importCookies().`,
      )
    },
    async signOut(site) {
      await write((await read()).filter((l) => !matches(domainOf(l), site.domains)))
    },
    async importCookies(text) {
      const incoming = text.split(/\r?\n/).filter(isCookieLine)
      const domains = [...new Set(incoming.map(domainOf))].sort()
      await write([...(await read()).filter((l) => !matches(domainOf(l), domains)), ...incoming])
      return { added: incoming.length, domains }
    },
    has,
  }
}
