import { test } from "node:test"
import assert from "node:assert/strict"
import { isSignInLink, needsLogin, SITES, siteForUrl } from "../dist/index.js"

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

test("Reddit's token_v2 only proves a login when it isn't the anonymous 'loid' token", () => {
  const reddit = SITES.find((s) => s.id === "reddit")
  assert.ok(reddit.markers.some((m) => m.name === "reddit_session"))
  // token_v2 only counts when it does NOT belong to the anonymous "loid" subject
  const token = reddit.markers.find((m) => m.name === "token_v2")
  assert.deepEqual(token.jwtSubNot, ["loid"])
})

test("recognises emailed sign-in links so they are never treated as videos", () => {
  assert.ok(isSignInLink("https://www.reddit.com/magic_link/mlt:J8vVTV6DXWwGgWEbDpXLIFNR0UBApQ/t2_7q6qd?$deep_link=true&otp=true"))
  assert.ok(isSignInLink("https://www.reddit.com/login/"))
  assert.ok(!isSignInLink("https://www.reddit.com/r/singularity/comments/1xd5von/claude_made_a_documentary/"))
  assert.ok(!isSignInLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
})
