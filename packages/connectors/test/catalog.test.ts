/**
 * Catalog sanity — the shipped connector definitions are well-formed and
 * carry NO operator-specific or secret material (this file is public).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { Clock, ConfigError, SecretProvider } from "@luna/core"
import {
  BUILTIN_CONNECTORS,
  ConnectorInstanceStore,
  ConnectorService,
  ConnectorServiceLayer,
  GITHUB_CONNECTOR,
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

// ---------------------------------------------------------------------------
// GitHub connector — well-formedness + multi-account machinery
// ---------------------------------------------------------------------------

describe("GitHub connector — definition", () => {
  it("is in BUILTIN_CONNECTORS with a unique id and serverKey", () => {
    const gh = BUILTIN_CONNECTORS.find((c) => c.id === "github")
    expect(gh).toBeDefined()
    // serverKey must be unique across the whole catalog
    const keys = BUILTIN_CONNECTORS.map((c) => c.serverKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("is api-key auth — no inline credentials or OAuth endpoints", () => {
    expect(GITHUB_CONNECTOR.auth.kind).toBe("api-key")
    // label text is human-readable; no real token value
    const serialized = JSON.stringify(GITHUB_CONNECTOR)
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9]{36}/)   // classic PAT shape
    expect(serialized).not.toMatch(/github_pat_[A-Za-z0-9]/) // fine-grained PAT shape
  })

  it("is mcp-stdio transport launching the official binary with the right env var", () => {
    expect(GITHUB_CONNECTOR.transport.kind).toBe("mcp-stdio")
    if (GITHUB_CONNECTOR.transport.kind === "mcp-stdio") {
      // Exactly the official github/github-mcp-server CLI shape:
      //   command: "github-mcp-server"
      //   args:    ["stdio"]
      //   env var: GITHUB_PERSONAL_ACCESS_TOKEN  (from official README)
      expect(GITHUB_CONNECTOR.transport.command).toBe("github-mcp-server")
      expect(GITHUB_CONNECTOR.transport.args).toContain("stdio")
      expect(GITHUB_CONNECTOR.transport.secretEnvVar).toBe("GITHUB_PERSONAL_ACCESS_TOKEN")
    }
  })

  it("category is 'development' and has repo-read, repo-write, code-search capabilities", () => {
    expect(GITHUB_CONNECTOR.category).toBe("development")
    const byId = new Map(GITHUB_CONNECTOR.capabilities.map((c) => [c.id, c]))
    // Least-privilege defaults: read + search on, write off
    expect(byId.get("repo-read")?.defaultGranted).toBe(true)
    expect(byId.get("repo-write")?.defaultGranted).toBe(false)
    expect(byId.get("code-search")?.defaultGranted).toBe(true)
  })
})

// Helpers for the multi-account machinery tests below
const secretsStub = Layer.succeed(SecretProvider, {
  get: (ref: string) =>
    ref.startsWith("env:KNOWN")
      ? Effect.succeed(Redacted.make(`secret-for-${ref}`))
      : Effect.fail(
          new ConfigError({ module: "test", key: ref, message: "unknown ref" }),
        ),
})

const ghLayer = ConnectorServiceLayer({ definitions: [GITHUB_CONNECTOR] }).pipe(
  Layer.provide(ConnectorInstanceStore.Memory),
  Layer.provide(secretsStub),
  Layer.provide(Clock.Default),
)

const runGh = <A, E>(eff: Effect.Effect<A, E, ConnectorService>) =>
  Effect.runPromise(eff.pipe(Effect.provide(ghLayer)) as Effect.Effect<A, E>)

describe("GitHub connector — multi-account machinery (api-key path)", () => {
  it("accepts two GitHub instances under different labels (C1: multi-account)", async () => {
    await runGh(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        // First account — personal
        yield* svc.connect({
          definitionId: "github",
          label: "personal",
          secretRef: "env:KNOWN_PAT_PERSONAL",
        })
        // Second account — work (different label, same definition)
        yield* svc.connect({
          definitionId: "github",
          label: "work",
          secretRef: "env:KNOWN_PAT_WORK",
        })
        const list = yield* svc.list()
        expect(list).toHaveLength(2)
        expect(list.map((i) => i.label).sort()).toEqual(["personal", "work"])
        // Both instances carry only the pointer, never the secret value
        expect(JSON.stringify(list)).not.toContain("secret-for-")
      }),
    )
  })

  it("rejects a duplicate label for the same definition (case/punctuation-insensitive)", async () => {
    await runGh(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        yield* svc.connect({
          definitionId: "github",
          label: "work",
          secretRef: "env:KNOWN_PAT_WORK",
        })
        const dup = yield* svc
          .connect({ definitionId: "github", label: "Work!", secretRef: "env:KNOWN_PAT_WORK" })
          .pipe(Effect.flip)
        expect(dup.message).toContain("already has an account labeled")
      }),
    )
  })

  it("each account mounts under its own suffixed key with the token injected into env", async () => {
    await runGh(
      Effect.gen(function* () {
        const svc = yield* ConnectorService
        yield* svc.connect({
          definitionId: "github",
          label: "personal",
          secretRef: "env:KNOWN_PAT_PERSONAL",
        })
        yield* svc.connect({
          definitionId: "github",
          label: "work",
          secretRef: "env:KNOWN_PAT_WORK",
        })
        const mounts = svc.mountSnapshotSync()
        // Each account gets its own suffixed server key
        expect(mounts["github_personal"]).toMatchObject({
          type: "stdio",
          command: "github-mcp-server",
          args: ["stdio"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret-for-env:KNOWN_PAT_PERSONAL" },
        })
        expect(mounts["github_work"]).toMatchObject({
          type: "stdio",
          command: "github-mcp-server",
          args: ["stdio"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret-for-env:KNOWN_PAT_WORK" },
        })
      }),
    )
  })
})
