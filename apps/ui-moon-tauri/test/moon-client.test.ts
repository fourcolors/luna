/**
 * Drift guard for the Moon client identity version.
 *
 * HISTORY: src/chat/moonClient.ts carried a hand-bumped `version: '0.0.54'`
 * literal with a comment instructing the next person to bump it by hand. It
 * was missed for 23 consecutive releases while the shipped app went to 0.0.77.
 * The server writes that field into its connection identity tag AND into every
 * feedback submission's `appVersion`, so the drift silently filed every bug
 * report against a build nobody was running.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The fix imports the version directly
 * from package.json, so the equality assertion below reads the same file the
 * module does. That makes it a REGRESSION guard, not an independent
 * calculation: it fails the moment someone reintroduces a hardcoded string,
 * which is precisely and only how this broke. It cannot tell you package.json
 * itself is right - scripts/bump-moon.ts owns that, and keeps the four version
 * files in lockstep.
 *
 * Deliberately NOT asserted: that the value is not '0.0.54'. Pinning the old
 * literal would freeze a magic number forever for no marginal detection power
 * over the equality check.
 */
import { describe, it, expect } from 'vitest'
import pkg from '../package.json'
import { MoonClient } from '../frontend-react/src/chat/moonClient'

describe('MoonClient.CLIENT_INFO', () => {
  it('reports the version from package.json, not a hand-edited literal', () => {
    expect(MoonClient.CLIENT_INFO.version).toBe(pkg.version)
  })

  it('resolves to a real version string, not undefined or empty', () => {
    // Not implied by the equality check: a JSON import that resolved to
    // `undefined` under some build graph would satisfy `toBe(pkg.version)`
    // only if pkg.version were also undefined - but this catches the case
    // where the import shape changes and both sides degrade together.
    expect(MoonClient.CLIENT_INFO.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('keeps the name and platform the server matches on', () => {
    // Genuinely constant (not build-derived); pinning them stops a future
    // refactor from changing the identity the server's client-labelling reads.
    expect(MoonClient.CLIENT_INFO.name).toBe('luna-moon')
    expect(MoonClient.CLIENT_INFO.platform).toBe('tauri-darwin')
  })
})
