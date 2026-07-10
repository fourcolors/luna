// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { FinalInbox } from "./final-inbox.jsx";
import { SettingsPanel } from "./settings-panel.jsx";
import { StudioApp } from "./final-app.jsx";

const { mockLuna } = vi.hoisted(() => {
  const noop = () => undefined;
  const state = {
    capabilities: {},
    threadList: [],
    threads: new Map(),
    selectedThreadId: null,
    events: [],
    seenKinds: [],
    advertisedKinds: [],
    droppedTotal: 0,
    lastDrop: null,
    lastPingAt: null,
    connectorCatalog: [],
    connectorInstances: [],
    connectorError: null,
    skills: [],
    skillError: null,
    vaultItems: [],
    vaultSync: null,
    vaultStorage: null,
    workflows: [],
    workflowRuns: new Map(),
    pinnedArtifacts: [],
    suggestedActions: new Map(),
    accounts: [],
    selectedAccountId: null,
    availableModels: null,
  };
  return {
    mockLuna: {
      store: {
        getState: () => state,
        dispatch: noop,
        subscribe: () => noop,
      },
      status: { kind: "idle" },
      connected: false,
      threads: [],
      activeThread: null,
      pinnedArtifacts: [],
      suggestedActions: [],
      state,
      config: {
        url: "ws://127.0.0.1:4753/ui",
        token: "1234567890abcdef",
        model: "claude-sonnet-5",
        enterToSend: false,
        selectedAccountId: null,
      },
      obsEvents: [],
      focusArtifact: null,
      widgetOpen: null,
      mcp: undefined,
      openThread: noop,
      newThread: noop,
      appendMsg: noop,
      threadNote: noop,
      respondToAction: noop,
      send: noop,
      onServerFrame: () => noop,
      updateConfig: noop,
      reconnect: noop,
      disconnect: noop,
      restartServer: async () => undefined,
      selectAccount: noop,
      model: "claude-sonnet-5",
    },
  };
});

vi.mock("../data/useLunaData", () => ({ useLunaData: () => mockLuna }));
vi.mock("../data/useLunaInbox", () => ({
  useLunaInbox: () => ({ items: null, available: false, loading: false, refresh: () => undefined }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted = [];

function mount(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  vi.useRealTimers();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function settingsCtx(overrides = {}) {
  return {
    config: {
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
      model: "claude-sonnet-5",
      enterToSend: false,
      selectedAccountId: null,
    },
    updateConfig: vi.fn(),
    connected: false,
    status: { kind: "idle" },
    selectAccount: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    restartServer: vi.fn(),
    state: { availableModels: null, accounts: [], selectedAccountId: null },
    tweaks: { palette: "tide", theme: "light", chrome: "wash", grain: false, motion: "lively", ambient: true, defaultBrain: "luna", snap: 28, guides: true },
    setTweak: vi.fn(),
    ...overrides,
  };
}

describe("Studio regression coverage", () => {
  it("actually hides closed panels and restores them from the shelf", () => {
    const container = mount(<StudioApp />);
    const panel = container.querySelector('[data-screen-label="settings"]');
    expect(panel).not.toBeNull();

    act(() => panel.querySelector(".panel-close").click());

    expect(panel.style.display).toBe("none");
    const restore = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent.trim() === "settings",
    );
    expect(restore).not.toBeUndefined();

    act(() => restore.click());
    expect(panel.style.display).not.toBe("none");
  });

  it("does not present seed/demo inbox messages as real data", () => {
    const container = mount(
      <FinalInbox items={null} connected={false} projectionAvailable={false} />,
    );

    expect(container.textContent).toContain("0 in your inbox");
    expect(container.textContent).toContain("connect Luna to load your inbox");
    expect(container.textContent).not.toContain("Priya");
    expect(container.textContent).not.toContain("Water the studio plants");
  });

  it("lets the user choose Custom and enter a model id", () => {
    const ctx = settingsCtx();
    const container = mount(<SettingsPanel ctx={ctx} />);
    const select = container.querySelector("select");
    expect(select).not.toBeNull();

    act(() => {
      select.value = "__custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(ctx.updateConfig).toHaveBeenCalledWith({ model: "" });
  });

  it("shows an explicit restart refusal instead of disconnecting anyway", async () => {
    vi.useFakeTimers();
    const refusal = Object.assign(new Error("restart unavailable: no supervisor"), {
      name: "RestartRefusedError",
    });
    const ctx = settingsCtx({ restartServer: vi.fn().mockRejectedValue(refusal) });
    const container = mount(<SettingsPanel ctx={ctx} />);
    const restart = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Restart Server"),
    );
    expect(restart).not.toBeUndefined();

    await act(async () => restart.click());

    expect(container.textContent).toContain("restart unavailable: no supervisor");

    // A refused restart must never schedule the delayed reconnect — advance
    // past the 3s reconnect window to prove no timer was left behind.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(ctx.disconnect).not.toHaveBeenCalled();
    expect(ctx.connect).not.toHaveBeenCalled();
  });

  it("schedules the delayed reconnect after an accepted restart", async () => {
    vi.useFakeTimers();
    const ctx = settingsCtx({ restartServer: vi.fn().mockResolvedValue(undefined) });
    const container = mount(<SettingsPanel ctx={ctx} />);
    const restart = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Restart Server"),
    );

    await act(async () => restart.click());

    expect(ctx.disconnect).toHaveBeenCalled();
    expect(ctx.connect).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(ctx.connect).toHaveBeenCalled();
  });
});
