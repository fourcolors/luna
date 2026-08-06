#!/usr/bin/env bun
/**
 * deploy-cli - scaffold entrypoint for the compiled deploy engine that will
 * eventually replace scripts/luna-guardian, scripts/luna-update-server and
 * scripts/luna-autodeploy (see docs/deploy-binary.md). This slice only wires
 * --version, --help and subcommand dispatch: every subcommand is a stub that
 * exits CRITICAL (2) until its own slice ports the real state machine.
 *
 * Compiled to a single-file binary with `bun build --compile` (see
 * ../package.json's "build" script, and scripts/luna-guardian's
 * publish_engine, which builds this against the RUNTIME's own bun at
 * publish time - the container's bun for an incus profile, the publishing
 * host's own bun otherwise - rather than cross-compiling from CI or
 * committing a prebuilt artifact, so the binary in a pin always matches the
 * exact runtime and release that pin represents; see docs/deploy-binary.md).
 */
import { defineCommand, renderUsage, runMain } from "citty"
import { EXIT_CODES } from "./exit-codes.js"
import { VERSION } from "./version.js"

/** One stub per bash entrypoint this binary will eventually fold in (S22/S24). */
const stubSurface = (name: string, description: string) =>
  defineCommand({
    meta: { name, description },
    run: () => {
      process.stderr.write(`deploy-cli ${name}: not implemented\n`)
      process.exit(EXIT_CODES.CRITICAL)
    },
  })

const main = defineCommand({
  meta: {
    name: "deploy-cli",
    version: VERSION,
    description:
      "Luna deploy engine (scaffold - state machine not yet ported from the bash scripts it will replace)",
  },
  subCommands: {
    // Mirrors scripts/luna-update-server's flag-only surface.
    update: stubSurface("update", "Update an installed Luna server to a target ref (scripts/luna-update-server)"),
    // Mirrors scripts/luna-autodeploy's <profile>/install-timer/uninstall-timer surface.
    autodeploy: stubSurface("autodeploy", "Deploy a channel when its upstream branch has moved (scripts/luna-autodeploy)"),
    // Mirrors scripts/luna-guardian's check|diagnose|adopt|install|accept|uninstall surface.
    guardian: stubSurface("guardian", "Independent host control plane: deep health, repair, updates (scripts/luna-guardian)"),
  },
})

// citty's own --version/--help handling (runMain, below) prints through
// consola, which goes silent whenever NODE_ENV=test or TEST is set in the
// environment (see docs/deploy-binary.md's "Operational gotcha" section) -
// exactly the exit-0-no-output shape this binary's publish postcondition
// exists to catch. Handling the top-level case here first, writing directly
// to stdout, makes it independent of the caller's environment. `resolveSub
// Command` (which per-subcommand --help would need) is not part of citty's
// public API, so `deploy-cli <subcommand> --help` still falls through to
// citty's own (env-sensitive) handling below - untested and undocumented,
// left for S22+ when a subcommand's real argv surface is ported.
const rawArgs = process.argv.slice(2)
const hasSubcommand = rawArgs.some((arg) => !arg.startsWith("-"))
if (!hasSubcommand && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
  process.stdout.write(`${await renderUsage(main)}\n`)
  process.exit(0)
}
if (rawArgs.length === 1 && rawArgs[0] === "--version") {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

// This module is only ever run as the CLI entrypoint (`bun run main.ts`, or
// compiled by `bun build --compile`) - nothing imports it, so runMain fires
// unconditionally rather than behind an import.meta.main guard that would
// have no importer to guard against.
void runMain(main)
