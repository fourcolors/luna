/**
 * Test-only entry for @luna/capabilities, reached via "@luna/capabilities/testing".
 * Quarantined from the main barrel because it (transitively) imports vitest.
 */

export * from "./conformance.js"
