// ── Signing in to sites that need it ─────────────────────────────
// Reddit (and sometimes Instagram, X, TikTok…) only share video with signed-in users.
// Yoink opens the site's own login page in a window, the user logs in normally, and the
// session is saved for yt-dlp to reuse. The password is never seen by Yoink.

export type SignInSite = {
  id: string
  label: string
  loginUrl: string
  /** where this site's cookies live (a site can span several domains) */
  cookieUrls: string[]
  /** a cookie that only exists once you're logged in: lets Yoink notice by itself */
  markers: string[]
  /** domains to forget when signing out */
  domains: string[]
  note?: string
}

export const SITES: SignInSite[] = [
  {
    id: "reddit",
    label: "Reddit",
    loginUrl: "https://www.reddit.com/login",
    cookieUrls: ["https://www.reddit.com/", "https://reddit.com/"],
    // token_v2 is NOT a login marker: Reddit gives it to logged-out visitors too
    markers: ["reddit_session"],
    domains: ["reddit.com"],
  },
  {
    id: "instagram",
    label: "Instagram",
    loginUrl: "https://www.instagram.com/accounts/login/",
    cookieUrls: ["https://www.instagram.com/"],
    markers: ["sessionid"],
    domains: ["instagram.com"],
  },
  {
    id: "x",
    label: "X / Twitter",
    loginUrl: "https://x.com/i/flow/login",
    cookieUrls: ["https://x.com/", "https://twitter.com/"],
    markers: ["auth_token"],
    domains: ["x.com", "twitter.com"],
  },
  {
    id: "tiktok",
    label: "TikTok",
    loginUrl: "https://www.tiktok.com/login",
    cookieUrls: ["https://www.tiktok.com/"],
    markers: ["sessionid"],
    domains: ["tiktok.com"],
  },
  {
    id: "facebook",
    label: "Facebook",
    loginUrl: "https://www.facebook.com/login",
    cookieUrls: ["https://www.facebook.com/"],
    markers: ["c_user", "xs"],
    domains: ["facebook.com"],
  },
  {
    id: "threads",
    label: "Threads",
    loginUrl: "https://www.threads.net/login",
    cookieUrls: ["https://www.threads.net/", "https://www.threads.com/"],
    markers: ["sessionid"],
    domains: ["threads.net", "threads.com"],
  },
  {
    id: "youtube",
    label: "YouTube",
    loginUrl: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F",
    cookieUrls: ["https://www.youtube.com/", "https://accounts.google.com/", "https://www.google.com/"],
    markers: ["SID", "__Secure-3PSID"],
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

// yt-dlp's wording varies by site, but they all point at cookies or a login
const NEEDS_LOGIN = /--cookies|authentication is required|login required|log in|sign in to confirm|sign in to view|age-restricted/i

export const needsLogin = (message: string) => NEEDS_LOGIN.test(message)

export type SignedIn = { id: string; label: string }
