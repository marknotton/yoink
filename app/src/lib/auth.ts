// Which sites need a login, how to find one, and what yt-dlp says when one is missing: all in @marknotton/yoink-core.
export { isSignInLink, needsLogin, SITES, siteForUrl } from "@marknotton/yoink-core"
export type { MarkerRule, SignInSite } from "@marknotton/yoink-core"

// the app's own record of which sites it has signed in to
export type SignedIn = { id: string; label: string }
