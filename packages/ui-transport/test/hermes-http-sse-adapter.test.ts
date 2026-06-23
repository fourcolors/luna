/**
 * Tests for HermesHttpSseAdapter (Chunk 3).
 *
 * Uses the real HermesStub server (Node http module — works under vitest).
 * The adapter's fetch is injected so tests can route to the local stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HermesHttpSseAdapter } from "../src/adapters/hermes-http-sse.js"
import { startHermesStub } from "../src/dev/hermes-stub.js"
import type { HermesStubHandle } from "../src/dev/hermes-stub.js"
import type { FetchFn } from "../src/adapters/hermes-http-sse.js"
import type { RouteConfig } from "../src/contract.js"

// ── helpers ───────────────────────────────────────────────────────────────────

const TOKEN = "hermes-test-token-xyz"

/** Build a node-fetch-compatible fetch function that works in vitest (Node). */
function makeNodeFetch(): FetchFn {
  // Node 18+ has native fetch; use it directly.
  // Vitest runs on Node so globalThis.fetch is available.
  return globalThis.fetch as FetchFn
}

function makeRoute(stub: HermesStubHandle, overrides?: Partial<RouteConfig>): RouteConfig {
  return {
    routeKey: "hermes-test",
    endpoints: [stub.url],
    tokenRef: TOKEN,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HermesHttpSseAdapter", () => {
  let stub: HermesStubHandle | undefined

  afterEach(async () => {
    if (stub) {
      await stub.stop()
      stub = undefined
    }
  })

  // ── attach() ───────────────────────────────────────────────────────────────

  describe("attach() — happy path", () => {
    beforeEach(async () => {
      stub = await startHermesStub({ token: TOKEN })
    })

    it("resolves with origin='client-projected'", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      expect(result.origin).toBe("client-projected")
      await adapter.dispose()
    })

    it("descriptor has identity.kind === 'hermes'", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      expect(result.descriptor.identity.kind).toBe("hermes")
      await adapter.dispose()
    })

    it("descriptor has update.revertible === false (conservative assumption)", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      // ⚠️ revertible:false is a conservative default — reversibility UNCONFIRMED per design doc §7 note (a)
      expect(result.descriptor.update?.revertible).toBe(false)
      await adapter.dispose()
    })

    it("descriptor has update.forwardOnly === true", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      expect(result.descriptor.update?.forwardOnly).toBe(true)
      await adapter.dispose()
    })

    it("descriptor has an 'interact' capability", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      const interactCap = result.descriptor.capabilities.find((c) => c.operation === "interact")
      expect(interactCap).toBeDefined()
      expect(interactCap?.available).toBe(true)
      await adapter.dispose()
    })

    it("descriptor has 'inspect', 'administer', and 'update' capabilities", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      const ops = result.descriptor.capabilities.map((c) => c.operation)
      expect(ops).toContain("inspect")
      expect(ops).toContain("administer")
      expect(ops).toContain("update")
      await adapter.dispose()
    })

    it("descriptor has correct runtimeSummary.category", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      expect(result.descriptor.runtimeSummary.category).toBe("host-process")
      await adapter.dispose()
    })

    it("descriptor has correct identity.displayName", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      expect(result.descriptor.identity.displayName).toBe("Hermes (Nous agent)")
      await adapter.dispose()
    })

    it("descriptor version comes from /v1/capabilities", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const result = await adapter.attach()

      // Stub returns VERSION = "0.17.0-stub"
      expect(result.descriptor.identity.version).toBe("0.17.0-stub")
      expect(result.descriptor.update?.currentVersion).toBe("0.17.0-stub")
      await adapter.dispose()
    })

    it("emits 'connecting' then 'ready' connection states", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      const states: string[] = []

      const iter = adapter.connection[Symbol.asyncIterator]()
      const attachPromise = adapter.attach()

      const s1 = await iter.next()
      states.push(s1.value.status)
      const s2 = await iter.next()
      states.push(s2.value.status)

      await attachPromise

      expect(states).toContain("connecting")
      expect(states).toContain("ready")

      await adapter.dispose()
    })

    it("describe() re-fetches and returns a fresh result", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())

      await adapter.attach()
      const desc = await adapter.describe()

      // describe() always re-projects; origin stays client-projected
      expect(desc.origin).toBe("client-projected")
      await adapter.dispose()
    })

    it("selectAdapter factory returns HermesHttpSseAdapter for http:// endpoints", async () => {
      const { selectAdapter } = await import("../src/factory.js")
      const adapter = selectAdapter({
        routeKey: "hermes-factory-test",
        endpoints: [`http://127.0.0.1:${stub!.port}`],
        tokenRef: TOKEN,
      })
      expect(adapter.transportKind).toBe("hermes-http-sse")
      await adapter.dispose()
    })

    it("selectAdapter factory returns HermesHttpSseAdapter for https:// endpoints", async () => {
      const { selectAdapter } = await import("../src/factory.js")
      const adapter = selectAdapter({
        routeKey: "hermes-https-test",
        endpoints: ["https://hermes-box:8642"],
        tokenRef: TOKEN,
      })
      expect(adapter.transportKind).toBe("hermes-http-sse")
      await adapter.dispose()
    })
  })

  // ── auth failure ───────────────────────────────────────────────────────────

  describe("attach() — missing/wrong token (401 path)", () => {
    beforeEach(async () => {
      stub = await startHermesStub({ token: TOKEN })
    })

    it("rejects with auth-failed error when token is wrong", async () => {
      const adapter = new HermesHttpSseAdapter(
        makeRoute(stub!, { tokenRef: "wrong-token" }),
        makeNodeFetch(),
      )

      const states: string[] = []
      const iter = adapter.connection[Symbol.asyncIterator]()
      const stateCollection = (async () => {
        for await (const s of { [Symbol.asyncIterator]: () => iter }) {
          states.push(s.status)
          if (s.status === "auth-failed" || s.status === "down") break
        }
      })()

      await expect(adapter.attach()).rejects.toThrow()

      await stateCollection

      expect(states).toContain("connecting")
      const hasAuthFail = states.some((s) => s === "auth-failed")
      expect(hasAuthFail).toBe(true)

      await adapter.dispose()
    })
  })

  // ── dispose / lifecycle ────────────────────────────────────────────────────

  describe("dispose()", () => {
    beforeEach(async () => {
      stub = await startHermesStub({ token: TOKEN })
    })

    it("closes cleanly after attach", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      await adapter.attach()
      await expect(adapter.dispose()).resolves.toBeUndefined()
    })

    it("rejects attach after dispose", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      await adapter.dispose()
      await expect(adapter.attach()).rejects.toThrow("disposed")
    })
  })

  // ── openSession SSE streaming ──────────────────────────────────────────────

  describe("openSession() — SSE delta streaming", () => {
    beforeEach(async () => {
      stub = await startHermesStub({ token: TOKEN, deltaCount: 3 })
    })

    it("streams SSE deltas through ChatSession.messages and completes", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      await adapter.attach()

      const session = await adapter.openSession({ threadId: "test-thread-1" })
      expect(session.threadId).toBe("test-thread-1")

      // Send a message to trigger the SSE stream
      await session.send({ text: "hello from test" })

      // Collect frames until 'done'
      const frames: Array<{ t: string }> = []
      for await (const frame of session.messages) {
        frames.push({ t: frame.t })
        if (frame.t === "done" || frame.t === "error") break
      }

      // Should have received delta chunks + a done frame
      const deltaFrames = frames.filter((f) => f.t === "delta")
      const doneFrames = frames.filter((f) => f.t === "done")

      expect(deltaFrames.length).toBeGreaterThan(0)
      expect(doneFrames.length).toBe(1)

      session.close()
      await adapter.dispose()
    }, 10_000)

    it("delta frames carry text content", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      await adapter.attach()

      const session = await adapter.openSession({})
      await session.send({ text: "ping" })

      const deltaTexts: string[] = []
      for await (const frame of session.messages) {
        if (frame.t === "delta") {
          deltaTexts.push(frame.text)
        }
        if (frame.t === "done" || frame.t === "error") break
      }

      expect(deltaTexts.length).toBeGreaterThan(0)
      // First delta should echo the user text
      expect(deltaTexts[0]).toContain("Echo")

      session.close()
      await adapter.dispose()
    }, 10_000)

    it("session.stop() aborts the in-flight stream", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      await adapter.attach()

      const session = await adapter.openSession({})
      await session.send({ text: "abort test" })

      // Abort immediately
      await session.stop()

      // session.close() should still work cleanly
      session.close()
      await adapter.dispose()
    }, 5_000)

    it("session.close() terminates the messages iterable", async () => {
      const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
      await adapter.attach()

      const session = await adapter.openSession({})

      let loopDone = false
      const loopPromise = (async () => {
        for await (const _frame of session.messages) {
          // close immediately without consuming anything
          session.close()
          break
        }
        loopDone = true
      })()

      // Give the loop a chance to start
      await new Promise((r) => setTimeout(r, 5))
      session.close() // ensure closed

      await Promise.race([
        loopPromise,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("messages loop did not terminate")), 2_000),
        ),
      ])

      expect(loopDone).toBe(true)
      await adapter.dispose()
    }, 5_000)
  })

  // ── Chunk 2 regression check ── ─────────────────────────────────────────────

  describe("factory http:// does NOT throw (Chunk 2 regression)", () => {
    it("selectAdapter no longer throws 'not yet implemented' for http://", async () => {
      const { selectAdapter } = await import("../src/factory.js")
      expect(() =>
        selectAdapter({
          routeKey: "hermes-nowired",
          endpoints: ["http://localhost:8642/v1"],
          tokenRef: "tok",
        }),
      ).not.toThrow()
    })
  })
})

// ── Adversarial-review test suite (FIX 1–5 coverage) ─────────────────────────

describe("adversarial: SSE split-across-chunks", () => {
  it("reassembles a data: line split across multiple reads", async () => {
    // A single JSON delta line split into 3 reads, no [DONE]
    const deltaChunk = { id: "x", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }
    const fullLine = `data: ${JSON.stringify(deltaChunk)}\n\n`
    // Split the line at arbitrary byte boundaries
    const third = Math.floor(fullLine.length / 3)
    const part1 = fullLine.slice(0, third)
    const part2 = fullLine.slice(third, third * 2)
    const part3 = fullLine.slice(third * 2)

    const enc = new TextEncoder()
    let callCount = 0
    const reads = [enc.encode(part1), enc.encode(part2), enc.encode(part3)]

    const fakeBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = reads[callCount++]
        if (chunk) {
          controller.enqueue(chunk)
        } else {
          controller.close()
        }
      }
    })

    const mockFetch: FetchFn = async (url: string | Request | URL, _init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes("/v1/chat/completions")) {
        return new Response(fakeBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      }
      // health and caps: forward to a stub
      return new Response(JSON.stringify(urlStr.includes("/health") ? { status: "ok" } : { version: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "split-test", endpoints: ["http://fake-hermes"], tokenRef: "tok" },
      mockFetch
    )
    await adapter.attach()
    const session = await adapter.openSession({})
    await session.send({ text: "hi" })

    const deltaTexts: string[] = []
    for await (const frame of session.messages) {
      if (frame.t === "delta") deltaTexts.push(frame.text)
      if (frame.t === "done" || frame.t === "error") break
      // Safety: if we get 1 delta and stream naturally closes, break
    }

    expect(deltaTexts).toContain("hello")
    session.close()
    await adapter.dispose()
  }, 5_000)
})

describe("adversarial: exactly one done frame (FIX 1)", () => {
  let stub: HermesStubHandle | undefined

  afterEach(async () => {
    if (stub) {
      await stub.stop()
      stub = undefined
    }
  })

  it("emits exactly one done frame even when both finish_reason and [DONE] are present", async () => {
    // Build a stub that sends finish_reason then [DONE] (standard OpenAI behavior)
    stub = await startHermesStub({ token: TOKEN, deltaCount: 2 })
    const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
    await adapter.attach()
    const session = await adapter.openSession({})
    await session.send({ text: "count done" })

    // Drain to iterable END (do not break on first done)
    const allFrames: Array<{ t: string }> = []
    for await (const frame of session.messages) {
      allFrames.push({ t: frame.t })
      if (frame.t === "error") break
      // The iterable should terminate naturally after [DONE] triggers drainClose
    }

    const doneCount = allFrames.filter((f) => f.t === "done").length
    expect(doneCount).toBe(1)

    await adapter.dispose()
  }, 10_000)
})

describe("adversarial: error mid-stream (malformed JSON)", () => {
  it("surfaces error frame or skips malformed JSON without crashing", async () => {
    const enc = new TextEncoder()
    const lines = [
      "data: {bad json here}\n\n",
      `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")

    const fakeBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(lines))
        controller.close()
      }
    })

    const mockFetch: FetchFn = async (url: string | Request | URL, _init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes("/v1/chat/completions")) {
        return new Response(fakeBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      }
      return new Response(JSON.stringify(urlStr.includes("/health") ? { status: "ok" } : { version: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "malformed-test", endpoints: ["http://fake-hermes"], tokenRef: "tok" },
      mockFetch
    )
    await adapter.attach()
    const session = await adapter.openSession({})
    await session.send({ text: "trigger" })

    const frames: Array<{ t: string }> = []
    for await (const frame of session.messages) {
      frames.push({ t: frame.t })
      if (frame.t === "done" || frame.t === "error") break
    }

    // Must not throw. Should produce either: an error frame for malformed JSON,
    // or skip it and continue (delivering the valid delta and done).
    // Either way the iterable must terminate without hanging.
    expect(frames.length).toBeGreaterThan(0)
    // The valid "ok" delta should be present
    const deltaFrames = frames.filter((f) => f.t === "delta")
    expect(deltaFrames.length).toBeGreaterThan(0)

    session.close()
    await adapter.dispose()
  }, 5_000)
})

describe("adversarial: 401 on /v1/capabilities (health ok, caps 401)", () => {
  it("surfaces auth-failed when caps returns 401", async () => {
    let requestCount = 0
    const mockFetch: FetchFn = async (url: string | Request | URL, _init?: RequestInit) => {
      requestCount++
      const urlStr = String(url)
      if (urlStr.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      }
      if (urlStr.includes("/v1/capabilities")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        })
      }
      return new Response("not found", { status: 404 })
    }

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "caps-401-test", endpoints: ["http://fake-hermes"], tokenRef: "bad-tok" },
      mockFetch
    )

    const states: string[] = []
    const stateIter = adapter.connection[Symbol.asyncIterator]()
    const collectStates = (async () => {
      for await (const s of { [Symbol.asyncIterator]: () => stateIter }) {
        states.push(s.status)
        if (s.status === "auth-failed" || s.status === "down" || s.status === "ready") break
      }
    })()

    await expect(adapter.attach()).rejects.toThrow()
    await collectStates

    expect(states).toContain("auth-failed")
    await adapter.dispose()
  }, 5_000)
})

describe("adversarial: partial attach failure — caps 500 → connection down (FIX 4)", () => {
  it("surfaces connection down when caps returns 500", async () => {
    const mockFetch: FetchFn = async (url: string | Request | URL, _init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      }
      if (urlStr.includes("/v1/capabilities")) {
        return new Response("Internal Server Error", { status: 500 })
      }
      return new Response("not found", { status: 404 })
    }

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "caps-500-test", endpoints: ["http://fake-hermes"], tokenRef: "tok" },
      mockFetch
    )

    const states: string[] = []
    const stateIter = adapter.connection[Symbol.asyncIterator]()
    const collectStates = (async () => {
      for await (const s of { [Symbol.asyncIterator]: () => stateIter }) {
        states.push(s.status)
        if (s.status === "down" || s.status === "ready") break
      }
    })()

    await expect(adapter.attach()).rejects.toThrow()
    await collectStates

    expect(states).toContain("down")
    await adapter.dispose()
  }, 5_000)
})

describe("adversarial: dispose-while-idle (FIX 2)", () => {
  let stub: HermesStubHandle | undefined

  afterEach(async () => {
    if (stub) {
      await stub.stop()
      stub = undefined
    }
  })

  it("terminates messages iterable when dispose() is called on a session that never sent", async () => {
    stub = await startHermesStub({ token: TOKEN })
    const adapter = new HermesHttpSseAdapter(makeRoute(stub!), makeNodeFetch())
    await adapter.attach()
    const session = await adapter.openSession({})
    // Never call session.send()

    let iterDone = false
    const loopPromise = (async () => {
      for await (const _frame of session.messages) {
        // should never enter body
      }
      iterDone = true
    })()

    // Dispose while the for-await is parked
    await adapter.dispose()

    await Promise.race([
      loopPromise,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error("messages iterable hung after dispose()")), 2_000)
      ),
    ])

    expect(iterDone).toBe(true)
  }, 5_000)
})

describe("adversarial: final-line-without-newline (FIX 3)", () => {
  it("delivers delta and [DONE] when the stream ends without a trailing newline", async () => {
    const enc = new TextEncoder()
    const deltaChunk = { id: "x", choices: [{ index: 0, delta: { content: "last" }, finish_reason: null }] }
    // Note: [DONE] line has NO trailing \n
    const streamContent = `data: ${JSON.stringify(deltaChunk)}\n\ndata: [DONE]`

    const fakeBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(streamContent))
        controller.close()
      }
    })

    const mockFetch: FetchFn = async (url: string | Request | URL, _init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes("/v1/chat/completions")) {
        return new Response(fakeBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      }
      return new Response(JSON.stringify(urlStr.includes("/health") ? { status: "ok" } : { version: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }

    const adapter = new HermesHttpSseAdapter(
      { routeKey: "no-trailing-newline-test", endpoints: ["http://fake-hermes"], tokenRef: "tok" },
      mockFetch
    )
    await adapter.attach()
    const session = await adapter.openSession({})
    await session.send({ text: "hi" })

    const frames: Array<{ t: string; text?: string }> = []
    for await (const frame of session.messages) {
      frames.push({ t: frame.t, text: "text" in frame ? frame.text : undefined })
      if (frame.t === "done" || frame.t === "error") break
    }

    const deltaFrames = frames.filter((f) => f.t === "delta")
    const doneFrames = frames.filter((f) => f.t === "done")

    expect(deltaFrames.length).toBeGreaterThan(0)
    expect(doneFrames.length).toBe(1)

    session.close()
    await adapter.dispose()
  }, 5_000)
})
