// Lets the tests import the app's TypeScript logic (src/lib/*.ts) without a build step:
// each file is transpiled into a temp folder, with .ts imports rewritten to .mjs.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib")
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "yoink-tests-"))

export async function loadLib(name) {
  for (const file of fs.readdirSync(LIB).filter((f) => f.endsWith(".ts"))) {
    const js = ts
      .transpileModule(fs.readFileSync(path.join(LIB, file), "utf8"), { compilerOptions: { target: "ES2022", module: "ESNext" } })
      .outputText.replace(/from "\.\/([\w-]+)"/g, 'from "./$1.mjs"')
    fs.writeFileSync(path.join(OUT, file.replace(/\.ts$/, ".mjs")), js)
  }
  return import(pathToFileURL(path.join(OUT, `${name}.mjs`)).href)
}
