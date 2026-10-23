// The engine runs anywhere JavaScript does (Node, browsers, WebViews, Deno, Bun), so it is compiled
// without the DOM or Node type libraries, which keeps it from accidentally depending on either.
// `URL` exists in all of them; this declares only the part the engine uses.
declare class URL {
  constructor(input: string, base?: string)
  hostname: string
  origin: string
  pathname: string
  protocol: string
  hash: string
  searchParams: { get(name: string): string | null; delete(name: string): void; keys(): IterableIterator<string> }
  toString(): string
}
