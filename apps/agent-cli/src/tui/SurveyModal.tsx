/**
 * SurveyModal.tsx — Phase 3 D3 alignment check-in modal.
 *
 * Rendered by App.tsx when store.survey() is non-null. Shows:
 *   - One task_quality Likert (1–5), mapped to score = (n-1)/4 (D-LOCK-4).
 *   - Up to 3 belief_validation items: confirm / correct / reject.
 *
 * Key handling:
 *   - Number keys 1–5 set the Likert answer (when focused on the task item).
 *   - c / o / r set confirm / corrected / rejected for the focused belief item.
 *   - Enter submits (only when task_quality is answered — the mandatory item).
 *   - Esc dismisses (client-side no-op per Execution Correction #1).
 *   - Arrow up/down moves focus between belief items.
 *
 * The DATA contract (buildSurveyVerdicts) is extracted as a pure function in
 * headless.ts and is the unit under test. The visual layout here is functional
 * but may be refined for UX (DONE_WITH_CONCERNS — see report).
 *
 * NOTE: OpenTUI/Solid JSX typechecks against the known agent-cli JSX baseline
 * (pre-existing JSX.IntrinsicElements gap). The data contract is tsc-clean in
 * the non-JSX layer (headless.ts, store.ts).
 */
import { createSignal, For, Show } from "solid-js"
import { onMount } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { PendingSurvey, SurveyVerdict, SurveyItem } from "@luna/core"
import { buildSurveyVerdicts, type SurveyAnswers } from "../chat/headless.js"

export type SurveyModalProps = {
  survey: PendingSurvey
  onSubmit: (surveyId: string, issuedAt: number, verdicts: ReadonlyArray<SurveyVerdict>) => void
  onDismiss: () => void
}

type BeliefAnswer = "confirmed" | "corrected" | "rejected"

export const SurveyModal = (props: SurveyModalProps) => {
  // task_quality Likert answer: 1–5 → (n-1)/4 (D-LOCK-4).
  const [likert, setLikert] = createSignal<number | null>(null)
  // Per-belief answers keyed by beliefId.
  const [beliefAnswers, setBeliefAnswers] = createSignal<Record<string, BeliefAnswer>>({})
  // Index into beliefItems() for keyboard focus (arrow nav).
  const [focusedBelief, setFocusedBelief] = createSignal<number>(0)

  const taskItem = (): SurveyItem | undefined =>
    props.survey.items.find((i) => i.kind === "task_quality")
  const beliefItems = (): ReadonlyArray<SurveyItem> =>
    props.survey.items.filter((i) => i.kind === "belief_validation")

  const submit = (): void => {
    if (likert() === null) return // mandatory task_quality must be answered

    const answers: SurveyAnswers = {
      likert: likert(),
      beliefAnswers: beliefAnswers(),
    }
    const verdicts = buildSurveyVerdicts(props.survey.items, answers, props.survey.issuedAt)
    // surveyId is carried on the PendingSurvey (populated from SurveyRequestFrame.surveyId).
    props.onSubmit(
      (props.survey as unknown as { surveyId?: string }).surveyId ?? `survey-${props.survey.issuedAt}`,
      props.survey.issuedAt,
      verdicts,
    )
  }

  const dismiss = (): void => {
    // Execution Correction #1: dismiss = no-op. The modal just closes.
    props.onDismiss()
  }

  const setBeliefAnswer = (beliefId: string, ans: BeliefAnswer): void => {
    setBeliefAnswers((prev) => ({ ...prev, [beliefId]: ans }))
  }

  // Keyboard handler: number keys + c/o/r + Enter + Esc.
  // Wired via renderer.keyInput (mirrors mount.ts:274-276 pattern).
  onMount(() => {
    const renderer = useRenderer()
    if (renderer?.keyInput === undefined) return

    type KeyEvent = { name?: string; sequence?: string; ctrl?: boolean }
    const handleKey = (evt: KeyEvent): void => {
      // 1–5: set Likert
      const n = Number(evt.name)
      if (!isNaN(n) && n >= 1 && n <= 5) {
        setLikert(n)
        return
      }
      // c / o / r: answer focused belief item
      const beliefs = beliefItems()
      const idx = focusedBelief()
      const focused = beliefs[idx]
      if (focused?.beliefId !== undefined) {
        if (evt.name === "c") { setBeliefAnswer(focused.beliefId, "confirmed"); return }
        if (evt.name === "o") { setBeliefAnswer(focused.beliefId, "corrected"); return }
        if (evt.name === "r") { setBeliefAnswer(focused.beliefId, "rejected"); return }
      }
      // Arrow up/down: navigate belief items
      if (evt.name === "up" && idx > 0) { setFocusedBelief(idx - 1); return }
      if (evt.name === "down" && idx < beliefs.length - 1) { setFocusedBelief(idx + 1); return }
      // Enter: submit
      if (evt.name === "return" || evt.name === "kpenter") { submit(); return }
      // Esc: dismiss (no-op)
      if (evt.sequence === "\x1B" || evt.name === "escape") { dismiss(); return }
    }

    renderer.keyInput.on("keypress", handleKey)
    // Cleanup on unmount is not needed (the modal is destroyed when survey=null).
  })

  return (
    <box style={{ borderStyle: "double", flexDirection: "column", padding: 1, position: "absolute", top: 0, left: 0, right: 0 }}>
      <text style={{ fg: "#00FF87", bold: true }}>{"=== Luna check-in ==="}</text>
      <text style={{ fg: "#888888" }}>{"Enter to submit  |  Esc to dismiss (resurfaces next session)"}</text>

      {/* task_quality section */}
      <Show when={taskItem()}>
        {(tq) => (
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text style={{ fg: "#FFD700" }}>{tq().prompt}</text>
            <text>{`  [1] poor  [2]  [3] ok  [4]  [5] great  →  selected: ${likert() !== null ? String(likert()) : "—"}`}</text>
          </box>
        )}
      </Show>

      {/* belief_validation items */}
      <Show when={beliefItems().length > 0}>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <text style={{ fg: "#888888" }}>{"Beliefs (↑↓ to focus, c=confirm  o=correct  r=reject):"}</text>
          <For each={beliefItems()}>
            {(b, i) => {
              const answer = (): BeliefAnswer | undefined =>
                b.beliefId !== undefined ? beliefAnswers()[b.beliefId] : undefined
              const isFocused = (): boolean => i() === focusedBelief()
              return (
                <box style={{ flexDirection: "column", marginTop: 1 }}>
                  <text style={{ fg: isFocused() ? "#00FF87" : "#FFFFFF" }}>
                    {`${isFocused() ? "▶ " : "  "}${b.prompt}`}
                  </text>
                  <text style={{ fg: "#888888" }}>
                    {`    [c]onfirm  [o]correct  [r]eject  →  ${answer() ?? "—"}`}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <text style={{ marginTop: 1, fg: likert() === null ? "#FF4444" : "#888888" }}>
        {likert() === null ? "! Rate task quality (1-5) before submitting" : "Ready — press Enter to submit"}
      </text>
    </box>
  )
}
