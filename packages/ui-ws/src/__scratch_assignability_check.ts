/**
 * SCRATCH — verifies the prior reviewer's claim that the raw core
 * SkillRegistryApi (whose catalog() entries carry `body`) is structurally
 * assignable to the ui-ws skillRegistry config slot. DELETE AFTER USE.
 */
import type { SkillRegistryApi } from "@luna/core"
import type { UIWebSocketServerConfig } from "./server.js"

declare const rawCoreRegistry: SkillRegistryApi

// If the finding is right, this compiles — meaning a caller can wire the
// raw registry (bodies included) without the stripping adapter and tsc
// will not complain.
export const slot: UIWebSocketServerConfig["skillRegistry"] = rawCoreRegistry

// NEGATIVE CONTROL — proves this file is actually compiled: the next line
// must ERROR. Comment in/out to test.
export const sanity: number = "not a number"
