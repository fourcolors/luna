/**
 * Public barrel for @luna/mcp-registry.
 *
 * Exports the store service, its API type, and all domain types / error
 * classes.  Consumers typically import McpServerStore (Layer or tag) plus
 * the McpServerRow type and the error classes they need to handle.
 */

// Types
export type { McpServerRow, McpServerInput } from "./types.js"
export {
  McpRegistryError,
  McpSlugReserved,
  McpSlugExists,
  McpSlugInvalid,
  McpUrlInvalid,
  RESERVED_SLUGS,
  validateSlug,
  validateUrl,
} from "./types.js"

// Store
export { McpServerStore } from "./store.js"
export type { McpServerStoreApi } from "./store.js"

// Mount loader (Slice B1)
export { syncMcpMounts } from "./mount-loader.js"
export type { SyncMcpMountsOptions, SyncMcpMountsResult } from "./mount-loader.js"
