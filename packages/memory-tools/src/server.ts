/**
 * Server-shaped re-exports — mirrors the @luna/tools convention of letting
 * callers import a "server" module that surfaces the SDK MCP config helper
 * and the bundled tool definitions.
 *
 * Most callers should use MemoryToolsLayer (./layer.ts) which provides the
 * server config inside an Effect context. This module is the lower-level
 * imperative entry: given a resolved MemoryRouter, build the same
 * `McpSdkServerConfigWithInstance` value.
 */
export {
  buildMemoryMcpServer,
  MEMORY_SYSTEM_PROMPT_ADDENDUM,
} from "./layer.js"
export { makeMemoryTools } from "./tools.js"
