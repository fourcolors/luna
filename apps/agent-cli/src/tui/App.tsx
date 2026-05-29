import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { TuiStore } from "./store.js"
import type { SlashCommand } from "./slash.js"
import type { SurveyVerdict } from "@luna/core"
import { SLASH_COMMANDS } from "../chat/slash-registry.js"
import { Transcript } from "./Transcript.js"
import { SlashMenu } from "./SlashMenu.js"
import { Input } from "./Input.js"
import { StatusBar } from "./StatusBar.js"
import { SurveyModal } from "./SurveyModal.js"

export type AppProps = {
  store: TuiStore
  onSubmit: (text: string) => void
  /** Phase 3 D3: called when the operator submits survey answers. */
  onSurveySubmit: (surveyId: string, issuedAt: number, verdicts: ReadonlyArray<SurveyVerdict>) => void
  /** Phase 3 D3: called when the operator dismisses the survey (no-op on the wire). */
  onSurveyDismiss: () => void
}

// Map the canonical slash registry (names carry a leading "/") to the
// SlashMenu's command shape (names without "/", help text).
const SLASH_MENU_COMMANDS: ReadonlyArray<SlashCommand> = SLASH_COMMANDS.map((c) => ({
  name: c.name.replace(/^\//, ""),
  help: c.argHint !== undefined ? `${c.argHint} — ${c.description}` : c.description,
}))

export const App = (props: AppProps) => {
  const dims = useTerminalDimensions()

  return (
    <box style={{ flexDirection: "column", width: dims().width, height: dims().height }}>
      <Transcript store={props.store} />
      <SlashMenu store={props.store} commands={SLASH_MENU_COMMANDS} />
      {/* Phase 3 D3: unmount chat Input while survey modal owns exclusive key focus */}
      <Show when={props.store.chatInputActive()}>
        <Input store={props.store} onSubmit={props.onSubmit} commands={SLASH_MENU_COMMANDS} />
      </Show>
      <StatusBar store={props.store} />
      {/* Phase 3 D3: overlay the survey modal when a check-in is pending */}
      <Show when={props.store.survey()}>
        {(s) => (
          <SurveyModal
            survey={s()}
            onSubmit={props.onSurveySubmit}
            onDismiss={props.onSurveyDismiss}
          />
        )}
      </Show>
    </box>
  )
}
