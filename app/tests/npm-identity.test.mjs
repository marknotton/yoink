import { test } from "node:test"
import assert from "node:assert/strict"
import { assertNpmIdentity, NpmIdentityError, npmEnv, REGISTRY } from "../scripts/lib/npm-identity.mjs"

const ok = (over = {}) => ({
  run: (cmd, args) => (args[0] === "whoami" ? "mypersonal\n" : ""),
  exists: () => true,
  expectedUser: "mypersonal",
  scope: "@mypersonal",
  userconfig: "/home/me/.npmrc-yoink",
  ...over,
})

test("the right account, publishing under its own scope, is accepted", () => {
  assert.equal(assertNpmIdentity(ok()), "mypersonal")
  assert.equal(assertNpmIdentity(ok({ expectedUser: "MyPersonal" })), "mypersonal", "usernames aren't case-sensitive")
})

test("refuses the work account, and says how to switch", () => {
  const e = assert.throws(() => assertNpmIdentity(ok({ run: () => "workaccount" })), NpmIdentityError)
  assert.throws(() => assertNpmIdentity(ok({ run: () => "workaccount" })), /logged in as “workaccount”.*published as “mypersonal”/s)
  assert.throws(() => assertNpmIdentity(ok({ run: () => "workaccount" })), /npm login .*--userconfig/)
  void e
})

test("refuses to guess: no named account means no publish", () => {
  assert.throws(() => assertNpmIdentity(ok({ expectedUser: "" })), /Set "npmUser"/)
  assert.throws(() => assertNpmIdentity(ok({ expectedUser: undefined })), /PERSONAL npm username/)
})

test("never falls back to the default ~/.npmrc when the dedicated credentials are missing", () => {
  let asked = false
  assert.throws(() => assertNpmIdentity(ok({ exists: () => false, run: () => ((asked = true), "mypersonal") })), /no dedicated npm credentials/)
  assert.equal(asked, false, "didn't even ask npm who it was")
})

test("an expired token is reported as 'log in again', not as a crash", () => {
  assert.throws(() => assertNpmIdentity(ok({ run: () => { throw new Error("E401") } })), /aren't logged in \(expired or revoked\)/)
})

test("a scope that isn't the user's own needs organisation membership", () => {
  const member = ok({ scope: "@somecompany", run: (cmd, args) => (args[0] === "whoami" ? "mypersonal" : "") })
  assert.equal(assertNpmIdentity(member), "mypersonal")
  const notMember = ok({ scope: "@somecompany", run: (cmd, args) => { if (args[0] === "org") throw new Error("not a member"); return "mypersonal" } })
  assert.throws(() => assertNpmIdentity(notMember), /can't publish under @somecompany/)
})

test("npm only ever sees the dedicated credentials, the public registry and no machine-wide config", () => {
  const env = npmEnv("/h/.npmrc-yoink", "/tmp/empty", { PATH: "/bin", NPM_CONFIG_USERCONFIG: "/h/.npmrc", NPM_CONFIG_REGISTRY: "https://artifactory.work/" })
  assert.equal(env.NPM_CONFIG_USERCONFIG, "/h/.npmrc-yoink", "overrides a work ~/.npmrc")
  assert.equal(env.NPM_CONFIG_REGISTRY, REGISTRY, "overrides a company registry")
  assert.equal(env.NPM_CONFIG_GLOBALCONFIG, "/tmp/empty")
  assert.equal(env.PATH, "/bin")
})
