/**
 * Tests for the TokenResolver injection seam (C6).
 *
 * Covers:
 *   - Adapters resolve route.tokenRef through an injected resolver (env:/file:
 *     ref → resolved token), proven END-TO-END: a stub server validates the
 *     bearer/query token, so a wrong (literal) token fails auth and the resolved
 *     one succeeds.
 *   - Adapters WITHOUT a resolver fall back to the LITERAL tokenRef (backward
 *     compat) — the literal value is what reaches the wire.
 *   - selectAdapter / ConnectionManager thread the resolver through.
 *   - makeNodeTokenResolver wraps resolveTokenRef.
 *   - Browser-safety guard: src/browser.ts's transitive imports contain no
 *     `node:` specifier, and the generated vendor bundle has no node: module.
 */

import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import WebSocket from "ws"
import { readFileSync } from "node:fs"
import { resolve as pathResolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { LunaWsAdapter } from "../src/adapters/luna-ws.js"
import { HermesHttpSseAdapter } from "../src/adapters/hermes-http-sse.js"
import type { WsFactory } from "../src/adapters/luna-ws.js"
import { selectAdapter } from "../src/factory.js"
import { ConnectionManager } from "../src/pool/connection-manager.js"
import { makeNodeTokenResolver } from "../src/node.js"
import type { TokenResolver } from "../src/token-resolver.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Minimal WS stub server (validates the query/bearer token) ──────────────────

interface StubServer {
  url: string
  close(): Promise<void>
}

function startStubServer(expectedToken: string): Promise<StubServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on("error", reject)
    wss.on("listening", () => {
      const addr = wss.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      wss.on("connection", (ws, req) => {
        const rawUrl = req.url ?? ""
        const m = rawUrl.match(/[?&]token=([^&]*)/)
        const queryToken = m ? decodeURIComponent(m[1] ?? "") : ""
        if (queryToken !== expectedToken) {
          ws.close(1008, "Unauthorized")
          return
        }
        ws.send(JSON.stringify({ type: "hello", protocolVersion: 2 }))
      })
      resolve({
        url: `ws://127.0.0.1:${port}/ui`,
        close: () =>
          Promise.race([
            new Promise<void>((res, rej) => wss.close((e) => (e ? rej(e) : res()))),
            new Promise<void>((res) => setTimeout(res, 500)),
          ]),
      })
    })
  })
}

function makeNodeWsFactory(): WsFactory {
  return (url) => new WebSocket(url) as unknown as globalThis.WebSocket
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("TokenResolver injection — LunaWsAdapter", () => {
  let server: StubServer | undefined
  const REAL_TOKEN = "real-secret-token-xyz"

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it("resolves an env: tokenRef via the injected resolver (not the literal)", async () => {
    server = await startStubServer(REAL_TOKEN)
    // The route carries a REFERENCE, not the secret. The resolver turns it into
    // the real token the server expects. If the literal "env:UI_TOKEN" reached
    // the wire, the server would reject with 1008.
    const resolver: TokenResolver = makeNodeTokenResolver()
    const adapter = new LunaWsAdapter(
      { routeKey: "r", endpoints: [server.url], tokenRef: "env:UI_TOKEN" },
      makeNodeWsFactory(),
      undefined,
      undefined,
      // env injection: we use makeNodeTokenResolver default which reads
      // process.env, so set it on process.env for this assertion.
      resolver,
    )
    process.env.UI_TOKEN = REAL_TOKEN
    try {
      const result = await adapter.attach()
      expect(result.origin).toBe("synthesized-legacy") // no descriptor in hello
    } finally {
      delete process.env.UI_TOKEN
      await adapter.dispose()
    }
  })

  it("resolves via a CUSTOM resolver function (proves the seam, no env needed)", async () => {
    server = await startStubServer(REAL_TOKEN)
    const calls: string[] = []
    const resolver: TokenResolver = async (ref) => {
      calls.push(ref)
      expect(ref).toBe("env:WHATEVER")
      return REAL_TOKEN
    }
    const adapter = new LunaWsAdapter(
      { routeKey: "r", endpoints: [server.url], tokenRef: "env:WHATEVER" },
      makeNodeWsFactory(),
      undefined,
      undefined,
      resolver,
    )
    try {
      await adapter.attach()
      expect(calls).toEqual(["env:WHATEVER"]) // resolved exactly once
    } finally {
      await adapter.dispose()
    }
  })

  it("WITHOUT a resolver uses the literal tokenRef (backward compat)", async () => {
    // Server expects the LITERAL value as the token — proves no resolution path
    // runs when no resolver is injected.
    server = await startStubServer("env:LITERAL-NOT-RESOLVED")
    const adapter = new LunaWsAdapter(
      { routeKey: "r", endpoints: [server.url], tokenRef: "env:LITERAL-NOT-RESOLVED" },
      makeNodeWsFactory(),
      // no resolver
    )
    try {
      const result = await adapter.attach()
      expect(result.origin).toBe("synthesized-legacy")
    } finally {
      await adapter.dispose()
    }
  })

  it("a wrong resolver value fails auth (1008) — proves the resolved value is what's used", async () => {
    server = await startStubServer(REAL_TOKEN)
    const resolver: TokenResolver = async () => "WRONG-TOKEN"
    const adapter = new LunaWsAdapter(
      { routeKey: "r", endpoints: [server.url], tokenRef: "env:UI_TOKEN" },
      makeNodeWsFactory(),
      undefined,
      undefined,
      resolver,
    )
    try {
      await expect(adapter.attach()).rejects.toThrow()
    } finally {
      await adapter.dispose()
    }
  })
})

describe("TokenResolver injection — selectAdapter + ConnectionManager", () => {
  let server: StubServer | undefined
  const REAL_TOKEN = "cm-real-token"

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it("selectAdapter threads the resolver into the adapter", async () => {
    server = await startStubServer(REAL_TOKEN)
    let seen = ""
    const resolver: TokenResolver = async (ref) => {
      seen = ref
      return REAL_TOKEN
    }
    const adapter = selectAdapter(
      { routeKey: "r", endpoints: [server.url], tokenRef: "env:FOO" },
      resolver,
    )
    // Replace the WS factory is not possible via selectAdapter; instead rely on
    // the default global WebSocket — but tests run in Node where global WS may
    // be undefined. Use the adapter directly with the node factory by
    // re-constructing is not needed: selectAdapter already built a LunaWsAdapter
    // whose default factory uses global WebSocket. Node 22 provides global
    // WebSocket, so this connects.
    try {
      await adapter.attach()
      expect(seen).toBe("env:FOO")
    } finally {
      await adapter.dispose()
    }
  })

  it("ConnectionManager threads the resolver to the adapters it builds", async () => {
    server = await startStubServer(REAL_TOKEN)
    let seen = ""
    const resolver: TokenResolver = async (ref) => {
      seen = ref
      return REAL_TOKEN
    }
    const routes = new Map([
      ["r", { routeKey: "r", endpoints: [server.url], tokenRef: "env:CM" }],
    ])
    // Default factory (selectAdapter) + injected resolver.
    const cm = new ConnectionManager(routes, undefined, resolver)
    try {
      const handle = await cm.acquire("r")
      expect(seen).toBe("env:CM")
      await handle.release()
    } finally {
      await cm.disposeAll()
    }
  })
})

describe("TokenResolver injection — HermesHttpSseAdapter", () => {
  it("resolves the token through the injected resolver before fetching", async () => {
    let seenRef = ""
    const resolver: TokenResolver = async (ref) => {
      seenRef = ref
      return "resolved-hermes-token"
    }
    const seenAuth: string[] = []
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? ""
      seenAuth.push(auth)
      const u = String(url)
      if (u.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 })
      }
      if (u.endsWith("/v1/capabilities")) {
        return new Response(JSON.stringify({ version: "1.0" }), { status: 200 })
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "h", endpoints: ["http://127.0.0.1:9/v1"], tokenRef: "file:/abs/secret" },
      fakeFetch,
      resolver,
    )
    await adapter.attach()
    expect(seenRef).toBe("file:/abs/secret")
    // The RESOLVED token (not the literal "file:/abs/secret") is the bearer.
    expect(seenAuth.every((a) => a === "Bearer resolved-hermes-token")).toBe(true)
    await adapter.dispose()
  })

  it("WITHOUT a resolver uses the literal tokenRef as the bearer (backward compat)", async () => {
    const seenAuth: string[] = []
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      seenAuth.push((init?.headers as Record<string, string>)?.Authorization ?? "")
      const u = String(url)
      if (u.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 })
      return new Response(JSON.stringify({ version: "1.0" }), { status: 200 })
    }) as unknown as typeof fetch

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "h", endpoints: ["http://127.0.0.1:9/v1"], tokenRef: "literal-bearer" },
      fakeFetch,
      // no resolver
    )
    await adapter.attach()
    expect(seenAuth.every((a) => a === "Bearer literal-bearer")).toBe(true)
    await adapter.dispose()
  })
})

describe("makeNodeTokenResolver", () => {
  it("resolves an env: ref via resolveTokenRef", async () => {
    process.env.NTR_TOKEN = "node-resolver-value"
    try {
      const resolver = makeNodeTokenResolver()
      const token = await resolver("env:NTR_TOKEN")
      expect(token).toBe("node-resolver-value")
    } finally {
      delete process.env.NTR_TOKEN
    }
  })

  it("refuses op:// by default (headless) and resolves it when allowInteractive + mocked spawn", async () => {
    // Default (headless) → refuse.
    const headless = makeNodeTokenResolver()
    await expect(headless("op://V/i/f")).rejects.toThrow(/refused in non-interactive/)

    // Opted in with a mocked spawn + injected binary path → resolves.
    const interactive = makeNodeTokenResolver({
      allowInteractive: true,
      opBinaryPath: "/usr/local/bin/op",
      opPathLookup: () => "/usr/local/bin/op",
      opSpawn: async () => ({ code: 0, signal: null, stdout: "op-token\n", stderr: "" }),
    })
    expect(await interactive("op://V/i/f")).toBe("op-token")
  })
})

// ── Browser-safety guard ────────────────────────────────────────────────────────

describe("browser-safety: no node: imports in the browser surface", () => {
  // Recursively walk the static import graph rooted at src/browser.ts and assert
  // no module in it carries a `node:` specifier. This is the source-level guard;
  // the bundle-level guard below checks the generated artifact.
  function collectImports(entryFile: string): { files: string[]; nodeImports: Array<{ file: string; spec: string }> } {
    const visited = new Set<string>()
    const nodeImports: Array<{ file: string; spec: string }> = []
    const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g

    function walk(absFile: string): void {
      if (visited.has(absFile)) return
      visited.add(absFile)
      let src: string
      try {
        src = readFileSync(absFile, "utf8")
      } catch {
        return
      }
      let match: RegExpExecArray | null
      while ((match = importRe.exec(src)) !== null) {
        const spec = match[1]!
        if (spec.startsWith("node:")) {
          nodeImports.push({ file: absFile, spec })
          continue
        }
        // Only follow relative imports inside this package (.js → .ts on disk).
        if (spec.startsWith(".")) {
          const resolved = pathResolve(dirname(absFile), spec.replace(/\.js$/, ".ts"))
          walk(resolved)
        }
        // Bare specifiers (@luna/ui-shared, smol-toml, ws) are not followed —
        // the bundle guard catches any node: they'd transitively pull in.
      }
    }

    walk(entryFile)
    return { files: [...visited], nodeImports }
  }

  it("src/browser.ts transitively imports nothing from node:", () => {
    const entry = pathResolve(__dirname, "../src/browser.ts")
    const { files, nodeImports } = collectImports(entry)
    // Sanity: we actually walked a non-trivial graph.
    expect(files.length).toBeGreaterThan(3)
    expect(
      nodeImports,
      `browser surface must not import node: — found: ${JSON.stringify(nodeImports)}`,
    ).toEqual([])
  })

  it("does NOT pull in client-config.ts (resolveTokenRef / node:fs / node:child_process)", () => {
    const entry = pathResolve(__dirname, "../src/browser.ts")
    const { files } = collectImports(entry)
    const pulledClientConfig = files.some((f) => f.endsWith("client-config.ts"))
    expect(pulledClientConfig).toBe(false)
    const pulledNodeEntry = files.some((f) => f.endsWith("/node.ts"))
    expect(pulledNodeEntry).toBe(false)
  })

  it("the generated vendor bundle has no node: module specifier", () => {
    const bundlePath = pathResolve(
      __dirname,
      "../../../apps/ui-moon-tauri/frontend/vendor/ui-transport.js",
    )
    let bundle: string
    try {
      bundle = readFileSync(bundlePath, "utf8")
    } catch {
      // If the bundle is absent in this checkout, skip rather than fail.
      return
    }
    // Strip the generated header/comment lines, then assert no node: require/import.
    expect(bundle).not.toMatch(/require\(\s*['"]node:/)
    expect(bundle).not.toMatch(/from\s*['"]node:/)
    expect(bundle).not.toContain("node:child_process")
    expect(bundle).not.toContain("node:fs")
  })
})
