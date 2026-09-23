//! Moon lifecycle: the collapse/expand state machine (workspace ⟷ orb) and the
//! one-time webview cache purge on app update.
//!
//! Split out of main.rs (moon-next split): moved verbatim, only visibility
//! (`pub(crate)`) and cross-module paths (`crate::windows::is_dock_label`,
//! `crate::windows::open_widget`) changed.

use tauri::Emitter;
use tauri::Manager;

use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

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
    let mut shown_labels: Vec<String> = Vec::new();
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
            // none become visible, the empty fallback below opens (or
            // re-shows, via open_widget's existing-window path) the chat.
            if win.is_visible().unwrap_or(false) {
                shown_labels.push(label.clone());
            }
        }
    }
    // Focus ONE revealed widget (the chat when it is among them): show()
    // orders a window in but does NOT activate the app, and under Stage
    // Manager an inactive app's windows stay shelved as left-strip tiles
    // instead of compositing (live incident: panel-chat existed in the AX
    // tree at its layout rect with no CG surface while WindowManager tiles
    // sat at x≈-307). set_focus makes the window key AND activates the app,
    // so Moon's stage — real, composited windows — swaps in.
    if let Some(label) = pick_expand_focus_target(&shown_labels) {
        if let Some(win) = windows.get(label) {
            let _ = win.set_focus();
            // set_focus silently no-ops when its target reports not-visible
            // at call time — but the ACTIVATION must never be lost, or Stage
            // Manager keeps every Moon window shelved as a strip tile. Make
            // it unconditional (idempotent when set_focus already did it).
            crate::windows::activate_app(win);
        }
    }
    if let Some(moon) = windows.get("main") {
        let _ = moon.hide();
    }
    if shown_labels.is_empty() {
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

/// Which revealed widget should take focus after an expand — the main chat
/// line when it is among them (the surface the user almost always wants),
/// otherwise any revealed widget. `None` only when nothing became visible
/// (the caller then falls back to opening the chat). Pure and unit-tested:
/// the focus is what ACTIVATES the app, which is what makes Stage Manager
/// swap Moon's real windows in instead of leaving shelf tiles.
fn pick_expand_focus_target(shown: &[String]) -> Option<&String> {
    shown
        .iter()
        .find(|l| l.as_str() == "panel-chat")
        .or_else(|| shown.first())
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

#[cfg(test)]
mod expand_focus_tests {
    use super::pick_expand_focus_target;

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn prefers_the_main_chat_line_when_present() {
        let shown = labels(&["panel-vault", "panel-chat", "widget-abc123"]);
        assert_eq!(
            pick_expand_focus_target(&shown).map(String::as_str),
            Some("panel-chat")
        );
    }

    #[test]
    fn falls_back_to_any_revealed_widget_without_chat() {
        let shown = labels(&["panel-vault", "widget-abc123"]);
        assert_eq!(
            pick_expand_focus_target(&shown).map(String::as_str),
            Some("panel-vault")
        );
    }

    #[test]
    fn nothing_revealed_focuses_nothing_so_the_chat_fallback_owns_it() {
        assert_eq!(pick_expand_focus_target(&[]), None);
        // A parallel chat instance is NOT the main line; it still wins only
        // as "any revealed widget", never by the panel-chat fast path.
        let shown = labels(&["panel-chat-abc123"]);
        assert_eq!(
            pick_expand_focus_target(&shown).map(String::as_str),
            Some("panel-chat-abc123")
        );
    }
}

/// Hard ceiling so a hung WKWebsiteDataStore callback cannot freeze Moon boot.
/// A few seconds is plenty for a disk/memory cache purge on a healthy Mac.
#[cfg(target_os = "macos")]
const WEBVIEW_CACHE_PURGE_TIMEOUT: Duration = Duration::from_secs(5);

/// Outcome of waiting for the WK cache-purge completion signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CachePurgeWaitOutcome {
    Completed,
    TimedOut,
    Disconnected,
}

/// Wait up to `timeout` for `rx` to receive the purge-done signal.
///
/// Between polls, `pump` runs (on macOS: CFRunLoopRunInMode) so WK's
/// `MainRunLoopCallbackAggregator` can deliver the completion on this same
/// main thread — a bare `recv_timeout` would deadlock until the deadline.
/// Pure enough to unit-test without AppKit by passing a sleep/no-op pump.
pub(crate) fn wait_for_cache_purge_signal<F>(
    rx: &Receiver<()>,
    timeout: Duration,
    mut pump: F,
) -> CachePurgeWaitOutcome
where
    F: FnMut(Duration),
{
    let deadline = Instant::now() + timeout;
    loop {
        match rx.try_recv() {
            Ok(()) => return CachePurgeWaitOutcome::Completed,
            Err(TryRecvError::Disconnected) => return CachePurgeWaitOutcome::Disconnected,
            Err(TryRecvError::Empty) => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return CachePurgeWaitOutcome::TimedOut;
        }
        let slice = (deadline - now).min(Duration::from_millis(50));
        pump(slice);
    }
}

/// Clear ONLY the WKWebView disk + memory cache, preserving localStorage /
/// IndexedDB. WKWebView caches the `tauri://` asset responses (the embedded
/// frontend) and keeps serving them ACROSS app updates — so a user on a fresh
/// binary kept seeing a months-old frontend (none of the shipped frontend fixes
/// ran). Purging the cache forces the webview to re-fetch the new embedded
/// assets. Must run on the main thread.
///
/// Blocks until the WK completion handler fires (or [`WEBVIEW_CACHE_PURGE_TIMEOUT`]
/// elapses) so hub/panel webviews opened after this returns cannot race a
/// still-in-flight purge and load stale cached JS (exp_moon_cache_race).
#[cfg(target_os = "macos")]
fn clear_webview_disk_cache() {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRunLoopRunInMode};
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

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let done = RcBlock::new(move || {
        let _ = tx.send(());
        eprintln!("[moon] WKWebView cache purge completed");
    });
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    eprintln!("[moon] clearing WKWebView disk/memory cache (frontend refresh)");
    unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &epoch, &done) };

    // WK delivers the completion via MainRunLoopCallbackAggregator — pump the
    // main CFRunLoop while waiting so the RcBlock can run on this thread.
    let outcome = wait_for_cache_purge_signal(&rx, WEBVIEW_CACHE_PURGE_TIMEOUT, |slice| {
        let _ = unsafe {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, slice.as_secs_f64(), true)
        };
    });
    match outcome {
        CachePurgeWaitOutcome::Completed => {}
        CachePurgeWaitOutcome::TimedOut => {
            eprintln!(
                "[moon] WKWebView cache purge timed out after {}s — continuing boot",
                WEBVIEW_CACHE_PURGE_TIMEOUT.as_secs()
            );
        }
        CachePurgeWaitOutcome::Disconnected => {
            eprintln!(
                "[moon] WKWebView cache purge waiter disconnected before completion — continuing boot"
            );
        }
    }
}

#[cfg(test)]
mod cache_purge_wait_tests {
    use super::{wait_for_cache_purge_signal, CachePurgeWaitOutcome};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn completed_when_signal_already_sent() {
        let (tx, rx) = mpsc::channel();
        tx.send(()).unwrap();
        let outcome = wait_for_cache_purge_signal(&rx, Duration::from_secs(1), |_| {});
        assert_eq!(outcome, CachePurgeWaitOutcome::Completed);
    }

    #[test]
    fn completed_when_signal_arrives_during_wait() {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            let _ = tx.send(());
        });
        let outcome = wait_for_cache_purge_signal(&rx, Duration::from_secs(1), |slice| {
            thread::sleep(slice.min(Duration::from_millis(10)));
        });
        assert_eq!(outcome, CachePurgeWaitOutcome::Completed);
    }

    #[test]
    fn timed_out_when_no_signal() {
        let (_tx, rx) = mpsc::channel::<()>();
        let outcome = wait_for_cache_purge_signal(&rx, Duration::from_millis(40), |slice| {
            thread::sleep(slice.min(Duration::from_millis(10)));
        });
        assert_eq!(outcome, CachePurgeWaitOutcome::TimedOut);
    }

    #[test]
    fn disconnected_when_sender_dropped_without_signal() {
        let (tx, rx) = mpsc::channel::<()>();
        drop(tx);
        let outcome = wait_for_cache_purge_signal(&rx, Duration::from_secs(1), |_| {});
        assert_eq!(outcome, CachePurgeWaitOutcome::Disconnected);
    }
}

/// On the FIRST launch after an app update, purge the webview cache so the new
/// embedded frontend loads instead of the version the webview cached under the
/// old build. Tracks the last-seen version in `~/.luna/.moon-webview-version`.
/// Best-effort: any error simply skips the purge (no worse than before). Runs at
/// the very start of `setup` and **waits for the purge to finish** (with a short
/// timeout) before any panel webview opens, so panels cannot race a still-in-
/// flight cache clear and load stale JS.
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
