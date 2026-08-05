/**
 * InMemoryBackend Tier-1 tests - runs the shared MemoryBackend contract
 * (packages/memory/test/backend-contract.ts). See that file for the
 * assertions; this file is just the InMemoryBackend wiring.
 */
import { Layer } from "effect"
import { InMemoryBackend } from "../src/backends/in-memory.js"
import { BackendUnderTest, runMemoryBackendContract } from "./backend-contract.js"

runMemoryBackendContract("InMemoryBackend", () =>
  Layer.effect(BackendUnderTest, InMemoryBackend).pipe(
    Layer.provide(InMemoryBackend.Default),
  ),
)
