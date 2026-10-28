// @vitest-environment jsdom
/**
 * setup-wizard-autotest.test.tsx - the connect-step auto-test must test the
 * prefilled URL, not the stale closure value.
 *
 * On a fresh first run the wizard lands on the connect step with an empty
 * connectUrl/connectToken in state. The step-entry effect prefills the URL
 * (ws://127.0.0.1:4753/ui) and loads the local token into the store, but it
 * used to call runConnectTest with the values captured in its render closure
 * - empty URL, empty token. runConnectTest("") short-circuits to "Enter a
 * server address first.", so the auto-test always failed spuriously on
 * exactly the path where prefill matters most, while the address field
 * visibly held the correct prefilled URL. Manual "Test connection" worked
 * because its button handler reads current state, which is why this went
 * unnoticed.
 *
 * BEFORE THE FIX, `auto-test uses the prefilled URL on a fresh first run`
 * FAILS: runConnectTest is called with ("", "") and the status reads
 * "Enter a server address first." - even though the field already shows the
 * prefilled URL.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReducer, useRef } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { SetupWizardPanel } from '../frontend-react/src/hub/SetupWizardPanel'
import { HubController } from '../frontend-react/src/hub/hubEngines'
import { reduceHub, initialHubState, type HubAction, type HubState } from '../frontend-react/src/hub/hubReducer'

let container: HTMLDivElement | null = null
let root: Root | null = null
let controller: HubController | null = null
let getState: (() => HubState) | null = null
let dispatchRef: ((a: HubAction) => void) | null = null

function WizardHarness() {
  const [state, dispatch] = useReducer(reduceHub, initialHubState())
  const controllerRef = useRef<HubController | null>(null)
  if (controllerRef.current === null) controllerRef.current = new HubController(dispatch)
  controller = controllerRef.current
  getState = () => state
  dispatchRef = dispatch
  return <SetupWizardPanel controller={controllerRef.current} state={state} />
}

function renderWizard() {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<WizardHarness />)
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const btns = Array.from(document.querySelectorAll('button'))
  const found = btns.find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button with text ${JSON.stringify(text)}`)
  return found as HTMLButtonElement
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  controller = null
  getState = null
  dispatchRef = null
  vi.restoreAllMocks()
})

describe('setup wizard connect-step auto-test', () => {
  it('auto-test uses the prefilled URL on a fresh first run', async () => {
    renderWizard()
    const runTestSpy = vi
      .spyOn(controller!, 'runConnectTest')
      .mockImplementation(async () => true)

    // Fresh first run: wizard opens, a Luna server is already running on
    // this machine, the user picks the local path.
    act(() => {
      controller!.openWizard()
    })
    act(() => {
      dispatchRef!({ type: 'wizard-detected', env: { serverRunning: true, repoExists: false } })
    })
    act(() => {
      controller!.choosePath('local')
    })

    // "Just connect to it": arm the auto-test, then land on connect.
    act(() => {
      buttonByText('Just connect to it').click()
    })
    await flush()
    await flush()

    // The field visibly holds the prefilled URL...
    const urlInput = document.getElementById('wizard-connect-url') as HTMLInputElement
    expect(urlInput.value).toBe('ws://127.0.0.1:4753/ui')
    // ...and the auto-test must have tested THAT url, not the stale empty one.
    expect(runTestSpy).toHaveBeenCalledTimes(1)
    expect(runTestSpy).toHaveBeenCalledWith('ws://127.0.0.1:4753/ui', '')
  })

  it('auto-test still uses an already-entered URL untouched', async () => {
    renderWizard()
    const runTestSpy = vi
      .spyOn(controller!, 'runConnectTest')
      .mockImplementation(async () => true)

    act(() => {
      controller!.openWizard()
    })
    act(() => {
      dispatchRef!({ type: 'wizard-detected', env: { serverRunning: true, repoExists: false } })
    })
    act(() => {
      controller!.choosePath('local')
    })
    // The operator typed a URL before taking the connect path: prefill is a
    // no-op then, and the auto-test must use the typed value.
    act(() => {
      controller!.dispatchConnectUrl('ws://192.168.1.9:4753/ui')
    })
    act(() => {
      buttonByText('Just connect to it').click()
    })
    await flush()
    await flush()

    expect(runTestSpy).toHaveBeenCalledTimes(1)
    expect(runTestSpy).toHaveBeenCalledWith('ws://192.168.1.9:4753/ui', '')
  })
})
