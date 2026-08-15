//! Moon lifecycle: the collapse/expand state machine (workspace ⟷ orb) and the
//! one-time webview cache purge on app update.
//!
//! Split out of main.rs (moon-next split): moved verbatim, only visibility
//! (`pub(crate)`) and cross-module paths (`crate::windows::is_dock_label`,
//! `crate::windows::open_widget`) changed.

use tauri::Emitter;
use tauri::Manager;

// ── Collapse ⟷ expand: the moon is the minimized form of the workspace ───────
//
// The moon orb (window "main") and the widget windows (panel-* / widget-*) are
// MUTUALLY EXCLUSIVE surfaces: either the orb is showing (collapsed) or the
// widgets are (expanded). "Minimize" on any widget tucks the WHOLE set into the
// moon; clicking the moon pours the whole set back out. The windows are HIDDEN,
// not closed, so positions / dock groups / page state all survive the round
// trip — the only way a widget leaves the set is the user closing it (×).

/// Hide every widget window and reveal + focus the moon orb. Widgets are hidden
/// (not destroyed) so a later expand restores them exactly. Emits `moon-absorb`
/// to the orb so index.html can play the "pulled into the moon" pulse.
pub(crate) fn collapse_into_moon(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    for (label, win) in &windows {
        if crate::windows::is_dock_label(label) {
            // Deminiaturize before hiding so a card OS-minimized via the native
            // yellow traffic-light doesn't linger as a Dock tile while the
            // workspace is collapsed. No-op on non-minimized windows.
            let _ = win.unminimize();
            let _ = win.hide();
        }
    }
    if let Some(moon) = windows.get("main") {
        // The orb is about to become the ONLY Luna surface (widgets are now
        // hidden) — never reveal it parked off every display, or the user has
        // nothing clickable and Moon reads as "won't open".
        crate::windows::ensure_window_on_visible_display(moon);
        let _ = moon.show();
        let _ = moon.set_focus();
        let _ = app.emit_to(tauri::EventTarget::labeled("main"), "moon-absorb", ());
    }
}

/// Reveal every widget window and hide the moon orb. Show the widgets BEFORE
/// hiding the orb so the desktop is never momentarily empty. When nothing is
/// open yet (a fresh moon), open the chat as the default widget so a click still
/// lands somewhere.
pub(crate) fn expand_out_of_moon(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    let mut shown = 0usize;
    for (label, win) in &windows {
        if crate::windows::is_dock_label(label) {
            // A card the user OS-minimized via the native yellow traffic-light
            // is miniaturized in the Dock; show() alone does NOT deminiaturize
            // on macOS, so unminimize first — otherwise the card is stranded in
            // the Dock with no in-app way back. No-op on non-minimized windows.
            let _ = win.unminimize();
            // A display change while collapsed can strand a hidden card off
            // every monitor; clamp before revealing so expand always produces
            // a reachable window.
            crate::windows::ensure_window_on_visible_display(win);
            let _ = win.show();
            // Count only windows that actually BECAME visible: a card that
            // show() could not order in (live incident: an AX-only window
            // with no compositor surface) must not satisfy the expand, or
            // the user ends with the orb hidden and nothing on screen. When
            // none become visible, the shown==0 fallback below opens (or
            // re-shows, via open_widget's existing-window path) the chat.
            if win.is_visible().unwrap_or(false) {
                shown += 1;
            }
        }
    }
    if let Some(moon) = windows.get("main") {
        let _ = moon.hide();
    }
    if shown == 0 {
        // No widgets to restore → open the chat. open_widget is async and shows
        // the window itself; spawn it so this stays callable from sync contexts
        // (the global-shortcut closure and the sync command wrapper). If even
        // the chat cannot open, bring the orb back — the moon was just hidden
        // above, and an expand that produces NOTHING must never leave the
        // user with an empty desktop.
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let opened = crate::windows::open_widget(
                app2.clone(),
                "chat".to_string(),
                None,
                None,
                None,
                None,
            )
            .await;
            if opened.is_err() {
                if let Some(moon) = app2.get_webview_window("main") {
                    crate::windows::ensure_window_on_visible_display(&moon);
                    let _ = moon.show();
                    let _ = moon.set_focus();
                }
            }
        });
    }
}

/// Collapse the whole workspace into the moon (a widget's minimize button / the
/// keyboard toggle when expanded).
#[tauri::command]
pub(crate) fn collapse_to_moon(app: tauri::AppHandle) -> Result<(), String> {
    collapse_into_moon(&app);
    Ok(())
}

/// Expand the workspace back out of the moon (the moon's own click / the
/// keyboard toggle when collapsed).
#[tauri::command]
pub(crate) fn expand_from_moon(app: tauri::AppHandle) -> Result<(), String> {
    expand_out_of_moon(&app);
    Ok(())
}

/// Clear ONLY the WKWebView disk + memory cache, preserving localStorage /
/// IndexedDB. WKWebView caches the `tauri://` asset responses (the embedded
/// frontend) and keeps serving them ACROSS app updates — so a user on a fresh
/// binary kept seeing a months-old frontend (none of the shipped frontend fixes
/// ran). Purging the cache forces the webview to re-fetch the new embedded
/// assets. Must run on the main thread.
#[cfg(target_os = "macos")]
fn clear_webview_disk_cache() {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSDate, NSSet, NSString};
    use objc2_web_kit::WKWebsiteDataStore;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // The WKWebsiteDataType* constants are NSStrings whose value equals their
    // name, so constructing them directly avoids extra feature gates. Cache types
    // only — NOT LocalStorage / IndexedDB / Cookies, so user settings survive.
    let disk = NSString::from_str("WKWebsiteDataTypeDiskCache");
    let mem = NSString::from_str("WKWebsiteDataTypeMemoryCache");
    let types = NSSet::from_retained_slice(&[disk, mem]);
    let epoch = NSDate::dateWithTimeIntervalSince1970(0.0); // clear all ages
    let done = RcBlock::new(|| eprintln!("[moon] WKWebView cache purge completed"));
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &epoch, &done) };
    eprintln!("[moon] clearing WKWebView disk/memory cache (frontend refresh)");
}

/// On the FIRST launch after an app update, purge the webview cache so the new
/// embedded frontend loads instead of the version the webview cached under the
/// old build. Tracks the last-seen version in `~/.luna/.moon-webview-version`.
/// Best-effort: any error simply skips the purge (no worse than before). Runs at
/// the very start of `setup`, before any panel webview opens on demand, so the
/// panels load fresh.
pub(crate) fn clear_webview_cache_if_updated() {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let dir = std::path::PathBuf::from(home).join(".luna");
        let stamp = dir.join(".moon-webview-version");
        let current = env!("CARGO_PKG_VERSION");
        let last = std::fs::read_to_string(&stamp).ok();
        if last.as_deref().map(str::trim) == Some(current) {
            return; // same build → the cache is for THIS frontend, keep it
        }
        clear_webview_disk_cache();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&stamp, current);
    }
}
