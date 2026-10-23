// Making sure a package is published from the RIGHT npm account.
//
// npm keeps one login per config file, so a work and a personal account on one machine collide: whichever token
// is in ~/.npmrc wins. Instead of trusting that file, the release uses its OWN credentials file
// (~/.npmrc-yoink), ignores the user's usual config, and refuses to publish unless that file is logged in as
// the account named in package.json ("npmUser"). Kept free of side effects (the caller supplies `run` and
// `exists`) so it can be tested without an npm account.
import os from "node:os"
import path from "node:path"

export const REGISTRY = "https://registry.npmjs.org/"
export const DEFAULT_USERCONFIG = path.join(os.homedir(), ".npmrc-yoink")

/** Environment for npm commands that must only ever see the dedicated credentials. */
export function npmEnv(userconfig, emptyGlobalConfig, base = process.env) {
  return {
    ...base,
    NPM_CONFIG_USERCONFIG: userconfig, // not ~/.npmrc: that may hold the work token
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig, // nor a machine-wide registry override
    NPM_CONFIG_REGISTRY: REGISTRY, // nor a company registry
  }
}

export class NpmIdentityError extends Error {}

/**
 * Returns the npm username if (and only if) the dedicated credentials are logged in as `expectedUser`
 * and that user may publish under `scope`. Throws NpmIdentityError with what to do otherwise.
 */
export function assertNpmIdentity({ run, exists, expectedUser, scope, userconfig = DEFAULT_USERCONFIG }) {
  const login = `npm login --registry ${REGISTRY} --userconfig ${userconfig}`

  if (!expectedUser) {
    throw new NpmIdentityError(
      'No npm account is named for this release. Set "npmUser" in app/package.json to your PERSONAL npm username,\n' +
        "so a work login can never be used by accident.",
    )
  }
  if (!exists(userconfig)) {
    throw new NpmIdentityError(`There are no dedicated npm credentials yet. Log in as ${expectedUser}:\n  ${login}`)
  }

  let user
  try {
    user = String(run("npm", ["whoami"])).trim()
  } catch {
    throw new NpmIdentityError(`The credentials in ${userconfig} aren't logged in (expired or revoked). Log in again as ${expectedUser}:\n  ${login}`)
  }
  if (user.toLowerCase() !== expectedUser.toLowerCase()) {
    throw new NpmIdentityError(
      `${userconfig} is logged in as “${user}”, but this release must be published as “${expectedUser}”.\n` +
        `Log out of it and log in again as ${expectedUser}:\n  ${login}`,
    )
  }

  // a scope is either the user's own name, or an organisation they belong to
  const bare = scope.replace(/^@/, "")
  if (bare.toLowerCase() !== user.toLowerCase()) {
    try {
      run("npm", ["org", "ls", bare, user])
    } catch {
      throw new NpmIdentityError(
        `“${user}” can't publish under @${bare}: the scope is neither their own name nor an organisation they belong to.\n` +
          `Either create the organisation (npm org create ${bare}), or rename the packages to @${user}/….`,
      )
    }
  }
  return user
}
