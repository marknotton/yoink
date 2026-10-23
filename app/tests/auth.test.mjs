import { test } from "node:test"
import assert from "node:assert/strict"
import { loadLib } from "./load-ts.mjs"

const { siteForUrl, needsLogin, SITES } = await loadLib("auth")

test("finds the site whose login unlocks a link", () => {
  assert.equal(siteForUrl("https://www.reddit.com/r/x/comments/1/y/").id, "reddit")
  assert.equal(siteForUrl("https://v.redd.it/abc").id, "reddit")
  assert.equal(siteForUrl("https://twitter.com/a/status/1").id, "x")
  assert.equal(siteForUrl("https://youtu.be/abc").id, "youtube")
  const other = siteForUrl("https://www.example.org/watch/1")
  assert.equal(other.label, "example.org")
  assert.deepEqual(other.markers, [], "an unknown site can't be auto-detected, so the user presses Done")
})

test("recognises yt-dlp's 'you need to log in' wording", () => {
  assert.ok(needsLogin("[Reddit] 1xd5von: Account authentication is required. Use --cookies-from-browser or --cookies"))
  assert.ok(needsLogin("ERROR: login required. Use --cookies"))
  assert.ok(needsLogin("Sign in to confirm you’re not a bot"))
  assert.ok(!needsLogin("This video is unavailable"))
  assert.ok(!needsLogin("HTTP Error 404: Not Found"))
})

test("Reddit's token_v2 is not a login marker (it is also given to logged-out visitors)", () => {
  const reddit = SITES.find((s) => s.id === "reddit")
  assert.deepEqual(reddit.markers, ["reddit_session"])
})
