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
import { UPDATE_USAGE, updateArgvWantsHelp, updateCommand } from "./update-command.js"
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
    // The real thing as of S22d: the inplace-on-systemd update transaction,
    // with every other topology delegated whole to the co-pinned bash engine.
    // Imported from the SIBLING module, never from anything under ./update/ -
    // that directory is the pure-and-injected side of the process boundary and
    // this is the far side of it. See update-command.ts's header.
    update: updateCommand,
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
// public API, so every OTHER subcommand's `--help` still falls through to
// citty's own (env-sensitive) handling below.
//
// THE FIRST-NON-FLAG-TOKEN SCAN BELOW IS THE SAME COMPUTATION delegate.ts's
// `forwardedFlags` performs (delegate.ts:208), and the two must not drift: one
// decides whether this preamble owns the invocation, the other decides which
// flags are forwarded to the bash engine, and a disagreement between them
// means a run that prints help AND deploys, or neither.
const rawArgs = process.argv.slice(2)
const firstTokenIndex = rawArgs.findIndex((arg) => !arg.startsWith("-"))
const hasSubcommand = firstTokenIndex !== -1
if (!hasSubcommand && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
  process.stdout.write(`${await renderUsage(main)}\n`)
  process.exit(0)
}
// `update --help` is handled HERE, before runMain, for the same reason the
// top-level case is: citty's per-subcommand help goes silent under NODE_ENV=
// test, and handling it inside the command's own `run` is too late if citty
// intercepts first. The text is scripts/luna-update-server's usage, whose
// `Exit codes:` block operators read literally during an incident.
//
// POSITIONAL, NOT A MEMBERSHIP TEST. This used to ask whether `-h` appeared
// ANYWHERE after the token, which made `update --ref -h` print usage and exit
// 0 where the bash engine's own `case` loop assigns `-h` as the ref value and
// refuses it. `updateArgvWantsHelp` walks the argv the way that loop does; the
// slice below is `forwardedFlags`' shape (delegate.ts:207-215), computed from
// the SAME first-non-flag-token scan for the reason stated just above.
if (rawArgs[firstTokenIndex] === "update" && updateArgvWantsHelp(rawArgs.slice(firstTokenIndex + 1))) {
  process.stdout.write(UPDATE_USAGE)
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
