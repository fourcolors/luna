import { describe, expect, it } from "vitest"
import {
  parseEnvFileEntries,
  parseEnvFileNames,
  planVaultKeychainMigration,
} from "./vault-migrate-keychain.js"

describe("planVaultKeychainMigration", () => {
  it("plans eligible env secrets and skips reserved names", () => {
    const plan = planVaultKeychainMigration({
      envNames: [
        "OPENAI_API_KEY",
        "LUNA_INTERNAL",
        "UI_WS_TOKEN",
        "ANTHROPIC_API_KEY",
      ],
      existingKeychainNames: new Set(["ANTHROPIC_API_KEY"]),
    })

    expect(plan.toCopy).toEqual(["OPENAI_API_KEY"])
    expect(plan.alreadyCopied).toEqual(["ANTHROPIC_API_KEY"])
    expect(plan.skippedReserved).toEqual(["LUNA_INTERNAL", "UI_WS_TOKEN"])
  })

  it("treats reserved names case-insensitively (matches the env denylist)", () => {
    const plan = planVaultKeychainMigration({
      envNames: ["ui_ws_token", "Luna_Thing", "GOOD_KEY"],
      existingKeychainNames: new Set(),
    })

    expect(plan.skippedReserved).toEqual(["ui_ws_token", "Luna_Thing"])
    expect(plan.toCopy).toEqual(["GOOD_KEY"])
  })
})

describe("parseEnvFileNames", () => {
  it("extracts keys, ignoring comments, blanks, and malformed lines", () => {
    const body = [
      "# a comment",
      "",
      "OPENAI_API_KEY=sk-test",
      "  SPACED_KEY = value-with-spaces ",
      "no_equals_here",
      "=leading-equals-no-key",
    ].join("\n")

    expect(parseEnvFileNames(body)).toEqual(["OPENAI_API_KEY", "SPACED_KEY"])
  })
})

describe("parseEnvFileEntries", () => {
  it("matches the boot loader: trims the value and keeps the first duplicate", () => {
    // Boot loader (chat-server) does `trimmed.slice(eq+1).trim()` and
    // first-occurrence-wins; apply must copy the SAME value the env path
    // resolves, or a later prune could orphan a drifted value.
    const body = [
      "# comment",
      "OPENAI_API_KEY= sk-leading-space ",
      "DUPE=first",
      "DUPE=second",
    ].join("\n")

    expect(parseEnvFileEntries(body)).toEqual([
      { name: "OPENAI_API_KEY", value: "sk-leading-space" },
      { name: "DUPE", value: "first" },
    ])
  })
})
