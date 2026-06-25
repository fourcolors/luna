/**
 * @luna/capabilities — one versioned, framework-free envelope for everything a
 * harness (Luna, Hermes, OpenClaw, …) exposes to a UI: slash commands, skills,
 * and future kinds. Zero runtime dependencies so it can be bundled into a
 * browser IIFE (like @luna/transport) and consumed by Moon's vanilla-JS frontend.
 *
 * Built incrementally via the ping-pong (BDD → RED → GREEN → audit) loop.
 * See packages/capabilities/SPEC.md for the behavioral contract.
 */

export * from "./descriptor.js"
export * from "./registry.js"
export * from "./merge.js"
export * from "./provider.js"
export * from "./reference-provider.js"
export * from "./frame-provider.js"
export * from "./command.js"
