/**
 * Moon E2E smoke — app launches under embedded WebDriver.
 * Does not require the chat server.
 *
 * Note: ~/.luna/layout.json may restore panel-chat at boot, so the default
 * session window is often already the chat workspace (not the hub orb).
 */
describe('Moon smoke', () => {
  it('loads a live document with Tauri APIs', async () => {
    const ready = await browser.waitUntil(
      async () => {
        const state = await browser.execute(() => document.readyState);
        return state === 'complete' || state === 'interactive';
      },
      { timeout: 20_000, timeoutMsg: 'document never became ready' },
    );
    expect(ready).toBe(true);

    const title = await browser.getTitle();
    expect(String(title).length).toBeGreaterThan(0);

    const hasTauri = await browser.execute(() => {
      return !!(window.__TAURI__ && window.__TAURI__.core);
    });
    expect(hasTauri).toBe(true);
  });

  it('has a chat workspace window (restored or via expand_from_moon)', async () => {
    const handles = await browser.getWindowHandles();
    expect(handles.length).toBeGreaterThanOrEqual(1);

    // Prefer an existing chat panel (layout restore is common on dev machines).
    let chatHandle = null;
    for (const h of handles) {
      await browser.switchToWindow(h);
      const isChat = await browser.execute(() => {
        return !!(
          window.__moonE2E ||
          document.getElementById('message-input') ||
          document.querySelector('.chat-input') ||
          document.getElementById('thread-drawer')
        );
      });
      if (isChat) {
        chatHandle = h;
        break;
      }
    }

    if (!chatHandle) {
      // Cold start: hub only — expand from main.
      for (const h of handles) {
        await browser.switchToWindow(h);
        const isMain = await browser.execute(() => {
          // Hub index.html — no chat input.
          return !document.getElementById('message-input') && !!window.__TAURI__;
        });
        if (isMain) break;
      }
      await browser.execute(async () => {
        await window.__TAURI__.core.invoke('expand_from_moon');
      });
      await browser.waitUntil(
        async () => {
          const hs = await browser.getWindowHandles();
          for (const h of hs) {
            await browser.switchToWindow(h);
            const hit = await browser.execute(() => {
              return !!(window.__moonE2E || document.getElementById('message-input'));
            });
            if (hit) return true;
          }
          return false;
        },
        { timeout: 25_000, timeoutMsg: 'chat workspace never appeared after expand_from_moon' },
      );
    }

    // Land on a chat surface with E2E hooks when possible.
    const after = await browser.getWindowHandles();
    let found = false;
    for (const h of after) {
      await browser.switchToWindow(h);
      found = await browser.execute(() => {
        return !!(window.__moonE2E || document.getElementById('message-input'));
      });
      if (found) break;
    }
    expect(found).toBe(true);
  });
});
