/**
 * Catalog sanity — the shipped connector definitions are well-formed and
 * carry NO operator-specific or secret material (this file is public).
 */
import { describe, expect, it } from "vitest"
import {
  BUILTIN_CONNECTORS,
  GOOGLE_WORKSPACE_CONNECTOR,
  SLACK_CONNECTOR,
} from "../src/index.js"

describe("BUILTIN_CONNECTORS", () => {
  it("have unique ids and serverKeys", () => {
    const ids = BUILTIN_CONNECTORS.map((c) => c.id)
    const keys = BUILTIN_CONNECTORS.map((c) => c.serverKey)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("oauth definitions name env VARS for the per-operator client — never inline creds", () => {
    const serialized = JSON.stringify(BUILTIN_CONNECTORS)
    // No literal Google client-id shapes / secrets leaked into the public catalog.
    expect(serialized).not.toMatch(/\.apps\.googleusercontent\.com/)
    expect(serialized).not.toMatch(/GOCSPX-/)
    for (const def of BUILTIN_CONNECTORS) {
      if (def.auth.kind === "oauth2") {
        expect(def.auth.clientIdEnvVar).toMatch(/^[A-Z0-9_]+$/)
        expect(def.auth.clientSecretEnvVar).toMatch(/^[A-Z0-9_]+$/)
      }
    }
  })

  it("Google Workspace: offline+consent extra params; restricted scopes default-off where expected", () => {
    const g = GOOGLE_WORKSPACE_CONNECTOR
    expect(g.auth.kind).toBe("oauth2")
    if (g.auth.kind === "oauth2") {
      expect(g.auth.extraAuthParams).toEqual({ access_type: "offline", prompt: "consent" })
      expect(g.auth.revocationEndpoint).toContain("revoke")
    }
    const byId = new Map(g.capabilities.map((c) => [c.id, c]))
    // PRD §09 defaults: read mail + calendar + app-created drive ON;
    // send + full-drive-read OFF (least privilege).
    expect(byId.get("gmail-read")?.defaultGranted).toBe(true)
    expect(byId.get("calendar")?.defaultGranted).toBe(true)
    expect(byId.get("drive-app-files")?.defaultGranted).toBe(true)
    expect(byId.get("gmail-send")?.defaultGranted).toBe(false)
    expect(byId.get("drive-read-all")?.defaultGranted).toBe(false)
  })

  it("Slack: api-key + stdio transport with an env var (token injected, not in catalog)", () => {
    expect(SLACK_CONNECTOR.auth.kind).toBe("api-key")
    expect(SLACK_CONNECTOR.transport.kind).toBe("mcp-stdio")
    if (SLACK_CONNECTOR.transport.kind === "mcp-stdio") {
      expect(SLACK_CONNECTOR.transport.secretEnvVar).toBe("SLACK_MCP_XOXB_TOKEN")
    }
    // no ACTUAL token value (xoxb- followed by the digit-block shape) —
    // the human-readable "grab the xoxb- token" hint in the blurb is fine.
    expect(JSON.stringify(SLACK_CONNECTOR)).not.toMatch(/xoxb-\d/)
  })
})
