//! Native OS notifications.
//!
//! Split out of main.rs (moon-next split): moved verbatim, only visibility
//! (`pub(crate)`) changed so `main.rs` can wire `notify` into
//! `tauri::generate_handler!`.

use tauri_plugin_notification::NotificationExt;

/// Raise a native OS notification (macOS Notification Center / Linux
/// libnotify / Windows toast). Called from the chat webview when a
/// background/scheduled job result is delivered while the user isn't watching
/// (frontend `Notifier`, chat.html). Thin wrapper over the notification
/// plugin's Rust API — same shape as `speak_text` wrapping the voice engine,
/// so the webview only needs the `allow-notify` capability, not the plugin's
/// own `notification:default` IPC surface.
///
/// `body` is truncated defensively to a notification-sized preview so a long
/// job result can't produce a wall-of-text banner. Returns the plugin error
/// as a string rather than panicking, so a failed `show()` (e.g. the user has
/// notifications disabled in System Settings) degrades to a no-op the caller
/// can log.
#[tauri::command]
pub(crate) fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(truncate_notification_body(body))
        .show()
        .map_err(|e| e.to_string())
}

/// Cap a notification body at ~140 chars on a char boundary (not a byte
/// slice — job text can be multi-byte). Takes MAX chars and peeks one
/// further to detect truncation, so a huge job output is never scanned
/// end-to-end. Appends an ellipsis when truncated.
fn truncate_notification_body(body: String) -> String {
    const MAX: usize = 140;
    let mut chars = body.chars();
    let head: String = chars.by_ref().take(MAX).collect();
    if chars.next().is_some() {
        format!("{}…", head.trim_end())
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_body_short_text_passes_through_untouched() {
        assert_eq!(
            truncate_notification_body("done: 3 items".into()),
            "done: 3 items"
        );
        assert_eq!(truncate_notification_body(String::new()), "");
    }

    #[test]
    fn notification_body_long_text_truncates_on_char_boundary_with_ellipsis() {
        // Multi-byte chars: a byte-slice truncation would panic or split a
        // char; the char-based cap must keep exactly 140 chars + ellipsis.
        let long = "é".repeat(200);
        let out = truncate_notification_body(long);
        assert_eq!(out.chars().count(), 141); // 140 kept + '…'
        assert!(out.ends_with('…'));

        // Exactly at the cap: no truncation, no ellipsis.
        let exact = "x".repeat(140);
        assert_eq!(truncate_notification_body(exact.clone()), exact);
    }
}
