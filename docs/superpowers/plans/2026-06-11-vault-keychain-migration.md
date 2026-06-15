# Luna Vault Keychain Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Darwin Vault env-secret values from plaintext `~/.luna/.env` into macOS Keychain without breaking existing `env:*` refs, Linux/non-Darwin deployments, Moon, web Vault UI, connector OAuth, or 1Password sync.

**Architecture:** Keep `env:VARNAME` as the stable public pointer. Add a Darwin-only Keychain-backed provider and write path that stores values under `luna.vault.<VARNAME>` while preserving `.env` as the Linux fallback and rollback path. Roll out through dual-read and explicit migration commands before any plaintext pruning.

**Tech Stack:** TypeScript, Effect `Layer`, `SecretProvider`, Vitest, Node `child_process.spawn/execFile`, macOS `security` CLI, Bun workspace scripts, Luna UI WebSocket Vault protocol.

---

## Constraints And Non-Negotiables

- Existing `env:*` refs remain valid. Do not introduce a new `keychain:` account/vault ref for this migration.
- `vault_items` stays pointer/metadata only. Never store secret values in SQLite.
- Linux/non-Darwin behavior stays `.env`-backed. Keychain code must fail closed or fall through without shelling out on non-Darwin.
- Rollback must be one env var plus restart until the explicit prune step runs.
- Do not delete `.env` values during initial migration. First migration mode is copy-only.
- Keep connector OAuth working. `LUNA_CONNECTOR_*` names are internal and intentionally bypass the human/agent reserved-name gate.
- Do not log secret values, include them in error messages, expose them in Moon/web DOM, snapshots, or WebSocket list frames.

## File Map

- Create: `packages/core/src/secret-provider/keychain-env-backend.ts`
  - Reads `env:*` refs from macOS Keychain service `luna.vault.<VAR_NAME>`, account `<VAR_NAME>`.
  - Exposes helper functions for service/account naming and test injection.
- Modify: `packages/core/src/secret-provider/keychain-helper.ts`
  - Generalize the current read-only helper with write/delete helpers that use `security add-generic-password -U` and `security delete-generic-password`.
- Modify: `packages/core/src/secret-provider/index.ts`
  - Export the new Keychain env backend and helper types.
- Modify: `packages/core/src/secret-provider/secret-provider.test.ts`
  - Add provider fallback and redaction tests for Keychain env reads.
- Create: `packages/core/src/secret-provider/keychain-helper.test.ts`
  - Tests read/write/delete platform behavior, not-found behavior, timeout behavior, and no value leakage in errors.
- Create: `apps/ui-web/scripts/vault-secret-store.ts`
  - Central write/delete/read-migration facade used by chat-server Vault paths.
  - Supports modes `env`, `keychain-preferred`, and `keychain-only`.
- Create: `apps/ui-web/scripts/vault-secret-store.test.ts`
  - Tests write/delete/migrate behavior with fake env file and fake Keychain adapter.
- Modify: `apps/ui-web/scripts/chat-server.ts`
  - Replace direct `persistEnvSecret` / `removeEnvSecret` calls on env-secret Vault paths with the facade.
  - Insert `KeychainEnvSecretProvider` before `EnvSecretProvider` in the `SecretProvider` chain when mode is `keychain-preferred` or `keychain-only`.
- Create: `apps/ui-web/scripts/vault-migrate-keychain.ts`
  - CLI script for dry-run/apply/prune migration.
- Modify: `package.json`
  - Add scripts for migration dry-run and apply.
- Modify: `docs/audits/luna-vault-keychain-migration.md`
  - Operator runbook: modes, migration, verification, rollback, prune.

## Storage Modes

Use one env var:

```ts
type VaultStorageMode = "env" | "keychain-preferred" | "keychain-only"
```

- `env`: current behavior. Read/write/delete `.env` only. Default for first release.
- `keychain-preferred`: Darwin reads Keychain first, then `.env`; writes new env-secrets to Keychain and mirrors `process.env` for the current process; migration copies `.env` values to Keychain.
- `keychain-only`: Darwin reads Keychain only for `env:*`; `.env` is ignored for migrated Vault env-secret values. Use only after canary.

Non-Darwin forces `env` behavior unless explicitly running migration dry-run.

---

## Task 1: Land Security Hotfix Separately

**Files:**
- Already present in branch: `packages/secret-tools/src/register-secret.ts`
- Already present in branch: `apps/ui-web/scripts/chat-server.ts`
- Already present in branch: `packages/vault/src/internal.ts`
- Already present in branch: `packages/ui-ws/src/server.ts`

- [x] **Step 1: Verify the branch contains the audit hotfix commit**

Run:

```bash
git log --oneline --decorate master..HEAD
```

Expected:

```text
37d0d22 fix(vault): security-audit hardening — agent path honors the reserved-name denylist
b8b02f7 feat(vault): Apple Passwords CSV import on Moon — first-class-client parity
```

- [x] **Step 2: Verify targeted security tests pass**

Run:

```bash
bun run test -- packages/secret-tools/test/register-secret.test.ts packages/vault/test/reconciler.test.ts packages/ui-ws/test/server.test.ts
```

Expected:

```text
Test Files  3 passed
Tests       68 passed
```

- [x] **Step 3: Ship or cherry-pick only the hardening commit before Keychain work**

Run if integrating from this worktree:

```bash
git show --stat 37d0d22
```

Expected: only hardening files, not Moon CSV import files.

Commit checkpoint:

```bash
git status --short
```

Expected: clean or only planned Keychain files modified.

---

## Task 2: Generalize Keychain Helper

**Files:**
- Modify: `packages/core/src/secret-provider/keychain-helper.ts`
- Create: `packages/core/src/secret-provider/keychain-helper.test.ts`
- Modify: `packages/core/src/secret-provider/index.ts`

- [x] **Step 1: Write failing tests for write/delete helpers**

Create `packages/core/src/secret-provider/keychain-helper.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { Effect, Exit } from "effect"
import {
  deleteKeychainSecret,
  readKeychainToken,
  writeKeychainSecret,
  type KeychainQuery,
} from "./keychain-helper.js"

const q: KeychainQuery = { service: "luna.vault.OPENAI_API_KEY", account: "OPENAI_API_KEY" }

describe("keychain-helper write/delete", () => {
  it("writes with security add-generic-password -U without leaking the value", async () => {
    const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = []
    const fakeExecFile = ((cmd: string, args: string[], opts: unknown, cb: Function) => {
      calls.push({ cmd, args, opts })
      cb(null, "", "")
      return { kill() {}, on() {} }
    }) as never

    await Effect.runPromise(
      writeKeychainSecret(q, "super-secret-value", {
        _platform: "darwin",
        _execFile: fakeExecFile,
      }),
    )

    expect(calls[0]?.cmd).toBe("security")
    expect(calls[0]?.args).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "luna.vault.OPENAI_API_KEY",
      "-a",
      "OPENAI_API_KEY",
      "-w",
      "super-secret-value",
    ])
  })

  it("deletes idempotently when security reports item not found", async () => {
    const fakeExecFile = ((cmd: string, args: string[], opts: unknown, cb: Function) => {
      const err = Object.assign(new Error("missing"), { code: 44 })
      cb(err, "", "")
      return { kill() {}, on() {} }
    }) as never

    await Effect.runPromise(
      deleteKeychainSecret(q, {
        _platform: "darwin",
        _execFile: fakeExecFile,
      }),
    )
  })

  it("fails without shelling out on non-darwin", async () => {
    const fakeExecFile = vi.fn() as never
    const exit = await Effect.runPromiseExit(
      writeKeychainSecret(q, "value", {
        _platform: "linux",
        _execFile: fakeExecFile,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fakeExecFile).not.toHaveBeenCalled()
  })

  it("read errors do not include secret values", async () => {
    const fakeExecFile = ((cmd: string, args: string[], opts: unknown, cb: Function) => {
      cb(Object.assign(new Error("boom"), { code: 1 }), "", "security failed")
      return { kill() {}, on() {} }
    }) as never

    const exit = await Effect.runPromiseExit(
      readKeychainToken(q, {
        _platform: "darwin",
        _execFile: fakeExecFile,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).not.toContain("super-secret-value")
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
bun run test -- packages/core/src/secret-provider/keychain-helper.test.ts
```

Expected: FAIL because `writeKeychainSecret` and `deleteKeychainSecret` are not exported.

- [x] **Step 3: Implement write/delete helpers**

In `packages/core/src/secret-provider/keychain-helper.ts`, add:

```ts
export const writeKeychainSecret = (
  q: KeychainQuery,
  value: string,
  internals: KeychainHelperInternals = {},
): Effect.Effect<void, ConfigError> => {
  const platform = internals._platform ?? process.platform
  if (platform !== "darwin") {
    return Effect.fail(platformConfigError(platform))
  }
  const ef = internals._execFile ?? execFile
  const timeoutMs = internals._timeoutMs ?? DEFAULT_TIMEOUT_MS

  return Effect.async<void, ConfigError>((resume) => {
    let settled = false
    const settle = (e: Effect.Effect<void, ConfigError>): void => {
      if (settled) return
      settled = true
      resume(e)
    }

    const child = ef(
      "security",
      ["add-generic-password", "-U", "-s", q.service, "-a", q.account, "-w", value],
      { timeout: timeoutMs },
      (err: ExecFileException | null, _stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) {
          if ((err as ExecFileException & { killed?: boolean }).killed === true || err.signal === "SIGTERM") {
            settle(Effect.fail(timeoutConfigError(q)))
            return
          }
          const stderrStr = typeof stderr === "string" ? stderr : stderr.toString("utf8")
          settle(Effect.fail(spawnFailureConfigError(stderrStr)))
          return
        }
        settle(Effect.succeed(undefined))
      },
    )

    const guard = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      settle(Effect.fail(timeoutConfigError(q)))
    }, timeoutMs + 100)
    child.on("close", () => clearTimeout(guard))
    child.on("error", () => clearTimeout(guard))
  })
}

export const deleteKeychainSecret = (
  q: KeychainQuery,
  internals: KeychainHelperInternals = {},
): Effect.Effect<void, ConfigError> => {
  const platform = internals._platform ?? process.platform
  if (platform !== "darwin") {
    return Effect.fail(platformConfigError(platform))
  }
  const ef = internals._execFile ?? execFile
  const timeoutMs = internals._timeoutMs ?? DEFAULT_TIMEOUT_MS

  return Effect.async<void, ConfigError>((resume) => {
    let settled = false
    const settle = (e: Effect.Effect<void, ConfigError>): void => {
      if (settled) return
      settled = true
      resume(e)
    }

    const child = ef(
      "security",
      ["delete-generic-password", "-s", q.service, "-a", q.account],
      { timeout: timeoutMs },
      (err: ExecFileException | null, _stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) {
          if ((err as ExecFileException & { killed?: boolean }).killed === true || err.signal === "SIGTERM") {
            settle(Effect.fail(timeoutConfigError(q)))
            return
          }
          if (err.code === 44) {
            settle(Effect.succeed(undefined))
            return
          }
          const stderrStr = typeof stderr === "string" ? stderr : stderr.toString("utf8")
          settle(Effect.fail(spawnFailureConfigError(stderrStr)))
          return
        }
        settle(Effect.succeed(undefined))
      },
    )

    const guard = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      settle(Effect.fail(timeoutConfigError(q)))
    }, timeoutMs + 100)
    child.on("close", () => clearTimeout(guard))
    child.on("error", () => clearTimeout(guard))
  })
}
```

Update `packages/core/src/secret-provider/index.ts`:

```ts
export {
  readKeychainToken,
  writeKeychainSecret,
  deleteKeychainSecret,
  type KeychainQuery,
} from "./keychain-helper.js"
```

- [x] **Step 4: Run helper tests**

Run:

```bash
bun run test -- packages/core/src/secret-provider/keychain-helper.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/secret-provider/keychain-helper.ts packages/core/src/secret-provider/keychain-helper.test.ts packages/core/src/secret-provider/index.ts
git commit -m "feat(vault): add keychain secret write helpers"
```

---

## Task 3: Add Keychain Env SecretProvider

**Files:**
- Create: `packages/core/src/secret-provider/keychain-env-backend.ts`
- Modify: `packages/core/src/secret-provider/index.ts`
- Modify: `packages/core/src/secret-provider/secret-provider.test.ts`

- [x] **Step 1: Write failing provider tests**

Add to `packages/core/src/secret-provider/secret-provider.test.ts`:

```ts
import { KeychainEnvSecretProvider } from "./index.js"

describe("KeychainEnvSecretProvider", () => {
  it("resolves env: refs from luna.vault.<name> keychain entries", async () => {
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:OPENAI_API_KEY")
      }).pipe(
        Effect.provide(
          KeychainEnvSecretProvider.make({
            _platform: "darwin",
            _read: (q) =>
              q.service === "luna.vault.OPENAI_API_KEY" && q.account === "OPENAI_API_KEY"
                ? Effect.succeed("from-keychain")
                : Effect.fail(new Error("wrong key") as never),
          }),
        ),
      ),
    )

    expect(Redacted.value(got)).toBe("from-keychain")
  })

  it("misses non-env refs so firstOf can fall through", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("file:thing")
      }).pipe(
        Effect.provide(
          KeychainEnvSecretProvider.make({
            _platform: "darwin",
            _read: () => Effect.succeed("should-not-run"),
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("falls through to EnvSecretProvider when keychain misses", async () => {
    process.env.OPENAI_API_KEY = "from-env"
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:OPENAI_API_KEY")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf([
            KeychainEnvSecretProvider.make({
              _platform: "darwin",
              _read: () => Effect.fail(new Error("not found") as never),
            }),
            EnvSecretProvider.Default,
          ]),
        ),
      ),
    )
    delete process.env.OPENAI_API_KEY

    expect(Redacted.value(got)).toBe("from-env")
  })
})
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
bun run test -- packages/core/src/secret-provider/secret-provider.test.ts
```

Expected: FAIL because `KeychainEnvSecretProvider` does not exist.

- [x] **Step 3: Implement provider**

Create `packages/core/src/secret-provider/keychain-env-backend.ts`:

```ts
import { Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"
import { readKeychainToken, type KeychainQuery } from "./keychain-helper.js"

const ENV_PREFIX = "env:"

export const keychainVaultQueryForEnvName = (name: string): KeychainQuery => ({
  service: `luna.vault.${name}`,
  account: name,
})

interface KeychainEnvInternals {
  readonly _platform?: NodeJS.Platform
  readonly _read?: (q: KeychainQuery) => Effect.Effect<string, ConfigError>
}

export const KeychainEnvSecretProvider = {
  make: (internals: KeychainEnvInternals = {}): Layer.Layer<SecretProvider, ConfigError> =>
    Layer.effect(
      SecretProvider,
      Effect.sync(
        (): SecretProviderApi => ({
          get: (ref) => {
            if (!ref.startsWith(ENV_PREFIX)) {
              return Effect.fail(
                new ConfigError({
                  module: "KeychainEnvSecretProvider",
                  key: ref,
                  message: `ref "${ref}" is not an env: ref`,
                }),
              )
            }
            const name = ref.slice(ENV_PREFIX.length)
            const read =
              internals._read ??
              ((q: KeychainQuery) =>
                readKeychainToken(q, { _platform: internals._platform }))
            return read(keychainVaultQueryForEnvName(name)).pipe(
              Effect.map((v) => Redacted.make(v)),
              Effect.mapError(
                () =>
                  new ConfigError({
                    module: "KeychainEnvSecretProvider",
                    key: ref,
                    message: `keychain env secret "${name}" is not set`,
                  }),
              ),
            )
          },
        }),
      ),
    ),
} as const
```

Update `packages/core/src/secret-provider/index.ts`:

```ts
export {
  KeychainEnvSecretProvider,
  keychainVaultQueryForEnvName,
} from "./keychain-env-backend.js"
```

- [x] **Step 4: Run tests**

Run:

```bash
bun run test -- packages/core/src/secret-provider/secret-provider.test.ts packages/core/src/secret-provider/keychain-helper.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/secret-provider/keychain-env-backend.ts packages/core/src/secret-provider/index.ts packages/core/src/secret-provider/secret-provider.test.ts
git commit -m "feat(vault): resolve env refs from keychain on darwin"
```

---

## Task 4: Add Vault Secret Store Facade

**Files:**
- Create: `apps/ui-web/scripts/vault-secret-store.ts`
- Create: `apps/ui-web/scripts/vault-secret-store.test.ts`

- [x] **Step 1: Write failing facade tests**

Create `apps/ui-web/scripts/vault-secret-store.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { makeVaultSecretStore } from "./vault-secret-store.js"

describe("makeVaultSecretStore", () => {
  it("defaults to env mode and writes only env", async () => {
    const env: Record<string, string | undefined> = {}
    const writes: string[] = []
    const store = makeVaultSecretStore({
      platform: "darwin",
      mode: "env",
      env,
      writeEnv: async (name, value) => {
        writes.push(`${name}=${value}`)
        env[name] = value
      },
      removeEnv: async (name) => {
        delete env[name]
      },
      writeKeychain: async () => {
        throw new Error("must not write keychain")
      },
      deleteKeychain: async () => {
        throw new Error("must not delete keychain")
      },
    })

    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")

    expect(writes).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("keychain-preferred on darwin writes keychain and process env but not env file", async () => {
    const env: Record<string, string | undefined> = {}
    const keychainWrites: string[] = []
    const store = makeVaultSecretStore({
      platform: "darwin",
      mode: "keychain-preferred",
      env,
      writeEnv: async () => {
        throw new Error("must not write env file")
      },
      removeEnv: async () => {},
      writeKeychain: async (name, value) => {
        keychainWrites.push(`${name}=${value}`)
      },
      deleteKeychain: async () => {},
    })

    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")

    expect(keychainWrites).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("non-darwin keychain-preferred falls back to env mode", async () => {
    const env: Record<string, string | undefined> = {}
    const writes: string[] = []
    const store = makeVaultSecretStore({
      platform: "linux",
      mode: "keychain-preferred",
      env,
      writeEnv: async (name, value) => {
        writes.push(`${name}=${value}`)
        env[name] = value
      },
      removeEnv: async () => {},
      writeKeychain: async () => {
        throw new Error("must not write keychain")
      },
      deleteKeychain: async () => {},
    })

    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")

    expect(writes).toEqual(["OPENAI_API_KEY=sk-test"])
  })

  it("delete in keychain-preferred removes keychain but leaves rollback env file to migration prune", async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "old" }
    const deleted: string[] = []
    const store = makeVaultSecretStore({
      platform: "darwin",
      mode: "keychain-preferred",
      env,
      writeEnv: async () => {},
      removeEnv: async () => {
        throw new Error("must not remove env rollback copy here")
      },
      writeKeychain: async () => {},
      deleteKeychain: async (name) => {
        deleted.push(name)
      },
    })

    await store.removeEnvSecret("OPENAI_API_KEY")

    expect(deleted).toEqual(["OPENAI_API_KEY"])
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
bun run test -- apps/ui-web/scripts/vault-secret-store.test.ts
```

Expected: FAIL because the facade does not exist.

- [x] **Step 3: Implement facade**

Create `apps/ui-web/scripts/vault-secret-store.ts`:

```ts
export type VaultStorageMode = "env" | "keychain-preferred" | "keychain-only"

export interface VaultSecretStoreDeps {
  readonly platform: NodeJS.Platform
  readonly mode: VaultStorageMode
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>
  readonly writeEnv: (name: string, value: string) => Promise<void>
  readonly removeEnv: (name: string) => Promise<void>
  readonly writeKeychain: (name: string, value: string) => Promise<void>
  readonly deleteKeychain: (name: string) => Promise<void>
}

export interface VaultSecretStore {
  readonly effectiveMode: VaultStorageMode
  readonly persistEnvSecret: (name: string, value: string) => Promise<void>
  readonly removeEnvSecret: (name: string) => Promise<void>
}

export const normalizeVaultStorageMode = (
  raw: string | undefined,
  platform: NodeJS.Platform,
): VaultStorageMode => {
  const mode =
    raw === "keychain-preferred" || raw === "keychain-only" || raw === "env"
      ? raw
      : "env"
  if (platform !== "darwin") return "env"
  return mode
}

export const makeVaultSecretStore = (deps: VaultSecretStoreDeps): VaultSecretStore => {
  const effectiveMode = normalizeVaultStorageMode(deps.mode, deps.platform)

  return {
    effectiveMode,
    persistEnvSecret: async (name, value) => {
      if (effectiveMode === "env") {
        await deps.writeEnv(name, value)
        deps.env[name] = value
        return
      }
      await deps.writeKeychain(name, value)
      deps.env[name] = value
    },
    removeEnvSecret: async (name) => {
      delete deps.env[name]
      if (effectiveMode === "env") {
        await deps.removeEnv(name)
        return
      }
      await deps.deleteKeychain(name)
    },
  }
}
```

- [x] **Step 4: Run facade tests**

Run:

```bash
bun run test -- apps/ui-web/scripts/vault-secret-store.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/ui-web/scripts/vault-secret-store.ts apps/ui-web/scripts/vault-secret-store.test.ts
git commit -m "feat(vault): add secret storage mode facade"
```

---

## Task 5: Wire Chat Server To Facade And Provider Chain

**Files:**
- Modify: `apps/ui-web/scripts/chat-server.ts`
- Modify: `apps/ui-web/scripts/vault-secret-store.test.ts`
- Modify: `packages/core/src/secret-provider/secret-provider.test.ts`

- [x] **Step 1: Add integration tests for mode selection**

Add to `apps/ui-web/scripts/vault-secret-store.test.ts`:

```ts
import { normalizeVaultStorageMode } from "./vault-secret-store.js"

describe("normalizeVaultStorageMode", () => {
  it("defaults unknown values to env", () => {
    expect(normalizeVaultStorageMode(undefined, "darwin")).toBe("env")
    expect(normalizeVaultStorageMode("bad", "darwin")).toBe("env")
  })

  it("allows keychain modes only on darwin", () => {
    expect(normalizeVaultStorageMode("keychain-preferred", "darwin")).toBe("keychain-preferred")
    expect(normalizeVaultStorageMode("keychain-only", "darwin")).toBe("keychain-only")
    expect(normalizeVaultStorageMode("keychain-preferred", "linux")).toBe("env")
    expect(normalizeVaultStorageMode("keychain-only", "linux")).toBe("env")
  })
})
```

- [x] **Step 2: Modify chat-server imports**

In `apps/ui-web/scripts/chat-server.ts`, add imports:

```ts
import {
  KeychainEnvSecretProvider,
  deleteKeychainSecret,
  keychainVaultQueryForEnvName,
  writeKeychainSecret,
} from "@luna/core"
import {
  makeVaultSecretStore,
  normalizeVaultStorageMode,
} from "./vault-secret-store.js"
```

If `@luna/core` already imports secret-provider symbols in the same block, merge into the existing import.

- [x] **Step 3: Add real Keychain env write/delete adapters**

Near the existing `persistEnvSecret` and `removeEnvSecret`, add:

```ts
const writeKeychainEnvSecret = (varName: string, value: string): Promise<void> =>
  Effect.runPromise(writeKeychainSecret(keychainVaultQueryForEnvName(varName), value))

const deleteKeychainEnvSecret = (varName: string): Promise<void> =>
  Effect.runPromise(deleteKeychainSecret(keychainVaultQueryForEnvName(varName)))
```

- [x] **Step 4: Instantiate facade after env helpers**

Below `removeEnvSecret`, add:

```ts
const vaultStorageMode = normalizeVaultStorageMode(
  process.env["LUNA_VAULT_STORAGE"],
  process.platform,
)

const vaultSecretStore = makeVaultSecretStore({
  platform: process.platform,
  mode: vaultStorageMode,
  env: process.env,
  writeEnv: persistEnvSecret,
  removeEnv: removeEnvSecret,
  writeKeychain: writeKeychainEnvSecret,
  deleteKeychain: deleteKeychainEnvSecret,
})
```

- [x] **Step 5: Replace env-secret store/delete call sites**

Replace register-secret dependency:

```ts
persistEnvSecret,
```

with:

```ts
persistEnvSecret: vaultSecretStore.persistEnvSecret,
```

Replace Vault mutation dependency `persistEnvSecret` references with:

```ts
persistEnvSecret: vaultSecretStore.persistEnvSecret,
removeEnvSecret: vaultSecretStore.removeEnvSecret,
```

Keep connector OAuth `storeSecret` on the direct `.env` path for this migration:

```ts
await persistEnvSecret(varName, value, true)
```

Do not route connector OAuth through `vaultSecretStore` yet. Connector internals use `LUNA_CONNECTOR_*` and have separate lifecycle semantics.

- [x] **Step 6: Wire provider chain**

Replace:

```ts
const envProviderL = EnvSecretProvider.Default
const secretL = secretProviderFirstOf([routedOpL, envProviderL])
```

with:

```ts
const envProviderL = EnvSecretProvider.Default
const keychainEnvProviderL = KeychainEnvSecretProvider.make()
const secretL =
  vaultStorageMode === "keychain-preferred"
    ? secretProviderFirstOf([routedOpL, keychainEnvProviderL, envProviderL])
    : vaultStorageMode === "keychain-only"
      ? secretProviderFirstOf([routedOpL, keychainEnvProviderL])
      : secretProviderFirstOf([routedOpL, envProviderL])
```

- [x] **Step 7: Run focused tests**

Run:

```bash
bun run test -- apps/ui-web/scripts/vault-secret-store.test.ts packages/core/src/secret-provider/secret-provider.test.ts packages/core/src/secret-provider/keychain-helper.test.ts packages/secret-tools/test/register-secret.test.ts packages/vault/test/mutations.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add apps/ui-web/scripts/chat-server.ts apps/ui-web/scripts/vault-secret-store.test.ts packages/core/src/secret-provider/secret-provider.test.ts
git commit -m "feat(vault): wire env secrets through keychain-preferred mode"
```

---

## Task 6: Add Idempotent Migration CLI

**Files:**
- Create: `apps/ui-web/scripts/vault-migrate-keychain.ts`
- Modify: `package.json`
- Create: `apps/ui-web/scripts/vault-migrate-keychain.test.ts`

- [x] **Step 1: Write failing migration tests**

Create `apps/ui-web/scripts/vault-migrate-keychain.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { planVaultKeychainMigration } from "./vault-migrate-keychain.js"

describe("planVaultKeychainMigration", () => {
  it("plans eligible env secrets and skips reserved names", () => {
    const plan = planVaultKeychainMigration({
      envNames: ["OPENAI_API_KEY", "LUNA_INTERNAL", "UI_WS_TOKEN", "ANTHROPIC_API_KEY"],
      existingKeychainNames: new Set(["ANTHROPIC_API_KEY"]),
    })

    expect(plan.toCopy).toEqual(["OPENAI_API_KEY"])
    expect(plan.alreadyCopied).toEqual(["ANTHROPIC_API_KEY"])
    expect(plan.skippedReserved).toEqual(["LUNA_INTERNAL", "UI_WS_TOKEN"])
  })
})
```

- [x] **Step 2: Run test to verify failure**

Run:

```bash
bun run test -- apps/ui-web/scripts/vault-migrate-keychain.test.ts
```

Expected: FAIL because migration module does not exist.

- [x] **Step 3: Implement migration planning and CLI skeleton**

Create `apps/ui-web/scripts/vault-migrate-keychain.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolveRuntimePaths } from "./runtime-paths.js"

export interface VaultKeychainMigrationPlanInput {
  readonly envNames: ReadonlyArray<string>
  readonly existingKeychainNames: ReadonlySet<string>
}

export interface VaultKeychainMigrationPlan {
  readonly toCopy: ReadonlyArray<string>
  readonly alreadyCopied: ReadonlyArray<string>
  readonly skippedReserved: ReadonlyArray<string>
}

const isReserved = (name: string): boolean => {
  const upper = name.toUpperCase()
  return upper === "UI_WS_TOKEN" || upper.startsWith("LUNA_")
}

export const parseEnvFileNames = (body: string): string[] => {
  const names: string[] = []
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (t === "" || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    if (key) names.push(key)
  }
  return names
}

export const planVaultKeychainMigration = (
  input: VaultKeychainMigrationPlanInput,
): VaultKeychainMigrationPlan => {
  const toCopy: string[] = []
  const alreadyCopied: string[] = []
  const skippedReserved: string[] = []

  for (const name of input.envNames) {
    if (isReserved(name)) {
      skippedReserved.push(name)
    } else if (input.existingKeychainNames.has(name)) {
      alreadyCopied.push(name)
    } else {
      toCopy.push(name)
    }
  }

  return { toCopy, alreadyCopied, skippedReserved }
}

export const readRuntimeEnvNames = (): string[] => {
  const envPath = resolveRuntimePaths().envFilePath
  return parseEnvFileNames(readFileSync(envPath, "utf8"))
}
```

Add the runnable CLI body only after tests cover planning. The CLI must support:

```bash
bun apps/ui-web/scripts/vault-migrate-keychain.ts --dry-run
bun apps/ui-web/scripts/vault-migrate-keychain.ts --apply --keep-env
bun apps/ui-web/scripts/vault-migrate-keychain.ts --prune-env
```

Runtime behavior:

```text
--dry-run    print toCopy/alreadyCopied/skippedReserved, write nothing
--apply      copy current .env values into Keychain, leave .env intact
--keep-env   required with --apply in first version; prevents accidental destructive migration
--prune-env  remove only names that are confirmed readable from Keychain
```

- [x] **Step 4: Add package scripts**

Modify `package.json`:

```json
{
  "scripts": {
    "vault:migrate-keychain:dry-run": "bun apps/ui-web/scripts/vault-migrate-keychain.ts --dry-run",
    "vault:migrate-keychain:apply": "bun apps/ui-web/scripts/vault-migrate-keychain.ts --apply --keep-env"
  }
}
```

Keep existing scripts intact.

- [x] **Step 5: Run migration tests**

Run:

```bash
bun run test -- apps/ui-web/scripts/vault-migrate-keychain.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/ui-web/scripts/vault-migrate-keychain.ts apps/ui-web/scripts/vault-migrate-keychain.test.ts package.json
git commit -m "feat(vault): add keychain migration planner"
```

---

## Task 7: Full Regression Verification

**Files:**
- No source changes.

- [x] **Step 1: Run targeted Vault and secret-provider regression**

Run:

```bash
bun run test -- packages/core/src/secret-provider/secret-provider.test.ts packages/core/src/secret-provider/keychain-helper.test.ts packages/secret-tools/test/register-secret.test.ts packages/vault/test/store.test.ts packages/vault/test/mutations.test.ts packages/vault/test/reconciler.test.ts packages/vault/test/op-sync.test.ts packages/vault/test/wire-projection.test.ts packages/ui-ws/test/server.test.ts
```

Expected: PASS.

- [x] **Step 2: Run UI Vault regression**

Run:

```bash
bun run test -- packages/ui-shared-solid/test/vault-panel.test.tsx packages/ui-shared-solid/test/vault-panel-sync.test.tsx apps/ui-moon-tauri/test/moon-app.test.ts
```

Expected: PASS.

- [x] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [x] **Step 4: Run full test suite if time permits**
  > NOTE (2026-06-11): full vitest suite = 2451 passed / 134 skipped / **76 pre-existing failures**, all in 9 DuckDB-backed files (analytics, db/duckdb-service, telemetry/*, wake, observability-tools). Confirmed identical failure at pre-work commit `37d0d22` — the DuckDB native binding does not load in this sandbox ([[verification-baselines]]). Zero failures on the migration surface; every added suite passes.

Run:

```bash
bun run test
```

Expected: PASS.

- [x] **Step 5: Commit verification note** — no source changes in this task; no empty commit created.

If this task required small test fixes, commit them:

```bash
git add .
git commit -m "test(vault): cover keychain migration compatibility"
```

If no source changes occurred, do not create an empty commit.

---

## Task 8: Local Darwin Canary

> ⏸️ **OPERATOR-GATED — not executed by the agent.** This canary mutates the
> real `~/.luna/.env` (blocked by the secret-guard), writes real login-Keychain
> entries, and runs a foreground server. Mr. Cobb drives it using the runbook
> (`docs/audits/luna-vault-keychain-migration.md`). Steps left unchecked until
> run live.

**Files:**
- No source changes unless canary reveals a bug.

- [ ] **Step 1: Back up current env file**

Run:

```bash
cp ~/.luna/.env ~/.luna/.env.pre-keychain-canary
chmod 600 ~/.luna/.env.pre-keychain-canary
```

Expected: backup exists and is mode `600`.

- [ ] **Step 2: Exclude Luna runtime dir from Time Machine**

Run:

```bash
tmutil addexclusion ~/.luna
```

Expected: command exits `0`.

- [ ] **Step 3: Dry-run migration**

Run:

```bash
bun run vault:migrate-keychain:dry-run
```

Expected:

```text
toCopy: [...]
alreadyCopied: [...]
skippedReserved: ["UI_WS_TOKEN", ...LUNA_*]
```

- [ ] **Step 4: Apply copy-only migration**

Run:

```bash
bun run vault:migrate-keychain:apply
```

Expected: selected `.env` values are copied to Keychain, `.env` remains present.

- [ ] **Step 5: Start server in keychain-preferred mode**

Run in the server environment:

```bash
LUNA_VAULT_STORAGE=keychain-preferred bun apps/ui-web/scripts/chat-server.ts
```

Expected:

```text
[op] ... providers active
[ui-ws] ...
```

No missing-env ConfigError for migrated values.

- [ ] **Step 6: Verify runtime behavior**

Manual checks:

```text
1. Moon connects to the server.
2. Existing account using env:ANTHROPIC_API_KEY can answer a chat turn.
3. Vault list still shows metadata only.
4. Add a new env-secret through Vault UI; verify it resolves after save.
5. Delete that test secret; verify it disappears from Keychain and UI.
6. Run 1Password sync if configured; verify no secret values appear in logs.
```

- [ ] **Step 7: Rollback drill**

Stop server, then restart with:

```bash
LUNA_VAULT_STORAGE=env bun apps/ui-web/scripts/chat-server.ts
```

Expected: old `.env` values still resolve. This must pass before any prune work.

---

## Task 9: Linux/non-Darwin Compatibility Canary

> ⏸️ **OPERATOR-GATED — not executed by the agent.** Deploys to the Linux dev server
> (personal infra; standing rule = never touch autonomously). The code path is
> already covered automatically: `normalizeVaultStorageMode` forces `env` on
> non-Darwin (unit-tested), and the Keychain helpers fail closed without
> shelling out. Mr. Cobb runs the live service restart + smoke. Note the
> known fresh-DB wake-store crash (`LUNA_WAKE_ENABLED=0` workaround).

**Files:**
- No source changes unless canary reveals a bug.

- [ ] **Step 1: Deploy or copy branch to the Linux dev server**

Use the existing Luna deployment path for the Linux server. Do not manually edit live runtime files except documented env/service config.

- [ ] **Step 2: Confirm non-Darwin effective mode**

Run on the Linux server:

```bash
LUNA_VAULT_STORAGE=keychain-preferred bun run test -- apps/ui-web/scripts/vault-secret-store.test.ts
```

Expected: PASS and non-Darwin normalizes to `env`.

- [ ] **Step 3: Restart Luna dev service without Keychain dependency**

Run on the Linux server:

```bash
systemctl --user restart <your-chat-server-unit>
systemctl --user status <your-chat-server-unit> --no-pager
```

Expected: service active/running.

- [ ] **Step 4: Verify `.env` resolution still works**

Run the existing smoke path that sends a chat turn through the Linux dev server.

Expected:

```text
chat turn completes
no KeychainHelper platform error at top level
no missing env ConfigError for existing account refs
```

---

## Task 10: Documentation And Prune Release

**Files:**
- Create: `docs/audits/luna-vault-keychain-migration.md`
- Modify: `README.md` or `docs/briefs/*` only if there is an existing operator setup page that references `.env` as the only store.

- [x] **Step 1: Add operator runbook** (expanded from the skeleton: mode table, copy-only migration, verification, rollback, prune-as-separate-release, platform notes)

Create `docs/audits/luna-vault-keychain-migration.md`:

```md
# Luna Vault Keychain Migration Runbook

## Modes

- `LUNA_VAULT_STORAGE=env`: current behavior, `.env` read/write.
- `LUNA_VAULT_STORAGE=keychain-preferred`: Darwin reads Keychain first and `.env` second; writes new Vault env-secrets to Keychain.
- `LUNA_VAULT_STORAGE=keychain-only`: Darwin reads Keychain only for Vault env-secrets. Use after canary.

## Migration

1. `tmutil addexclusion ~/.luna`
2. `bun run vault:migrate-keychain:dry-run`
3. `bun run vault:migrate-keychain:apply`
4. restart with `LUNA_VAULT_STORAGE=keychain-preferred`
5. verify Moon, web Vault, chat account resolution, and 1Password sync

## Rollback

Set `LUNA_VAULT_STORAGE=env` and restart. This works until `--prune-env` is run.

## Prune

Only run prune after a successful keychain-preferred canary and rollback drill. Prune removes `.env` values only when the same name is readable from Keychain.
```

- [x] **Step 2: Run docs grep for stale claims**

Run:

```bash
rg -n "plaintext|\\.env|Vault|keychain|LUNA_VAULT_STORAGE" README.md docs apps packages
```

Expected: identify any docs that say `.env` is the only Darwin Vault store.

- [x] **Step 3: Update stale operator docs** — no-op: no operator-facing doc in README/docs references Vault/keychain/secret storage, so nothing was stale to patch.

Patch only docs that are operator-facing. Do not rewrite internal historical audit docs unless they are linked as current instructions.

- [x] **Step 4: Commit docs**

```bash
git add docs/audits/luna-vault-keychain-migration.md README.md docs
git commit -m "docs(vault): document keychain migration and rollback"
```

---

## Final Acceptance Checklist

- [x] Security hotfix shipped independently or clearly reviewable as the first commit. *(`37d0d22`, isolated)*
- [x] Default mode remains `env`. *(`normalizeVaultStorageMode` default; unit-tested)*
- [x] Darwin `keychain-preferred` dual-read works. *(provider chain + fall-through unit-tested; live round-trip = Task 8)*
- [x] Linux/non-Darwin remains `.env`. *(non-Darwin forces `env`; unit-tested)*
- [x] Migration dry-run is read-only. *(writes nothing)*
- [x] Migration apply is copy-only. *(requires `--keep-env`; leaves `.env`)*
- [x] Prune is separate, explicit, and verifies Keychain readability before removing `.env` lines. *(`runPrune` probes readable names first; not run this pass)*
- [x] Existing `env:*` refs still work without DB migration. *(ref format + `vault_items` schema unchanged)*
- [x] Connector OAuth still writes `LUNA_CONNECTOR_*` through its existing path. *(left on direct `.env` path, `allowReserved=true`)*
- [x] No secret values are added to `vault_items`, logs, UI snapshots, or list frames. *(no value-handling changed; migration prints names only)*
- [x] Targeted tests pass. *(100 focused + 219 vault/secret-provider + 382 UI, all green)*
- [x] Typecheck passes. *(all 4 tsconfig projects, exit 0)*
- [ ] Local Darwin canary passes. *(⏸️ OPERATOR — Task 8)*
- [ ] Linux/non-Darwin canary passes. *(⏸️ OPERATOR — Task 9)*

## Suggested Execution Order

1. Task 1: ship/security checkpoint.
2. Task 2-3: provider primitives.
3. Task 4-5: server write/read wiring.
4. Task 6: migration CLI.
5. Task 7: regression suite.
6. Task 8: local Darwin canary.
7. Task 9: Linux/non-Darwin canary.
8. Task 10: docs and prune readiness.

Do not run prune in the first execution process. Treat prune as a follow-up release after at least one normal day of `keychain-preferred` usage.
