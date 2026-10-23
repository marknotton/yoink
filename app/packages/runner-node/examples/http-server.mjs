#!/usr/bin/env node
// Yoink as a small HTTP service: for apps that aren't JavaScript, or that want downloads in a separate process
// (a NAS box, a home server). JSON in, JSON out, and Server-Sent Events for live progress.
//
//   YT_DLP=/opt/yt-dlp FFMPEG=/opt/ffmpeg OUT_DIR=/volume1/downloads node examples/http-server.mjs
//
//   POST   /batch        {"text": "any text with links", "quality": "best"|"audio"}  → {jobs, duplicates, truncated}
//   POST   /probe        {"url": "..."}                                               → Probe (formats to choose from)
//   POST   /download     {"url": "...", "choice": 0}                                  → Job
//   GET    /jobs                                                                     → Job[]
//   GET    /events                                                                   → Server-Sent Events: every YoinkEvent
//   POST   /jobs/:id/retry · DELETE /jobs/:id (cancel) · POST /jobs/clear-finished
//   POST   /signin/cookies  {"cookies": "<contents of a cookies.txt>"}                → import a login (see README)
//
// Safe by default: listens on 127.0.0.1 only. To expose it, set HOST and TOKEN (clients send `Authorization: Bearer <TOKEN>`).
import http from "node:http"
import { createYoink, SITES } from "@marknotton/yoink-core"
import { cookiesFileAuthenticator, createNodeRunner } from "../dist/index.js"

const { YT_DLP, FFMPEG, OUT_DIR = "./downloads", COOKIES = "./cookies.txt", PORT = "8787", HOST = "127.0.0.1", TOKEN } = process.env
if (!YT_DLP) throw new Error("Set YT_DLP to the path of the yt-dlp binary.")
if (HOST !== "127.0.0.1" && !TOKEN) throw new Error("Refusing to listen on a network address without a TOKEN.")

const runner = createNodeRunner({ ytDlp: YT_DLP, ffmpeg: FFMPEG, cookiesFile: COOKIES, env: process.env })
const authenticator = cookiesFileAuthenticator(COOKIES)
const yoink = createYoink({ runner, outputDir: OUT_DIR, authenticator })

const clients = new Set()
yoink.subscribe((event) => {
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(frame)
})

const readBody = async (req) => {
  let text = ""
  for await (const chunk of req) text += chunk
  return text ? JSON.parse(text) : {}
}
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorised" })
    const { pathname } = new URL(req.url, "http://x")
    const route = `${req.method} ${pathname}`

    if (route === "GET /events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      res.write(`data: ${JSON.stringify({ type: "hello", jobs: yoink.getJobs() })}\n\n`)
      clients.add(res)
      req.on("close", () => clients.delete(res))
      return
    }
    if (route === "GET /jobs") return send(res, 200, yoink.getJobs())
    if (route === "POST /batch") {
      const { text, urls, quality } = await readBody(req)
      const { jobs, duplicates, truncated } = yoink.batch(text ?? urls ?? "", { quality })
      return send(res, 202, { jobs, duplicates, truncated })
    }
    if (route === "POST /probe") return send(res, 200, await yoink.probe((await readBody(req)).url))
    if (route === "POST /download") {
      const { url, choice = 0 } = await readBody(req)
      const probe = await yoink.probe(url)
      if (!probe.choices[choice]) return send(res, 400, { error: `choice ${choice} doesn't exist` })
      return send(res, 202, yoink.download(probe, probe.choices[choice]))
    }
    if (route === "POST /jobs/clear-finished") return yoink.clearFinished(), send(res, 200, { ok: true })
    if (route === "POST /signin/cookies") {
      const imported = await authenticator.importCookies((await readBody(req)).cookies)
      // tell the engine which sites now have a login: it retries any job that was refused for lack of one
      const signedIn = []
      for (const site of SITES) if (await authenticator.has(site)) (await yoink.signIn(site), signedIn.push(site.id))
      return send(res, 200, { ...imported, signedIn })
    }

    const job = pathname.match(/^\/jobs\/([^/]+)(\/retry)?$/)
    if (job && req.method === "DELETE") return await yoink.cancel(job[1]), send(res, 200, { ok: true })
    if (job && job[2] && req.method === "POST") return yoink.retry(job[1]), send(res, 202, { ok: true })

    send(res, 404, { error: "not found" })
  } catch (e) {
    // YoinkError carries a code the caller can act on (NEEDS_LOGIN, UNAVAILABLE, …)
    send(res, e.code ? 422 : 500, { error: e.message, code: e.code, site: e.site })
  }
})

server.listen(Number(PORT), HOST, () => console.log(`Yoink listening on http://${HOST}:${PORT}  (downloads → ${OUT_DIR})`))
process.on("SIGTERM", async () => (await runner.dispose(), server.close()))
