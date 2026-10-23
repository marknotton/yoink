import type { SignInSite } from "./types.js"

// ── Signing in to sites that need it ─────────────────────────────
// Reddit (and sometimes Instagram, X, TikTok…) only share video with signed-in users. A host app
// shows the site's own login page however suits its platform; this table says where that page is,
// where the site's cookies live, and how to tell a real login from a logged-out visit.

export const SITES: SignInSite[] = [
  {
    id: "reddit",
    label: "Reddit",
    loginUrl: "https://www.reddit.com/login",
    cookieUrls: ["https://www.reddit.com/", "https://reddit.com/"],
    // token_v2 exists for logged-out visitors too, but then its subject is the literal "loid"
    markers: [{ name: "reddit_session" }, { name: "token_v2", jwtSubNot: ["loid"] }],
    domains: ["reddit.com"],
  },
  {
    id: "instagram",
    label: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login/",
    cookieUrls: ["https://www.instagram.com/"],
    markers: [{ name: "sessionid" }],
    domains: ["instagram.com"],
  },
  {
    id: "x",
    label: "X / Twitter",
    loginUrl: "https://x.com/i/flow/login",
    cookieUrls: ["https://x.com/", "https://twitter.com/"],
    markers: [{ name: "auth_token" }],
    domains: ["x.com", "twitter.com"],
  },
  {
    id: "tiktok",
    label: "TikTok",
    loginUrl: "https://www.tiktok.com/login",
    cookieUrls: ["https://www.tiktok.com/"],
    markers: [{ name: "sessionid" }],
    domains: ["tiktok.com"],
  },
  {
    id: "facebook",
    label: "Facebook",
    loginUrl: "https://www.facebook.com/login",
    cookieUrls: ["https://www.facebook.com/"],
    markers: [{ name: "c_user" }, { name: "xs" }],
    domains: ["facebook.com"],
  },
  {
    id: "threads",
    label: "Threads",
    loginUrl: "https://www.threads.net/login",
    cookieUrls: ["https://www.threads.net/", "https://www.threads.com/"],
    markers: [{ name: "sessionid" }],
    domains: ["threads.net", "threads.com"],
  },
  {
    id: "youtube",
    label: "YouTube",
    loginUrl: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F",
    cookieUrls: ["https://www.youtube.com/", "https://accounts.google.com/", "https://www.google.com/"],
    markers: [{ name: "SID" }, { name: "__Secure-3PSID" }],
    domains: ["youtube.com", "google.com"],
    note: "Google sometimes refuses sign-ins from embedded windows. Most YouTube videos don't need one.",
  },
]

const HOST_TO_SITE: Array<[RegExp, string]> = [
  [/(^|\.)reddit\.com$|(^|\.)redd\.it$/, "reddit"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)(facebook\.com|fb\.watch)$/, "facebook"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
]

/** Which site's login would unlock this link? Unknown sites get a plain "log in at their homepage". */
export function siteForUrl(url: string): SignInSite {
  let host = ""
  let origin = ""
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase()
    origin = u.origin
  } catch {
    // fall through to the generic entry
  }
  const id = HOST_TO_SITE.find(([re]) => re.test(host))?.[1]
  const known = SITES.find((s) => s.id === id)
  if (known) return known
  const bare = host.replace(/^www\./, "")
  return {
    id: bare || "site",
    label: bare || "this site",
    loginUrl: origin || url,
    cookieUrls: origin ? [`${origin}/`] : [],
    markers: [], // can't tell by itself: the user presses Done
    domains: bare ? [bare] : [],
  }
}


/** An emailed "log me in" link (Reddit's magic link and similar): it logs a browser in, it isn't a video. */
export const isSignInLink = (url: string) => /\/magic_link\/|[?&]otp=true\b|\/login\/?(\?|$)/i.test(url)

// ── A friendly name for the site a link belongs to ───────────────
export type Platform = { key: string; label: string }

const PLATFORMS: Array<{ hosts: string[]; platform: Platform }> = [
  { hosts: ["youtube.com", "youtu.be", "music.youtube.com"], platform: { key: "youtube", label: "YouTube" } },
  { hosts: ["x.com", "twitter.com"], platform: { key: "x", label: "X / Twitter" } },
  { hosts: ["instagram.com"], platform: { key: "instagram", label: "Instagram" } },
  { hosts: ["threads.net", "threads.com"], platform: { key: "threads", label: "Threads" } },
  { hosts: ["tiktok.com"], platform: { key: "tiktok", label: "TikTok" } },
  { hosts: ["vimeo.com"], platform: { key: "vimeo", label: "Vimeo" } },
  { hosts: ["twitch.tv"], platform: { key: "twitch", label: "Twitch" } },
  { hosts: ["reddit.com"], platform: { key: "reddit", label: "Reddit" } },
  { hosts: ["facebook.com", "fb.watch"], platform: { key: "facebook", label: "Facebook" } },
]

export function detectPlatform(url: string): Platform {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return { key: "unknown", label: "Unknown site" }
  }
  for (const { hosts, platform } of PLATFORMS) {
    if (hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return platform
  }
  return { key: "generic", label: hostname }
}

