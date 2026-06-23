/**
 * descriptor.ts — re-exports projectLunaDescriptor from @luna/server-registry.
 *
 * This shim keeps backwards compatibility: all existing imports of
 * `projectLunaDescriptor` from "@luna/ui-ws" (e.g. server.ts) continue
 * to work without changes.
 */
export { projectLunaDescriptor } from "@luna/server-registry"
export type { LunaDescriptorInputs } from "@luna/server-registry"
