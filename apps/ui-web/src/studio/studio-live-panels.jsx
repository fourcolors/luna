/**
 * Live Studio panel adapters.
 *
 * Each adapter owns the smallest reducer selector needed by one panel. The
 * board supplies stable commands and presentation state through `ctx`; live
 * server state stays local to the panel that renders it.
 */
import { EmptyState } from "./astryx-kit.tsx";
import React, { useMemo } from "react";
import { useLunaInbox } from "../data/useLunaInbox";
import { useStudioThreads } from "../data/useStudioThreads";
import { shallowEqual, useUiSelector } from "../data/useUiStore";
import { ArtifactsPanel } from "./artifacts-panel.jsx";
import ConnectorsPanel from "./connectors-panel.jsx";
import { FinalInbox } from "./final-inbox.jsx";
import { ThreadChat } from "./final-chat.jsx";
import { ThreadsApp } from "./final-threads.jsx";
import { ObsPanel } from "./obs-panel.jsx";
import { SettingsPanel } from "./settings-panel.jsx";
import { SkillsPanel } from "./skills-panel.jsx";
import { GeneratedWidget } from "./studio-widget.jsx";
import { VaultPanel } from "./vault-panel.jsx";
import { WidgetFrame } from "./WidgetFrame.jsx";
import { WorkflowGallery } from "./workflows-panel.jsx";

const EMPTY_ARTIFACTS = [];
const selectPinnedArtifacts = (state) => state.pinnedArtifacts;
const selectSettingsState = (state) => ({
  availableModels: state.availableModels,
  accounts: state.accounts,
  selectedAccountId: state.selectedAccountId,
});
const selectConnectorState = (state) => ({
  capabilities: state.capabilities,
  connectorCatalog: state.connectorCatalog,
  connectorInstances: state.connectorInstances,
  connectorError: state.connectorError,
});
const selectObsState = (state) => ({
  events: state.events,
  seenKinds: state.seenKinds,
  advertisedKinds: state.advertisedKinds,
  lastDrop: state.lastDrop,
  droppedTotal: state.droppedTotal,
  lastPingAt: state.lastPingAt,
});
const selectArtifactState = (state) => ({
  activeArtifacts: state.selectedThreadId
    ? (state.threads.get(state.selectedThreadId)?.artifacts ?? EMPTY_ARTIFACTS)
    : EMPTY_ARTIFACTS,
  pinnedArtifacts: state.pinnedArtifacts,
  capable: state.capabilities.artifacts === true,
});
const selectSkillsState = (state) => ({
  skills: state.skills,
  skillError: state.skillError,
});
const selectVaultState = (state) => ({
  vaultItems: state.vaultItems,
  vaultSync: state.vaultSync,
  vaultStorage: state.vaultStorage,
});
const selectWorkflowState = (state) => ({
  workflows: state.workflows,
  workflowRuns: state.workflowRuns,
});

function usePanelSlice(store, selector) {
  return useUiSelector(store, selector, shallowEqual);
}

function Chat({ ctx }) {
  const { threads, activeThread } = useStudioThreads(ctx.store);
  return <ThreadChat threads={threads} activeId={activeThread} onSwitch={ctx.openThread} onNew={ctx.newThread} onAppend={ctx.appendMsg} onThreadNote={ctx.threadNote} onSpawn={ctx.spawn} onVoice={ctx.openVoice} onFocus={ctx.focusInbox} brain={ctx.chatBrain} setBrain={ctx.setChatBrain} suggestedActions={ctx.suggestedActions} onAcceptAction={ctx.acceptAction} onDismissAction={ctx.dismissAction} />;
}

function Threads({ ctx }) {
  const { threads, activeThread } = useStudioThreads(ctx.store);
  return <ThreadsApp threads={threads} activeId={activeThread} onOpen={ctx.openThread} />;
}

function Inbox({ ctx }) {
  const inbox = useLunaInbox({
    store: ctx.store,
    send: ctx.send,
    onServerFrame: ctx.onServerFrame,
    connected: ctx.connected,
    model: ctx.model,
  });
  return <FinalInbox items={inbox.items} connected={ctx.connected} projectionAvailable={inbox.available} loading={inbox.loading} onDelegate={ctx.delegate} onToast={ctx.toast} onOpenThread={ctx.openThread} />;
}

function Widget({ ctx, panel }) {
  const pinnedArtifacts = useUiSelector(ctx.store, selectPinnedArtifacts);
  const artifacts = useMemo(
    () => new Map(pinnedArtifacts.map((artifact) => [artifact.id, artifact])),
    [pinnedArtifacts],
  );
  if (!panel.artifactId) return <GeneratedWidget spec={panel.spec} fresh={panel.fresh} />;
  const artifact = artifacts.get(panel.artifactId);
  if (!artifact) {
    return (
      <div className="gw-wrap widget-frame-host">
        <EmptyState title="This widget isn't pinned anymore." isCompact />
      </div>
    );
  }
  return <WidgetFrame artifact={artifact} mcp={ctx.mcp} fresh={panel.fresh} />;
}

function Settings({ ctx }) {
  const state = usePanelSlice(ctx.store, selectSettingsState);
  return <SettingsPanel ctx={{ ...ctx, state }} />;
}

function Connectors({ ctx }) {
  const state = usePanelSlice(ctx.store, selectConnectorState);
  return <ConnectorsPanel enabled={state.capabilities.connectors === true} catalog={state.connectorCatalog} instances={state.connectorInstances} lastError={state.connectorError} disabled={!ctx.connected} onConnectApiKey={(definitionId, secretRef, capabilityIds, label) => ctx.send({ type: "connector-connect", requestId: "conn_" + Date.now(), definitionId, label: label ?? definitionId, secretRef, capabilityIds })} onDisconnect={(instanceId) => ctx.send({ type: "connector-disconnect", instanceId })} onSetClient={(definitionId, clientId, clientSecret) => ctx.send({ type: "connector-set-client", requestId: "setclient_" + Date.now(), definitionId, clientId, ...(clientSecret ? { clientSecret } : {}) })} />;
}

function Events({ ctx }) {
  const state = usePanelSlice(ctx.store, selectObsState);
  return <ObsPanel events={state.events} seenKinds={state.seenKinds} advertisedKinds={state.advertisedKinds} lastDrop={state.lastDrop} droppedTotal={state.droppedTotal} lastPingAt={state.lastPingAt} />;
}

function Artifacts({ ctx }) {
  const state = usePanelSlice(ctx.store, selectArtifactState);
  return <ArtifactsPanel artifacts={state.activeArtifacts} pinned={state.pinnedArtifacts} artifactsCapable={state.capable} focusSignal={ctx.focusArtifact} mcp={ctx.mcp} onPin={ctx.pinArtifact} onUnpin={ctx.unpinArtifact} />;
}

function Skills({ ctx }) {
  const state = usePanelSlice(ctx.store, selectSkillsState);
  return <SkillsPanel skills={state.skills} lastError={state.skillError} disabled={!ctx.connected} onToggle={(id, enabled) => ctx.send({ type: "skill-toggle", id, enabled })} />;
}

function Vault({ ctx }) {
  const state = usePanelSlice(ctx.store, selectVaultState);
  return <VaultPanel items={state.vaultItems} sync={state.vaultSync} storage={state.vaultStorage} disabled={!ctx.connected} onServerFrame={ctx.onServerFrame} onPut={(params) => ctx.send({ type: "vault-put", ...params })} onDelete={(params) => ctx.send({ type: "vault-delete", ...params })} onSyncConfig={(params) => ctx.send({ type: "vault-sync-config", ...params })} onImport={(params) => ctx.send({ type: "vault-import", ...params })} />;
}

function Workflows({ ctx }) {
  const state = usePanelSlice(ctx.store, selectWorkflowState);
  return <WorkflowGallery workflows={state.workflows} runs={state.workflowRuns} onSelectRuns={(jobId) => ctx.send({ type: "workflow-runs-request", jobId })} onRefresh={() => ctx.send({ type: "workflow-refresh" })} />;
}

export const STUDIO_LIVE_PANELS = Object.freeze({
  chat: Chat,
  threads: Threads,
  inbox: Inbox,
  widget: Widget,
  settings: Settings,
  connectors: Connectors,
  obs: Events,
  artifacts: Artifacts,
  skills: Skills,
  vault: Vault,
  workflows: Workflows,
});
