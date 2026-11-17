import { describe, expect, it } from "vitest"
import { makeAssistantMessage, makeFakeQuery } from "./fake-sdk.js"

async function drain(throwAfter: number | undefined, count: number) {
  const msgs = Array.from({ length: count }, (_, i) =>
    makeAssistantMessage("s", `m${i}`, `u${i}`),
  )
  const { query } = makeFakeQuery({ messages: msgs, throwAfter })
  let n = 0
  let threw = false
  try {
    for await (const _m of query) n++
  } catch {
    threw = true
  }
  return { n, threw }
}

describe("makeFakeQuery throwAfter", () => {
  it("throwAfter: 0 throws before any message", async () => {
    await expect(drain(0, 2)).resolves.toEqual({ n: 0, threw: true })
  })

  it("throwAfter: 1 yields one message then throws", async () => {
    await expect(drain(1, 2)).resolves.toEqual({ n: 1, threw: true })
  })

  it("throwAfter equal to the message count still throws after the last message", async () => {
    await expect(drain(1, 1)).resolves.toEqual({ n: 1, threw: true })
    await expect(drain(2, 2)).resolves.toEqual({ n: 2, threw: true })
  })

  it("throwAfter beyond the message count never throws", async () => {
    await expect(drain(5, 2)).resolves.toEqual({ n: 2, threw: false })
  })

  it("no throwAfter yields everything", async () => {
    await expect(drain(undefined, 2)).resolves.toEqual({ n: 2, threw: false })
  })
})
