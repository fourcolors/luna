/**
 * SetupWizardPanel.tsx - the multi-step first-run installer/onboarding
 * modal, ported 1:1 from the deleted vanilla `SetupWizard` object + its
 * `<div class="wizard-panel">` markup in frontend/index.html. Same class
 * names/ids/structure as the vanilla markup so the page's untouched
 * <style> block paints an identical result; every DOM write the vanilla
 * version made (textContent, classList, hidden, .value) is now a render
 * decision driven by hubReducer.ts state instead.
 *
 * Step-entry side effects (prefillConnect + loadLocalToken on landing on
 * 'connect', renderRemoteCmd on landing on 'remote') that the vanilla
 * `goTo()` fired inline now live in a `current`-keyed useEffect below -
 * same trigger, same order, just react-effect-shaped instead of imperative.
 */
import { useEffect, useRef } from "react"
import type { HubController } from "./hubEngines"
import type { HubState, WizardStep } from "./hubReducer"
import { BEAD_FOR } from "./hubReducer"
import { connectBackStep, localStepCopy } from "./wizardHelpers"

export interface SetupWizardPanelProps {
  readonly controller: HubController
  readonly state: HubState
}

const BEAD_COUNT = 5

export function SetupWizardPanel({ controller, state }: SetupWizardPanelProps): React.JSX.Element {
  const wizard = state.wizard
  const localDirRef = useRef<HTMLInputElement>(null)

  // ── Step-entry side effects, mirroring the vanilla goTo() tail. ───────
  useEffect(() => {
    if (!wizard.active) return
    if (wizard.current === "connect") {
      controller.prefillConnect(wizard.chosenPath)
      const auto = wizard.autoTest
      controller.dispatchSetAutoTestFalse()
      controller
        .loadLocalToken(wizard.chosenPath, wizard.connectToken)
        .then(() => {
          if (auto) void controller.runConnectTest(wizard.connectUrl, wizard.connectToken)
        })
    } else if (wizard.current === "remote") {
      controller.renderRemoteCmd(wizard.remoteHost)
    }
    // Only re-run when the step itself changes (matches the vanilla
    // one-shot-per-goTo() semantics) - chosenPath/connectToken are read at
    // effect-run time, not tracked as re-trigger deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard.active, wizard.current])

  if (!wizard.active) {
    return (
      <div className="wizard-panel" id="setup-wizard" aria-hidden="true">
        <WizardCardShell controller={controller} wizard={wizard} />
      </div>
    )
  }

  return (
    <div className="wizard-panel active" id="setup-wizard" aria-hidden="false">
      <WizardCardShell controller={controller} wizard={wizard} localDirRef={localDirRef} />
    </div>
  )
}

function WizardCardShell({
  controller,
  wizard,
  localDirRef,
}: {
  controller: HubController
  wizard: HubState["wizard"]
  localDirRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const beadIdx = BEAD_FOR[wizard.current] ?? 0
  const update = wizard.env.serverRunning || wizard.env.repoExists
  const localCopy = localStepCopy(update)

  return (
    <div className="wizard-card" role="dialog" aria-modal="true" aria-label="Luna setup">
      <div className="wizard-wash" aria-hidden="true">
        <span className="wash-blot wash-a" />
        <span className="wash-blot wash-b" />
        <span className="wash-blot wash-c" />
      </div>
      <button
        type="button"
        className="settings-x wizard-x"
        aria-label="Close setup"
        onClick={() => controller.closeWizard(true)}
      >
        <svg viewBox="0 0 24 24" width={16} height={16} stroke="currentColor" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <line x1={18} y1={6} x2={6} y2={18} />
          <line x1={6} y1={6} x2={18} y2={18} />
        </svg>
      </button>
      <div className="wizard-beads" aria-hidden="true">
        {Array.from({ length: BEAD_COUNT }, (_, i) => (
          <span
            key={i}
            className={`wizard-bead${i < beadIdx ? " done" : ""}${i === beadIdx ? " active" : ""}`}
            data-bead={i}
          />
        ))}
      </div>
      <div className="wizard-body">
        <div className={`wizard-step${wizard.current === "welcome" ? " active" : ""}`} data-step="welcome">
          <div className="wizard-hero-blot" aria-hidden="true" />
          <h2>Welcome to Luna</h2>
          <p className="wizard-sub">
            Hi - I’m your moon. I just need to know where Luna, my other half, should live. Pick a spot on the
            next screen and I’ll take care of the rest.
          </p>
          <div className="wizard-actions">
            <button type="button" className="wizard-ghost-btn" onClick={() => controller.closeWizard(true)}>
              Skip for now
            </button>
            <button type="button" className="wizard-primary-btn" onClick={() => controller.goTo("path")}>
              Begin
            </button>
          </div>
        </div>

        <div className={`wizard-step${wizard.current === "path" ? " active" : ""}`} data-step="path">
          <h2>Where should Luna live?</h2>
          <p className="wizard-sub">You can change your mind any time - this wizard lives in Settings.</p>
          <div className="wizard-paths">
            <PathCard
              path="local"
              title="This Mac"
              desc={
                wizard.env.serverRunning
                  ? "Luna already lives here - connect, or update her"
                  : wizard.env.repoExists
                    ? "Luna is installed here - wake her up, or update her"
                    : "Everything stays private, right on this computer"
              }
              icon={
                <svg viewBox="0 0 24 24">
                  <rect x={3} y={4.5} width={18} height={12} rx={1.8} />
                  <line x1={8.5} y1={20} x2={15.5} y2={20} />
                  <line x1={12} y1={16.5} x2={12} y2={20} />
                </svg>
              }
              onClick={() => controller.choosePath("local")}
            />
            <PathCard
              path="remote"
              title="My own server"
              desc="For a home server or Linux box you own"
              icon={
                <svg viewBox="0 0 24 24">
                  <rect x={3} y={3.5} width={18} height={7} rx={1.6} />
                  <rect x={3} y={13.5} width={18} height={7} rx={1.6} />
                  <circle cx={7} cy={7} r={0.6} />
                  <circle cx={7} cy={17} r={0.6} />
                </svg>
              }
              onClick={() => controller.choosePath("remote")}
            />
            <PathCard
              path="connect"
              title="Already running"
              desc="Just connect to a Luna that exists somewhere"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                  <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                </svg>
              }
              onClick={() => controller.choosePath("connect")}
            />
          </div>
          {wizard.detectNote && <p className="wizard-sub wizard-detect-note">{wizard.detectNote}</p>}
          <div className="wizard-actions">
            <button type="button" className="wizard-ghost-btn" onClick={() => controller.goTo("welcome")}>
              Back
            </button>
          </div>
        </div>

        <div className={`wizard-step${wizard.current === "local" ? " active" : ""}`} data-step="local">
          <h2>{localCopy.title}</h2>
          <p className="wizard-sub">{localCopy.sub}</p>
          <details className="wizard-advanced">
            <summary>Advanced options</summary>
            <div className="wizard-field">
              <label htmlFor="wizard-local-dir">Install folder</label>
              <input
                type="text"
                id="wizard-local-dir"
                ref={localDirRef}
                className="premium-text-input"
                value={wizard.localDir}
                spellCheck={false}
                autoComplete="off"
                style={wizard.localDirInvalid ? { boxShadow: "inset 0 0 0 1px rgba(248, 113, 113, 0.6)" } : undefined}
                onChange={(e) => controller.dispatchLocalDir(e.target.value)}
              />
              <span className="field-hint">
                Luna’s code lives here; her data and settings live in ~/.luna. The defaults are fine for almost
                everyone.
              </span>
            </div>
          </details>
          <div className="wizard-actions">
            <button type="button" className="wizard-ghost-btn" onClick={() => controller.goTo("path")}>
              Back
            </button>
            {wizard.env.serverRunning && (
              <button
                type="button"
                className="wizard-ghost-btn"
                onClick={() => {
                  controller.dispatchSetAutoTestTrue()
                  controller.goTo("connect")
                }}
              >
                Just connect to it
              </button>
            )}
            <button
              type="button"
              className="wizard-primary-btn"
              onClick={() => void controller.runLocalInstall(wizard.localDir)}
            >
              {localCopy.startLabel}
            </button>
          </div>
        </div>

        <div className={`wizard-step${wizard.current === "progress" ? " active" : ""}`} data-step="progress">
          <h2>{wizard.progressTitle}</h2>
          <p className="wizard-sub">{wizard.progressSub}</p>
          <div className="wizard-tasks">
            {wizard.tasks.map((task, i) => (
              <div key={i} className={`wizard-task${task.state ? " " + task.state : ""}`}>
                <span className="wizard-task-bead" />
                <span className="wizard-task-label">{task.label}</span>
                <span className="wizard-task-note" title={task.note}>
                  {task.note}
                </span>
              </div>
            ))}
          </div>
          {wizard.progressLogVisible && <pre className="wizard-log">{wizard.progressLog}</pre>}
          <div className="wizard-actions">
            {wizard.progressBackVisible && (
              <button type="button" className="wizard-ghost-btn" onClick={() => controller.goTo("local")}>
                Back
              </button>
            )}
            {wizard.progressNextVisible && (
              <button
                type="button"
                className="wizard-primary-btn"
                onClick={() => {
                  controller.dispatchSetAutoTestTrue()
                  controller.goTo("connect")
                }}
              >
                Connect to it
              </button>
            )}
          </div>
        </div>

        <div className={`wizard-step${wizard.current === "remote" ? " active" : ""}`} data-step="remote">
          <h2>Install on your server</h2>
          <p className="wizard-sub">
            Tell me your server’s name and I’ll write the whole command for you. Paste it into the Terminal app, let
            it finish, then come back here.
          </p>
          <div className="wizard-field">
            <label htmlFor="wizard-remote-host">Your server</label>
            <input
              type="text"
              id="wizard-remote-host"
              className="premium-text-input"
              placeholder="like: me@my-server"
              spellCheck={false}
              autoComplete="off"
              value={wizard.remoteHost}
              onChange={(e) => {
                controller.dispatchRemoteHost(e.target.value)
                controller.renderRemoteCmd(e.target.value)
              }}
            />
          </div>
          <div className="wizard-cmd-block">
            <button
              type="button"
              className="wizard-copy-btn"
              onClick={() => void controller.copyRemoteCmd(wizard.remoteCmd)}
            >
              {wizard.copyLabel}
            </button>
            <pre>{wizard.remoteCmd}</pre>
          </div>
          <div className="wizard-field">
            <span className="field-hint">
              When it finishes, the last line it prints is your secret key - keep it handy, you’ll paste it on the
              next step. (For safety, Luna talks only over your private network, like Tailscale.)
            </span>
          </div>
          <div className="wizard-actions">
            <button type="button" className="wizard-ghost-btn" onClick={() => controller.goTo("path")}>
              Back
            </button>
            <button type="button" className="wizard-primary-btn" onClick={() => controller.goTo("connect")}>
              I ran it - continue
            </button>
          </div>
        </div>

        <div className={`wizard-step${wizard.current === "connect" ? " active" : ""}`} data-step="connect">
          <h2>Point your moon at Luna</h2>
          <p className="wizard-sub">Where does Luna live? I’ll listen for her hello before saving anything.</p>
          <div className="wizard-field">
            <label htmlFor="wizard-connect-url">Luna’s address</label>
            <input
              type="text"
              id="wizard-connect-url"
              className="premium-text-input"
              placeholder="ws://127.0.0.1:4753/ui"
              spellCheck={false}
              autoComplete="off"
              value={wizard.connectUrl}
              onChange={(e) => {
                controller.dispatchConnectUrl(e.target.value)
                controller.resetFinishGuard()
              }}
            />
          </div>
          <div className="wizard-field">
            <label htmlFor="wizard-connect-token">
              Secret key <span style={{ fontWeight: 400, color: "#64748b" }}>(optional)</span>
            </label>
            <input
              type="password"
              id="wizard-connect-token"
              className="premium-text-input"
              placeholder="Printed during install - leave empty if you don’t have one"
              autoComplete="off"
              value={wizard.connectToken}
              onChange={(e) => {
                controller.dispatchConnectToken(e.target.value)
                controller.resetFinishGuard()
              }}
            />
          </div>
          <div className={`wizard-connect-status${wizard.connectStatusKind ? " " + wizard.connectStatusKind : ""}`}>
            {wizard.connectStatusMsg}
          </div>
          <div className="wizard-actions">
            <button
              type="button"
              className="wizard-ghost-btn"
              onClick={() => controller.goTo(connectBackStep(wizard.chosenPath, wizard.ranInstall))}
            >
              Back
            </button>
            <button
              type="button"
              className="wizard-ghost-btn"
              onClick={() => void controller.runConnectTest(wizard.connectUrl, wizard.connectToken)}
            >
              Test connection
            </button>
            <button
              type="button"
              className="wizard-primary-btn"
              onClick={() => void controller.finishWizard(wizard.connectUrl, wizard.connectToken, wizard.forceSave)}
            >
              {wizard.forceSave ? "Save anyway" : "Save & finish"}
            </button>
          </div>
        </div>

        <div className={`wizard-step${wizard.current === "done" ? " active" : ""}`} data-step="done">
          <div className="wizard-hero-blot" aria-hidden="true" />
          <h2>{wizard.doneTitle}</h2>
          <p className="wizard-sub">{wizard.doneSummary}</p>
          {wizard.doneSetupVisible && (
            <p className="wizard-sub wizard-setup-note">
              Luna is awake, but she hasn’t met Claude yet. In the Terminal app run{" "}
              <code>claude setup-token</code>, copy the token it prints, and add this line to{" "}
              <code>~/.luna/.env</code> on Luna’s machine:
              <br />
              <code>CLAUDE_CODE_OAUTH_TOKEN=…the token…</code>
              <br />
              Then restart Luna (re-run this wizard and pick “This Mac” → Update) and she’s ready to chat.
            </p>
          )}
          <p className="wizard-sub" style={{ fontSize: "0.74rem" }}>
            Your moon keeps itself up to date on its own - and any time Luna herself needs a refresh, just re-run
            this wizard from Settings and pick “This Mac” again.
          </p>
          <div className="wizard-actions">
            <button
              type="button"
              className="wizard-primary-btn"
              onClick={() => controller.finishDoneStep()}
            >
              Start chatting
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PathCard({
  title,
  desc,
  icon,
  onClick,
}: {
  path: "local" | "remote" | "connect"
  title: string
  desc: string
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="wizard-path-card" onClick={onClick}>
      <span className="wizard-blot-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="wizard-path-title">{title}</span>
      <span className="wizard-path-desc">{desc}</span>
    </button>
  )
}
