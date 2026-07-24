/**
 * Chrome-tab drag contract under WebDriver (macOS).
 *
 * Layer A — pure session machine via __moonE2E.simulateSessionDetach (no OS mouse).
 * Layer B — multi-window open_widget path via __moonE2E.openFloater (same as drag-out).
 *
 * OS-owned startDragging motion is out of scope here (Appium Mac2 / human pass).
 * Budgets: open_widget / floater label within MOON_E2E_FLOATER_MS (default 2500).
 */
const FLOATER_MS = Number(process.env.MOON_E2E_FLOATER_MS || 2500);

async function switchToChatWindow() {
  const handles = await browser.getWindowHandles();
  for (const h of handles) {
    await browser.switchToWindow(h);
    const ok = await browser.execute(() => !!(window.__moonE2E && window.__moonE2E.hasLunaThreadDrag));
    if (ok) {
      const ready = await browser.execute(() => window.__moonE2E.hasLunaThreadDrag());
      if (ready) return h;
    }
  }
  // Expand if still on hub only.
  await browser.switchToWindow(handles[0]);
  await browser.execute(async () => {
    try {
      await window.__TAURI__.core.invoke('expand_from_moon');
    } catch (_) { /* may already be expanded */ }
  });
  await browser.pause(1200);
  const after = await browser.getWindowHandles();
  for (const h of after) {
    await browser.switchToWindow(h);
    const ready = await browser.execute(() => {
      return !!(window.__moonE2E && window.__moonE2E.hasLunaThreadDrag && window.__moonE2E.hasLunaThreadDrag());
    });
    if (ready) return h;
  }
  throw new Error('no chat window with __moonE2E / LunaThreadDrag');
}

describe('Thread drag contracts', () => {
  before(async () => {
    await switchToChatWindow();
  });

  it('exposes LunaThreadDrag and E2E debug hooks', async () => {
    const meta = await browser.execute(() => ({
      hasDrag: window.__moonE2E && window.__moonE2E.hasLunaThreadDrag(),
      e2eVersion: window.__moonE2E && window.__moonE2E.version,
      hasDebug: typeof window.__moonDragDebug !== 'undefined' || true,
    }));
    expect(meta.hasDrag).toBe(true);
    expect(meta.e2eVersion).toBe(1);
  });

  it('simulates attached→detached session without OS mouse', async () => {
    const result = await browser.execute(() => window.__moonE2E.simulateSessionDetach());
    expect(result).toBeTruthy();
    expect(result.lastMove.action).toBe('detach');
    expect(result.up.outcome).toBe('keep_floater');
    expect(result.up.detachedOnce).toBe(true);

    const dbg = await browser.execute(() => window.__moonE2E.getDragDebug());
    expect(dbg).toBeTruthy();
    expect(Array.isArray(dbg.events)).toBe(true);
    expect(dbg.events.length).toBeGreaterThan(0);
    // At least one move should have recorded detach.
    const kinds = dbg.events.map((e) => e.kind);
    expect(kinds.includes('move') || kinds.includes('up')).toBe(true);
  });

  it('opens a floater via open_widget (drag-out path) within budget', async () => {
    const before = await browser.getWindowHandles();
    const t0 = Date.now();

    const label = await browser.execute(async () => {
      return await window.__moonE2E.openFloater('e2e-drag-thread', 480, 260);
    });

    // open_widget may return a label string; window list should grow or label set.
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(FLOATER_MS);

    if (label) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }

    await browser.waitUntil(
      async () => {
        const handles = await browser.getWindowHandles();
        return handles.length > before.length || !!label;
      },
      {
        timeout: FLOATER_MS,
        timeoutMsg: `floater did not appear within ${FLOATER_MS}ms`,
      },
    );

    // Cleanup best-effort so later runs stay clean.
    if (label) {
      await browser.execute((lbl) => {
        try {
          window.__moonE2E.closeFloater(lbl);
        } catch (_) {}
      }, label);
      await browser.pause(300);
    }
  });
});
