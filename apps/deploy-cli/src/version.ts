import pkg from "../package.json"

/**
 * Read at build time so it survives `bun build --compile` (the compiled
 * binary carries no package.json alongside it once copied into an engine
 * pin - see scripts/luna-guardian's publish_engine).
 */
export const VERSION: string = pkg.version
