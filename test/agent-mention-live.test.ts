/**
 * agent-mention-live.test.ts — S3 acceptance: a mention delegates, LIVE.
 *
 * Proves against the REAL SDK (real model, real subprocess, real spend)
 * that an operator message mentioning a registered subagent by name causes
 * delegation to exactly that subagent, steered only by
 * buildAgentMentionAddendum. This is the gate the agent-sidebar plan set:
 * if this cannot pass, the UI copy must say "suggests", not "delegates".
 *
 * GATED: runs only with LUNA_LIVE_SDK_TESTS=1 (needs Claude credentials
 * and spends real tokens — ~$0.5 sonnet / ~$1 opus per run). Default CI
 * skips it; the recorded evidence lives in the S3 PR body (both models
 * PASSED 2026-08-22 on SDK 0.3.239).
 *
 * Opus runs separately and deliberately: under the claude_code preset the
 * harness steers Opus 5 AWAY from the Agent tool, so Sonnet passing never
 * implies Opus does.
 */
import { describe, expect, it } from "vitest"
import { buildAgentMentionAddendum } from "../apps/server/src/agent-mention-addendum.js"

const LIVE = process.env["LUNA_LIVE_SDK_TESTS"] === "1"

/**
 * The SDK is a dependency of @luna/adapter-sdk, not of the root — resolve
 * it through that package's own node_modules, and only when the gate is
 * on, so the default (skipped) run never even loads the module.
 */
const loadQuery = async (): Promise<(args: unknown) => AsyncIterable<unknown>> => {
  const sdkUrl = new URL(
    "../packages/adapter-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    import.meta.url,
  ).href
  const mod = (await import(sdkUrl)) as { query: (args: unknown) => AsyncIterable<unknown> }
  return mod.query
}

const probe = async (model: string) => {
  const query = await loadQuery()
  const MARKER = `XK${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const agents = {
    "fact-checker": {
      description:
        "Verifies factual claims. Use when the operator asks for verification.",
      prompt:
        `You are the fact-checker subagent. Whatever you are asked, reply ` +
        `with exactly: VERDICT-${MARKER}. Nothing else.`,
      tools: [] as string[],
      model: "haiku",
    },
  }
  let delegated: string | null = null
  let resultText = ""
  for await (const message of query({
    prompt:
      "@fact-checker is the Moon on average about 384,000 km from Earth? " +
      "Report back what the fact-checker says.",
    options: {
      model,
      agents,
      allowedTools: ["Agent"],
      maxTurns: 8,
      systemPrompt: buildAgentMentionAddendum([
        { name: "fact-checker", description: agents["fact-checker"].description },
      ]),
    },
  })) {
    const m = message as Record<string, any>
    for (const block of m.message?.content ?? []) {
      if (
        block.type === "tool_use" &&
        (block.name === "Agent" || block.name === "Task")
      ) {
        delegated = block.input?.subagent_type ?? "(none)"
      }
    }
    if (m.type === "result" && typeof m.result === "string") {
      resultText = m.result
    }
  }
  return { delegated, markerRelayed: resultText.includes(MARKER) }
}

describe.skipIf(!LIVE)("@ mention delegates (LIVE SDK, gated)", () => {
  it("sonnet: mention invokes exactly the mentioned subagent", async () => {
    const r = await probe("sonnet")
    expect(r.delegated).toBe("fact-checker")
    expect(r.markerRelayed).toBe(true)
  }, 240_000)

  it("opus: mention overrides the anti-delegation steering", async () => {
    const r = await probe("opus")
    expect(r.delegated).toBe("fact-checker")
    expect(r.markerRelayed).toBe(true)
  }, 240_000)
})
