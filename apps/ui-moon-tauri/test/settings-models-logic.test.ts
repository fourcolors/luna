// Pure unit tests for the Models settings panel's state/logic
// (frontend-react/src/panels/settings-models/logic.ts), ported 1:1 from
// frontend/panels/settings-models.js's applyServerState/buildPayload/
// providerForModel. No DOM/transport involved — see
// settings-models-panel.test.tsx for the component-level behavioral suite,
// including the reducer-level 'set-role-model' case this file also covers
// (Astryx's Selector is a library-owned combobox widget; that suite drives
// its rendered current-value text, this file drives the dispatch it fires).
import { describe, expect, it } from 'vitest'
import {
  buildSavePayload,
  DEFAULT_ROLE_MODEL,
  initialModelRoutingState,
  providerForModel,
  reduceModelRouting,
  ROLES,
  type ModelRoutingState,
} from '../frontend-react/src/panels/settings-models/logic'

describe('providerForModel', () => {
  it.each([
    ['claude-sonnet-5', 'anthropic'],
    ['anthropic/claude-opus-4-8', 'anthropic'],
    ['gemini-2.5-pro', 'google'],
    ['gpt-5.1', 'openai'],
    ['o3-mini', 'openai'],
    ['qwen3:4b:cloud', 'ollama-cloud'],
    ['local/qwen3:4b', 'ollama-local'],
    ['some-unknown-model', 'anthropic'], // fallback
  ])('maps %s -> %s', (model, expected) => {
    expect(providerForModel(model)).toBe(expected)
  })
})

describe('reduceModelRouting', () => {
  it('hello sets serverSupports from the capability flag', () => {
    const next = reduceModelRouting(initialModelRoutingState, { type: 'hello', modelRouting: true })
    expect(next.serverSupports).toBe(true)
  })

  it('server-list seeds drafts from providers/roleBindings when clean', () => {
    const next = reduceModelRouting(initialModelRoutingState, {
      type: 'server-list',
      providers: [{ kind: 'anthropic', enabled: true, credentialRef: 'env:X', monthlyCapUsd: 25 }],
      roleBindings: [{ role: 'advisor', preferenceList: [{ provider: 'anthropic', model: 'claude-opus-4-8' }] }],
    })
    expect(next.draftProviders.anthropic).toEqual({ enabled: true, credentialRef: 'env:X', monthlyCapUsd: 25 })
    expect(next.draftRoleModel.advisor).toBe('claude-opus-4-8')
    // Roles/providers absent from the server frame fall back to defaults.
    expect(next.draftRoleModel.dream).toBe(DEFAULT_ROLE_MODEL.dream)
    expect(next.draftProviders.openai).toEqual({ enabled: false, credentialRef: '', monthlyCapUsd: '' })
  })

  it('server-list is a no-op while isDirty', () => {
    const dirty: ModelRoutingState = { ...initialModelRoutingState, isDirty: true }
    const next = reduceModelRouting(dirty, {
      type: 'server-list',
      providers: [{ kind: 'anthropic', enabled: true }],
      roleBindings: [],
    })
    expect(next).toBe(dirty) // same reference — truly a no-op
  })

  it('toggle-provider / set-credential-ref / set-monthly-cap all mark isDirty', () => {
    let state = initialModelRoutingState
    state = reduceModelRouting(state, { type: 'toggle-provider', kind: 'anthropic', enabled: true })
    expect(state.isDirty).toBe(true)
    expect(state.draftProviders.anthropic.enabled).toBe(true)

    state = reduceModelRouting({ ...state, isDirty: false }, {
      type: 'set-credential-ref',
      kind: 'anthropic',
      value: 'env:ANTHROPIC_API_KEY',
    })
    expect(state.isDirty).toBe(true)
    expect(state.draftProviders.anthropic.credentialRef).toBe('env:ANTHROPIC_API_KEY')

    state = reduceModelRouting({ ...state, isDirty: false }, { type: 'set-monthly-cap', kind: 'anthropic', value: 50 })
    expect(state.isDirty).toBe(true)
    expect(state.draftProviders.anthropic.monthlyCapUsd).toBe(50)
  })

  it('set-role-model updates the draft for exactly the targeted role', () => {
    const next = reduceModelRouting(initialModelRoutingState, {
      type: 'set-role-model',
      role: 'dream',
      model: 'claude-haiku-4-5',
    })
    expect(next.draftRoleModel.dream).toBe('claude-haiku-4-5')
    expect(next.draftRoleModel.advisor).toBe(DEFAULT_ROLE_MODEL.advisor) // untouched
    expect(next.isDirty).toBe(true)
  })

  it('save-start records the requestId and shows "Saving…"', () => {
    const next = reduceModelRouting(initialModelRoutingState, { type: 'save-start', requestId: 'mr_abc' })
    expect(next.reqId).toBe('mr_abc')
    expect(next.status).toEqual({ message: 'Saving…', kind: 'info' })
  })

  it('save-result ignores a mismatched requestId', () => {
    const inFlight: ModelRoutingState = { ...initialModelRoutingState, reqId: 'mr_real' }
    const next = reduceModelRouting(inFlight, { type: 'save-result', requestId: 'mr_stale', ok: true, message: 'nope' })
    expect(next).toBe(inFlight)
  })

  it('save-result ok:true clears reqId + isDirty and reports the message', () => {
    const inFlight: ModelRoutingState = { ...initialModelRoutingState, reqId: 'mr_1', isDirty: true }
    const next = reduceModelRouting(inFlight, { type: 'save-result', requestId: 'mr_1', ok: true, message: 'Saved.' })
    expect(next.reqId).toBeNull()
    expect(next.isDirty).toBe(false)
    expect(next.status).toEqual({ message: 'Saved.', kind: 'ok' })
  })

  it('save-result ok:false clears reqId but preserves isDirty', () => {
    const inFlight: ModelRoutingState = { ...initialModelRoutingState, reqId: 'mr_1', isDirty: true }
    const next = reduceModelRouting(inFlight, { type: 'save-result', requestId: 'mr_1', ok: false, message: 'Bad ref.' })
    expect(next.reqId).toBeNull()
    expect(next.isDirty).toBe(true)
    expect(next.status).toEqual({ message: 'Bad ref.', kind: 'error' })
  })

  it('not-connected reports the disconnected status without touching drafts', () => {
    const next = reduceModelRouting(initialModelRoutingState, { type: 'not-connected' })
    expect(next.status).toEqual({ message: 'Not connected to a server.', kind: 'error' })
    expect(next.draftProviders).toBe(initialModelRoutingState.draftProviders)
  })
})

describe('buildSavePayload', () => {
  it('omits credentialRef/monthlyCapUsd when unset, and infers each role\'s provider from its model id', () => {
    const payload = buildSavePayload(initialModelRoutingState)
    const anthropic = payload.providers.find((p) => p.kind === 'anthropic')!
    expect(anthropic.enabled).toBe(false)
    expect(anthropic.credentialRef).toBeUndefined()
    expect(anthropic.monthlyCapUsd).toBeUndefined()
    expect(payload.roleBindings).toHaveLength(ROLES.length)
    for (const rb of payload.roleBindings) {
      expect(rb.preferenceList[0]?.model).toBe(DEFAULT_ROLE_MODEL[rb.role as keyof typeof DEFAULT_ROLE_MODEL])
      expect(rb.preferenceList[0]?.provider).toBe('anthropic')
    }
  })

  it('includes a trimmed credentialRef and a positive monthlyCapUsd, and a non-anthropic role model resolves its provider', () => {
    const state: ModelRoutingState = {
      ...initialModelRoutingState,
      draftProviders: {
        ...initialModelRoutingState.draftProviders,
        anthropic: { enabled: true, credentialRef: '  env:X  ', monthlyCapUsd: 10 },
      },
      draftRoleModel: { ...initialModelRoutingState.draftRoleModel, dream: 'local/qwen3:4b' },
    }
    const payload = buildSavePayload(state)
    const anthropic = payload.providers.find((p) => p.kind === 'anthropic')!
    expect(anthropic.credentialRef).toBe('env:X')
    expect(anthropic.monthlyCapUsd).toBe(10)
    const dream = payload.roleBindings.find((rb) => rb.role === 'dream')!
    expect(dream.preferenceList[0]).toEqual({ provider: 'ollama-local', model: 'local/qwen3:4b' })
  })

  it('a zero or negative monthlyCapUsd is dropped from the payload (matches the vanilla ">0" guard)', () => {
    const state: ModelRoutingState = {
      ...initialModelRoutingState,
      draftProviders: {
        ...initialModelRoutingState.draftProviders,
        anthropic: { enabled: true, credentialRef: '', monthlyCapUsd: 0 },
      },
    }
    const payload = buildSavePayload(state)
    expect(payload.providers.find((p) => p.kind === 'anthropic')!.monthlyCapUsd).toBeUndefined()
  })
})
