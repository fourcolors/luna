/**
 * JevClassifierLayer: the production Jev classifier must send the caller's
 * state + typed questions to /v1/systemone with the key, return typed
 * answers keyed by question id, and turn every failure into a typed
 * ClassifierError (callers fall back to their generative/heuristic path,
 * never crash the decision).
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  Classifier,
  JEV_MODEL,
  JEV_URL,
  jevClassifierRequest,
  type AskArgs,
  type ClassifierQuestion,
} from "@luna/core"
import { JevClassifierLayer } from "../src/jev-classifier.js"

const questions: Record<string, ClassifierQuestion> = {
  route: {
    type: "choice",
    instructions: "Which lane should handle this message?",
    criteria: { chat: "Ordinary conversation", job: "A durable job or task" },
  },
  gate: {
    type: "noul",
    instructions: "Is this urgent?",
  },
}

const args: AskArgs = { state: { text: "remind me to call the dentist tomorrow" }, questions }

const run = (layer: ReturnType<typeof JevClassifierLayer>, a: AskArgs = args) =>
  Effect.runPromise(Effect.flip(Effect.flatMap(Effect.service(Classifier), (c) => c.ask(a))).pipe(Effect.provide(layer)))
const runOk = (layer: ReturnType<typeof JevClassifierLayer>, a: AskArgs = args) =>
  Effect.runPromise(Effect.flatMap(Effect.service(Classifier), (c) => c.ask(a)).pipe(Effect.provide(layer)))
const describeOf = (layer: ReturnType<typeof JevClassifierLayer>) =>
  Effect.runPromise(Effect.service(Classifier).pipe(Effect.provide(layer)))

const answering = (body: unknown, calls: Array<{ url: string; init: RequestInit }> = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body ?? { answers: {} }))
  }) as unknown as typeof fetch

const goodReply = {
  model: JEV_MODEL,
  answers: {
    route: { type: "choice", choice: "job", confidence: 0.9, probabilities: { job: 0.9, chat: 0.1 } },
    gate: { type: "noul", noul: 0.2 },
  },
}

describe("JevClassifierLayer", () => {
  it("sends the caller-shaped request with the pinned model and the key, and returns typed answers by id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const answers = await runOk(JevClassifierLayer({ apiKey: "k", warmUp: false, fetch: answering(goodReply, calls) }))
    expect(answers["route"]).toEqual({ type: "choice", choice: "job", confidence: 0.9, probabilities: { job: 0.9, chat: 0.1 } })
    expect(answers["gate"]).toEqual({ type: "noul", noul: 0.2 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(JEV_URL)
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer k")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(
      jevClassifierRequest(args.state, args.questions, JEV_MODEL),
    )
    expect(JEV_MODEL).toBe("jev-1.13.0")
  })

  it("declares itself as the jev engine", async () => {
    const c = await describeOf(JevClassifierLayer({ apiKey: "k", warmUp: false, fetch: answering(goodReply) }))
    expect(c.engine).toBe("jev")
  })

  it("warms up once at layer build with a data-free request, so the first real call is not the cold one", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    await describeOf(JevClassifierLayer({ apiKey: "k", fetch: answering(goodReply, calls) }))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init.body)).state).toBe("warm-up")
    const noKey: Array<{ url: string; init: RequestInit }> = []
    await describeOf(JevClassifierLayer({ apiKey: "", fetch: answering(goodReply, noKey) }))
    await new Promise((r) => setTimeout(r, 10))
    expect(noKey).toHaveLength(0)
  })

  it("a missing key fails with op acquire — typed, never thrown", async () => {
    const err = await run(JevClassifierLayer({ apiKey: "", warmUp: false, fetch: answering(goodReply) }))
    expect(err._tag).toBe("ClassifierError")
    expect(err.op).toBe("acquire")
    expect(err.message).toContain("TYPESAFE_API_KEY")
  })

  it("an HTTP error fails with op stream and a data-free message (the reply body may echo private text)", async () => {
    const err = await run(
      JevClassifierLayer({
        apiKey: "k",
        warmUp: false,
        fetch: (async () => new Response("the state was: remind me to call the dentist", { status: 500 })) as unknown as typeof fetch,
      }),
    )
    expect(err.op).toBe("stream")
    expect(err.message).toBe("jev HTTP 500")
    expect(err.message).not.toContain("dentist")
  })

  it("a malformed or incomplete answer fails with op parse — a half-answered decision never passes", async () => {
    const err = await run(
      JevClassifierLayer({
        apiKey: "k",
        warmUp: false,
        fetch: answering({ answers: { route: { type: "choice", choice: "job" } } }), // gate missing
      }),
    )
    expect(err.op).toBe("parse")
    expect(err.message).toContain("gate")
  })

  it("an out-of-set choice fails with op parse — it would route to a destination that does not exist", async () => {
    const err = await run(
      JevClassifierLayer({
        apiKey: "k",
        warmUp: false,
        fetch: answering({ answers: { route: { type: "choice", choice: "sleep" }, gate: { noul: 0.1 } } }),
      }),
    )
    expect(err.op).toBe("parse")
    expect(err.message).toContain("undeclared option")
  })

  it("a per-call timeoutMs caps the request with op timeout", async () => {
    const err = await run(
      JevClassifierLayer({
        apiKey: "k",
        warmUp: false,
        fetch: ((_u: string, i: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            i.signal?.addEventListener("abort", () => {
              const e = new Error("aborted")
              e.name = "AbortError"
              rej(e)
            })
          })) as unknown as typeof fetch,
      }),
      { ...args, timeoutMs: 5 },
    )
    expect(err.op).toBe("timeout")
    expect(err.message).toContain("5ms")
  })

  it("an empty question set resolves without calling Jev", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const answers = await runOk(
      JevClassifierLayer({ apiKey: "k", warmUp: false, fetch: answering(goodReply, calls) }),
      { state: "s", questions: {} },
    )
    expect(answers).toEqual({})
    expect(calls).toHaveLength(0)
  })
})
