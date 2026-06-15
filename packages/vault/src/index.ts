/**
 * Public barrel for @luna/vault.
 *
 * Named exports only — wildcard re-exports were removed to prevent dead
 * symbols (isEnvDenied, humanizeName, internal dep interfaces) from leaking
 * into the public surface and creating accidental coupling.
 *
 * Production-consumed symbols (verified by grep over chat-server.ts):
 *   VaultStore, makeVaultMutations, makeVaultOpSync, reconcileVaultItems,
 *   shouldAttemptSync, toWireVaultItem, VaultItem (type), VaultSyncConfig (type).
 *
 * Test files in packages/vault/test/ import directly from their source module
 * (e.g. ../src/mutations.js) — adding symbols here is NOT required for tests.
 */

// Types
export type { VaultItem, VaultItemKind, VaultItemSource, VaultSyncConfig } from "./types.js"

// Store
export { VaultStore } from "./store.js"
export type { VaultStoreApi } from "./store.js"

// Mutations
export { makeVaultMutations } from "./mutations.js"
export type { VaultMutationDeps, VaultMutationResult, VaultMutations, VaultStoreFacade } from "./mutations.js"

// Reconciler
export { reconcileVaultItems } from "./reconciler.js"
export type { ReconcileInput, ReconcileResult } from "./reconciler.js"

// Op-sync
export { makeVaultOpSync, shouldAttemptSync } from "./op-sync.js"
export type { VaultOpSyncDeps, VaultOpSync, VaultSyncStoreFacade, ShouldAttemptSyncInput } from "./op-sync.js"

// Wire projection
export { toWireVaultItem } from "./wire-projection.js"
export type { WireVaultItem } from "./wire-projection.js"
