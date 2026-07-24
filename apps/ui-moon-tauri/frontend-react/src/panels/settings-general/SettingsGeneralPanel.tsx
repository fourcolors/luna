/**
 * SettingsGeneralPanel.tsx - React/Astryx port of
 * apps/ui-moon-tauri/frontend/panels/settings-general.js (the "General"
 * settings panel: registered there as `LunaPanelTypes['settings.general']`).
 *
 * Behavior ported 1:1 from the vanilla module:
 *   - Always on Top / Close on Click Away are two independent booleans
 *     persisted to localStorage (`luna_always_on_top` / `luna_close_on_blur`),
 *     both defaulting to OFF when unset.
 *   - Global Shortcut is a read-only recorder: clicking Record arms a
 *     `window` keydown listener; the next non-modifier keydown becomes the
 *     shortcut string (modifier prefix order Ctrl-Alt-Shift-Meta, Space
 *     spelled out, everything else uppercased) and is persisted to
 *     `luna_global_shortcut`; Cancel (the same button, relabeled while
 *     recording) restores the last-saved value without writing anything.
 *   - "Start a fresh thread" is a fire-and-forget `ctx.invoke('hub_event',
 *     { name: 'fresh-thread' })` - the hub owns the actual side effect
 *     (opening chat + starting a new conversation); this panel only signals
 *     intent and swallows invoke errors, exactly like every other panel
 *     module's fire-and-forget hub_event calls.
 *
 * STATE SOURCE (why this doesn't touch src/state/store.ts): all three
 * settings here are local, localStorage-backed panel preferences - they have
 * no representation in the shared @luna/ui-shared reducer (see UIState in
 * packages/ui-shared/src/reducer.ts), and the hub applies their side effects
 * itself via the cross-window `storage` event it already listens to. There is
 * no server/transport frame this panel consumes, so there is nothing to bind
 * through useMoonSelector - state lives in plain React state (seeded once
 * from localStorage on mount) and every mutation goes through React state
 * setters, never direct DOM writes. When a future Moon settings panel needs
 * transport-derived state, that one binds through the store; this one
 * legitimately doesn't.
 */
import { useEffect, useState, type ComponentProps, type ComponentType } from "react"
import { Button, HStack, Switch, Text, TextInput, VStack } from "../../astryx-kit"
import type { PanelCtx } from "../panel-ctx"

// TextInputProps omits `readOnly` from its declared type (BaseProps only
// widens React.HTMLAttributes, which lacks it - InputHTMLAttributes is where
// `readOnly` actually lives), even though the implementation spreads
// unrecognized props straight onto the underlying <input> at runtime (see
// TextInput.js's `...rest` on the <input> element). The shortcut recorder
// below is genuinely a read-only field - it is only ever written by the
// keydown FSM, never by direct typing - so this narrow, well-scoped cast
// widens just that one prop rather than reaching for `any` at every call
// site or fighting Astryx's declared surface.
const ReadOnlyTextInput = TextInput as ComponentType<ComponentProps<typeof TextInput> & { readOnly?: boolean }>

/** Consumed by settings-general-mount.tsx for #bar-title / document.title -
 * the single source of truth for this panel's display name, mirroring
 * SettingsLauncherPanel.tsx's SETTINGS_LAUNCHER_TITLE convention. */
export const PANEL_TITLE = "General"

const DEFAULT_SHORTCUT = "⌥Space" // "⌥Space"

const STORAGE_KEYS = {
  alwaysOnTop: "luna_always_on_top",
  closeOnBlur: "luna_close_on_blur",
  globalShortcut: "luna_global_shortcut",
} as const

function readBoolean(key: string): boolean {
  const saved = localStorage.getItem(key)
  return saved !== null ? saved === "true" : false
}

function readShortcut(): string {
  const saved = localStorage.getItem(STORAGE_KEYS.globalShortcut)
  return saved !== null ? saved : DEFAULT_SHORTCUT
}

/** Mirrors settings-general.js's handleKeyDown byte-for-byte: same modifier
 * order, same key naming, Escape is NOT special (records as "ESCAPE"),
 * modifier-only keydowns are ignored (caller keeps waiting). */
function comboFromKeyDown(e: KeyboardEvent): string | null {
  const key = e.key
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null // modifier-only: keep waiting
  }
  let combo = ""
  if (e.ctrlKey) combo += "⌃" // ⌃
  if (e.altKey) combo += "⌥" // ⌥
  if (e.shiftKey) combo += "⇧" // ⇧
  if (e.metaKey) combo += "⌘" // ⌘
  const keyName = key === " " ? "Space" : key.toUpperCase()
  return combo + keyName
}

export function SettingsGeneralPanel({ ctx }: { ctx: PanelCtx }) {
  const [alwaysOnTop, setAlwaysOnTop] = useState(() => readBoolean(STORAGE_KEYS.alwaysOnTop))
  const [closeOnBlur, setCloseOnBlur] = useState(() => readBoolean(STORAGE_KEYS.closeOnBlur))
  const [shortcut, setShortcut] = useState(readShortcut)
  const [isRecording, setIsRecording] = useState(false)

  // Recording FSM lives as a `window` keydown listener while armed, exactly
  // like the vanilla module - re-bound whenever isRecording flips so the
  // closure always sees the current recording state without a ref.
  useEffect(() => {
    if (!isRecording) return
    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      const combo = comboFromKeyDown(e)
      if (combo === null) return // modifier-only: keep waiting
      localStorage.setItem(STORAGE_KEYS.globalShortcut, combo)
      setShortcut(combo)
      setIsRecording(false)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isRecording])

  function handleAlwaysOnTopChange(next: boolean) {
    localStorage.setItem(STORAGE_KEYS.alwaysOnTop, String(next))
    setAlwaysOnTop(next)
  }

  function handleCloseOnBlurChange(next: boolean) {
    localStorage.setItem(STORAGE_KEYS.closeOnBlur, String(next))
    setCloseOnBlur(next)
  }

  function handleRecordClick() {
    if (isRecording) {
      setIsRecording(false)
      setShortcut(readShortcut()) // cancel: restore last-saved value, write nothing
    } else {
      setIsRecording(true)
    }
  }

  function handleFreshThread() {
    ctx.invoke("hub_event", { name: "fresh-thread" }).catch(() => {})
  }

  return (
    <div className="moon-astryx-root settings-general-panel" data-testid="settings-general-panel">
      <VStack gap={4}>
        <Switch
          label="Always on Top"
          description="Keep Luna and her panels floating above other apps"
          value={alwaysOnTop}
          onChange={handleAlwaysOnTopChange}
          labelPosition="start"
          labelSpacing="spread"
          data-testid="always-on-top-row"
        />
        <Switch
          label="Close on Click Away"
          description="Collapse chat automatically when unfocused"
          value={closeOnBlur}
          onChange={handleCloseOnBlurChange}
          labelPosition="start"
          labelSpacing="spread"
          data-testid="close-on-blur-row"
        />

        <HStack justify="between" align="center" gap={3}>
          <VStack gap={0}>
            <Text type="label">Global Shortcut</Text>
            <Text type="supporting">Press shortcut to toggle Luna window</Text>
          </VStack>
          <HStack gap={2} align="center">
            <ReadOnlyTextInput
              label="Global shortcut"
              isLabelHidden
              value={isRecording ? "Press keys..." : shortcut}
              readOnly
              width={140}
              data-testid="shortcut-input"
              data-recording={isRecording ? "true" : "false"}
            />
            <Button
              label={isRecording ? "Cancel" : "Record"}
              variant="secondary"
              size="sm"
              onClick={handleRecordClick}
              id="record-shortcut-btn"
              data-testid="record-shortcut-btn"
            />
          </HStack>
        </HStack>

        <HStack justify="between" align="center" gap={3}>
          <VStack gap={0}>
            <Text type="label">Start a fresh thread</Text>
            <Text type="supporting">
              Luna keeps one ongoing thread. This abandons the current conversation and begins a
              new one - your history stays on the server.
            </Text>
          </VStack>
          <Button
            label="Start fresh"
            variant="secondary"
            size="sm"
            onClick={handleFreshThread}
            id="fresh-thread-btn"
            data-testid="fresh-thread-btn"
          />
        </HStack>
      </VStack>
    </div>
  )
}
