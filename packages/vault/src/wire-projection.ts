/**
 * toWireVaultItem — pure wire-safety projection.
 *
 * 10 wire fields; `synced` and `shadowed` are derived flags (never values).
 *
 * `varName` is extracted from an env-secret ref (`env:<NAME>`) by slicing
 * off the `env:` prefix.
 */

import type { VaultItem } from "./types.js"

/** Wire shape returned to UI clients — pointers + metadata only, no values. */
export interface WireVaultItem {
  readonly id: string
  readonly name: string
  readonly kind: VaultItem["kind"]
  readonly ref: string
  readonly source: VaultItem["source"]
  readonly description: string | null
  readonly createdAt: number
  readonly updatedAt: number
  /** True when the item has been pushed to / adopted from 1Password. */
  readonly synced: boolean
  /**
   * True when the item is an env-secret whose var name is present in
   * `shadowedEnvKeys` (i.e. the value is currently live in process.env).
   */
  readonly shadowed: boolean
}

const envVarNameFromRef = (ref: string): string =>
  ref.startsWith("env:") ? ref.slice("env:".length) : ""

/**
 * Project a VaultItem to its wire representation.
 *
 * @param item - The registry row (pointer + metadata only).
 * @param shadowedEnvKeys - Set of env var names currently live in process.env
 *   (populated from ~/.luna/.env at boot; passed by the server, never contains
 *   values — only names).
 */
export const toWireVaultItem = (
  item: VaultItem,
  shadowedEnvKeys: ReadonlySet<string>,
): WireVaultItem => ({
  id: item.id,
  name: item.name,
  kind: item.kind,
  ref: item.ref,
  source: item.source,
  description: item.description,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  synced: item.opItemId !== null,
  shadowed: item.kind === "env-secret" && shadowedEnvKeys.has(envVarNameFromRef(item.ref)),
})
