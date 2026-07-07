/**
 * Static file serving — integration tests for the opt-in staticRoot feature.
 *
 * These tests boot a real UIWebSocketServer with staticRoot set to a temp
 * fixture directory, then make HTTP requests (not WS) against it to verify
 * all static-serving guarantees:
 *   1. GET / → 200, index.html body, text/html Content-Type.
 *   2. GET /assets/app-abc123.js → 200, text/javascript, immutable Cache-Control.
 *   3. GET /index.html → Cache-Control: no-cache.
 *   4. SPA fallback: GET /some/client/route (no dot) → 200, index.html body.
 *   5. Missing asset: GET /assets/missing.js (dotted, missing) → 404.
 *   6. Path traversal: GET /..%2f..%2fetc%2fpasswd → 404 (never reads outside root).
 *   7. HEAD / → 200, headers set, empty body.
 *   8. Regression (no staticRoot): GET / → 404; /healthz → 200; GET /ui → 426.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Effect,
  Layer,
  ManagedRuntime,
} from "effect"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import * as http from "node:http"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"

const TOKEN = "static-serve-test-token-xyz" // ≥16 chars

// ── Service tag so ManagedRuntime can provide the server handle ───────────────
class ServerHandle extends Effect.Tag("test/StaticServeHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

// ── Layer builder ──────────────────────────────────────────────────────────────
const makeFullLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
}

// ── Simple HTTP helper (no ws) ────────────────────────────────────────────────
const httpReq = (
  opts: { host: string; port: number; method: string; path: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: opts.host, port: opts.port, method: opts.method, path: opts.path },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        })
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.end()
  })

// ── Fixture directory ─────────────────────────────────────────────────────────
let fixtureDir: string
let runtime: ManagedRuntime.ManagedRuntime<ServerHandle | UIService | ObservabilityService | Clock.Clock, never>
let serverPort: number
let serverHost: string

// Runtime without staticRoot (for regression tests)
let rigNoStatic: {
  port: number
  host: string
  runtime: ManagedRuntime.ManagedRuntime<ServerHandle | UIService | ObservabilityService | Clock.Clock, never>
}

const startRig = async (staticRoot?: string) => {
  const baseLayer = makeFullLayer()
  const serverLayer = Layer.scoped(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      pingIntervalMs: 0,
      token: TOKEN,
      ...(staticRoot !== undefined ? { staticRoot } : {}),
    }),
  ).pipe(Layer.provide(baseLayer))

  const fullLayer = Layer.mergeAll(serverLayer, baseLayer)
  const rt = ManagedRuntime.make(fullLayer)
  const handle = await rt.runPromise(ServerHandle)
  return { port: handle.port, host: handle.host, runtime: rt }
}

beforeAll(async () => {
  // Create fixture directory tree:
  //   <tmp>/
  //     index.html
  //     assets/
  //       app-abc123.js
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-static-test-"))
  fs.writeFileSync(path.join(fixtureDir, "index.html"), "<html><body>SPA</body></html>")
  fs.mkdirSync(path.join(fixtureDir, "assets"), { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, "assets", "app-abc123.js"), 'console.log("app")')

  // Start server WITH staticRoot
  const rig = await startRig(fixtureDir)
  runtime = rig.runtime
  serverPort = rig.port
  serverHost = rig.host

  // Start server WITHOUT staticRoot (regression rig)
  const noStatic = await startRig(undefined)
  rigNoStatic = noStatic
}, 30000)

afterAll(async () => {
  await runtime.dispose()
  await rigNoStatic.runtime.dispose()
  // Clean up fixture dir
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("static file serving (staticRoot set)", () => {
  it("1. GET / returns 200 with index.html body and text/html Content-Type", async () => {
    const res = await httpReq({ host: serverHost, port: serverPort, method: "GET", path: "/" })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.body).toContain("SPA")
  })

  it("2. GET /assets/app-abc123.js returns 200, text/javascript, immutable Cache-Control", async () => {
    const res = await httpReq({
      host: serverHost,
      port: serverPort,
      method: "GET",
      path: "/assets/app-abc123.js",
    })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/javascript/)
    expect(res.headers["cache-control"]).toMatch(/immutable/)
    expect(res.body).toContain('console.log("app")')
  })

  it("3. GET /index.html has Cache-Control: no-cache", async () => {
    const res = await httpReq({ host: serverHost, port: serverPort, method: "GET", path: "/index.html" })
    expect(res.status).toBe(200)
    expect(res.headers["cache-control"]).toBe("no-cache")
  })

  it("4. SPA fallback: GET /some/client/route (no dot) returns 200 with index.html", async () => {
    const res = await httpReq({
      host: serverHost,
      port: serverPort,
      method: "GET",
      path: "/some/client/route",
    })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.body).toContain("SPA")
  })

  it("5. Missing asset: GET /assets/missing.js (dotted, missing) returns 404", async () => {
    const res = await httpReq({
      host: serverHost,
      port: serverPort,
      method: "GET",
      path: "/assets/missing.js",
    })
    expect(res.status).toBe(404)
    // Must NOT serve index.html
    expect(res.body).not.toContain("SPA")
  })

  it("6a. Traversal blocked: GET /..%2f..%2f..%2fetc%2fpasswd returns 404", async () => {
    const res = await httpReq({
      host: serverHost,
      port: serverPort,
      method: "GET",
      path: "/..%2f..%2f..%2fetc%2fpasswd",
    })
    expect(res.status).toBe(404)
  })

  it("6b. Traversal normalised: GET /../../../etc/passwd serves SPA (not real /etc/passwd)", async () => {
    // Node's HTTP layer normalises /../../../etc/passwd → /etc/passwd before our
    // handler sees req.url. The decoded pathname /etc/passwd has no file extension
    // ('passwd' contains no dot), so our SPA fallback fires and serves index.html
    // safely — the system's /etc/passwd is never read.
    // This assertion proves that the response body is the SPA fixture, not the
    // real system file, which is the meaningful security guarantee.
    const res = await httpReq({
      host: serverHost,
      port: serverPort,
      method: "GET",
      path: "/../../../etc/passwd",
    })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    // Body is the SPA fixture, NOT /etc/passwd contents
    expect(res.body).toContain("SPA")
    expect(res.body).not.toContain("root:")
  })

  it("7. HEAD / returns 200 with headers and empty body", async () => {
    const res = await httpReq({ host: serverHost, port: serverPort, method: "HEAD", path: "/" })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.body).toBe("")
  })
})

describe("regression: no staticRoot set", () => {
  it("8a. GET / returns 404 (no static serving)", async () => {
    const res = await httpReq({
      host: rigNoStatic.host,
      port: rigNoStatic.port,
      method: "GET",
      path: "/",
    })
    expect(res.status).toBe(404)
  })

  it("8b. /healthz still returns 200", async () => {
    const res = await httpReq({
      host: rigNoStatic.host,
      port: rigNoStatic.port,
      method: "GET",
      path: "/healthz",
    })
    expect(res.status).toBe(200)
    expect(res.body).toBe("ok")
  })

  it("8c. GET /ui (non-upgrade) still returns 426", async () => {
    const res = await httpReq({
      host: rigNoStatic.host,
      port: rigNoStatic.port,
      method: "GET",
      path: "/ui",
    })
    expect(res.status).toBe(426)
  })
})
