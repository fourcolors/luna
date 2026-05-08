/**
 * Server-shaped re-exports — mirrors the @luna/memory-tools convention.
 *
 * Most callers should use SchedulerToolsLayer (./layer.ts) which provides the
 * server config inside an Effect context. This module is the lower-level
 * imperative entry point.
 */
export {
  buildSchedulerMcpServer,
  SCHEDULER_SYSTEM_PROMPT_ADDENDUM,
} from "./layer.js"
export { makeSchedulerTools } from "./tools.js"
