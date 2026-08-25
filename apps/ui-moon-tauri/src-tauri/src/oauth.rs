//! Connector OAuth: client-brokered loopback (PRD A §09, RFC 8252) + the
//! external-URL opener.
//!
//! Split out of main.rs (moon-next split): moved verbatim, only visibility
//! (`pub(crate)`) changed so `main.rs` can `.manage(oauth::OauthLoopback::default())`
//! and wire the commands into `tauri::generate_handler!`.

// ── connector OAuth: client-brokered loopback (PRD A §09, RFC 8252) ─────────
//
// The Moon is the BROWSER side of the flow: it binds an ephemeral
// 127.0.0.1 port, tells the server that port (the server builds
// redirect_uri = http://127.0.0.1:<port>/callback), opens the consent URL
// in the operator's real browser, and captures the provider's redirect.
// Only the authorization CODE passes through here — it is worthless
// without the PKCE verifier, which never leaves the server.
//
// One flow at a time (a human is clicking through consent); starting a new
// listener cancels the previous one. The accept loop polls a nonblocking
// listener so cancel/timeout are responsive without OS-specific tricks.

#[derive(Default)]
pub(crate) struct OauthLoopback {
    inner: std::sync::Mutex<Option<OauthLoopbackActive>>,
}

struct OauthLoopbackActive {
    port: u16,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct OauthRedirectResult {
    code: String,
    state: String,
}

/// What one raw HTTP request hitting the loopback listener turned out to be.
enum CallbackOutcome {
    /// The provider redirect with `code` + `state` — the flow succeeded.
    Captured(OauthRedirectResult),
    /// The provider redirect with `error=…` — consent was denied/blocked
    /// (e.g. Google `access_denied` for a non-test-user on a Testing-mode
    /// app). Must surface immediately, NOT time out after 5 minutes.
    Declined(String),
    /// Favicon probe or other noise — keep listening.
    NotRedirect,
}

fn parse_loopback_request(req: &str) -> CallbackOutcome {
    let path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let query = path.split_once('?').map(|x| x.1).unwrap_or("");
    if let (Some(code), Some(state)) = (query_param(query, "code"), query_param(query, "state")) {
        return CallbackOutcome::Captured(OauthRedirectResult { code, state });
    }
    if let Some(err) = query_param(query, "error") {
        let detail = query_param(query, "error_description")
            .map(|d| format!(" — {d}"))
            .unwrap_or_default();
        return CallbackOutcome::Declined(format!(
            "consent was declined by the provider: {err}{detail}"
        ));
    }
    CallbackOutcome::NotRedirect
}

/// Tiny query-string field extractor — enough for `?code=…&state=…` from a
/// well-formed provider redirect; both values are percent-decoded.
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            let raw = it.next().unwrap_or("");
            return Some(percent_decode(raw));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the operator sees in the browser tab after consenting — night-sky
/// wash, "return to Luna". Inlined: the listener serves exactly one page
/// and dies.
const OAUTH_DONE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Luna</title></head>\
<body style=\"margin:0;display:flex;align-items:center;justify-content:center;height:100vh;\
background:radial-gradient(900px 600px at 70% 10%,#16203c 0%,#0a0e1c 60%,#05070f 100%);\
font-family:-apple-system,sans-serif;color:#e7edf8\">\
<div style=\"text-align:center\"><div style=\"font-size:42px\">\u{1F319}</div>\
<h2 style=\"font-weight:600;margin:12px 0 6px\">Consent received</h2>\
<p style=\"color:#8ea2c8;font-size:14px\">You can close this tab and return to Luna — finishing up there.</p></div></body></html>";

/// Shown when the provider redirected with `error=…` — the old behavior
/// served the success page here, telling the operator "Connected" while
/// Luna hung waiting for a code that would never come.
const OAUTH_FAIL_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Luna</title></head>\
<body style=\"margin:0;display:flex;align-items:center;justify-content:center;height:100vh;\
background:radial-gradient(900px 600px at 70% 10%,#16203c 0%,#0a0e1c 60%,#05070f 100%);\
font-family:-apple-system,sans-serif;color:#e7edf8\">\
<div style=\"text-align:center\"><div style=\"font-size:42px\">\u{1F311}</div>\
<h2 style=\"font-weight:600;margin:12px 0 6px\">Not connected</h2>\
<p style=\"color:#8ea2c8;font-size:14px\">The provider declined the request. You can close this tab — details are in Luna.</p></div></body></html>";

/// The single-shot accept loop: parse each request, answer with the right
/// page, capture the outcome. Shared verbatim by the production command and
/// the loopback tests (they spawn THIS, not a mirror of it).
fn run_loopback_accept_loop(
    listener: std::net::TcpListener,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>>,
) {
    use std::io::{Read, Write};
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                // First line: GET /callback?code=…&state=… HTTP/1.1
                let outcome = parse_loopback_request(&req);
                let page = match outcome {
                    CallbackOutcome::Declined(_) => OAUTH_FAIL_HTML,
                    _ => OAUTH_DONE_HTML,
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        page.len(),
                        page
                    )
                    .as_bytes(),
                );
                let _ = stream.flush();
                match outcome {
                    CallbackOutcome::Captured(r) => {
                        *result.lock().unwrap() = Some(Ok(r));
                        return; // single-shot: captured, listener dies
                    }
                    CallbackOutcome::Declined(msg) => {
                        *result.lock().unwrap() = Some(Err(msg));
                        return; // single-shot: the flow is dead either way
                    }
                    // Not the redirect (favicon probe etc.) — keep listening.
                    CallbackOutcome::NotRedirect => {}
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

/// Bind 127.0.0.1:0 and start the single-shot accept loop. Returns the port
/// for the client to put in `connector-oauth-begin`.
#[tauri::command]
pub(crate) fn oauth_loopback_start(state: tauri::State<'_, OauthLoopback>) -> Result<u16, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not bind a loopback port: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("loopback setup failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("loopback setup failed: {e}"))?
        .port();

    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    // Replace (and cancel) any previous flow.
    {
        let mut guard = state.inner.lock().unwrap();
        if let Some(prev) = guard.take() {
            prev.cancel.store(true, Ordering::Relaxed);
        }
        *guard = Some(OauthLoopbackActive {
            port,
            cancel: cancel.clone(),
            result: result.clone(),
        });
    }

    std::thread::spawn(move || run_loopback_accept_loop(listener, cancel, result));

    Ok(port)
}

/// Await the captured redirect (poll the shared slot; the JS side calls this
/// right after opening the consent URL). Times out cleanly so an abandoned
/// consent doesn't wedge the settings UI.
#[tauri::command]
pub(crate) async fn oauth_loopback_wait(
    state: tauri::State<'_, OauthLoopback>,
    timeout_ms: Option<u64>,
) -> Result<OauthRedirectResult, String> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));
    let (cancel, result) = {
        let guard = state.inner.lock().unwrap();
        match guard.as_ref() {
            Some(active) => (active.cancel.clone(), active.result.clone()),
            None => return Err("no OAuth flow in progress".into()),
        }
    };
    loop {
        // A captured redirect resolves; a provider `error=…` redirect
        // rejects IMMEDIATELY with the provider's reason (it used to fall
        // through to the 5-minute timeout below).
        if let Some(r) = result.lock().unwrap().take() {
            return r;
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("OAuth flow cancelled".into());
        }
        if std::time::Instant::now() >= deadline {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err("timed out waiting for the browser consent".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Abort the in-flight flow (user closed the consent sheet).
#[tauri::command]
pub(crate) fn oauth_loopback_cancel(state: tauri::State<'_, OauthLoopback>) {
    if let Some(active) = state.inner.lock().unwrap().take() {
        active
            .cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // Poke the port so a blocked accept wakes promptly (best-effort).
        let _ = std::net::TcpStream::connect(("127.0.0.1", active.port));
    }
}

/// Open a URL in the user's default handler. Allows only https:// (web links,
/// OAuth consent) and mailto: (compose in the mail client). Everything else —
/// http://, file://, javascript:, custom schemes — is refused so that
/// agent-authored prose can never open an arbitrary handler. This must not
/// become a general shell-open primitive.
#[tauri::command]
pub(crate) fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Scheme allowlist, checked case-insensitively (a URL scheme is
    // case-insensitive per RFC 3986). `get(..n)` is char-boundary-safe — it
    // returns None rather than panicking if a multi-byte char straddles the
    // boundary. We match on the prefix but open the ORIGINAL `url`, since
    // lowercasing the whole string would corrupt the path/query/address.
    let is_https = url
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
    let is_mailto = url
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("mailto:"));
    if !(is_https || is_mailto) {
        return Err("only https:// or mailto: URLs can be opened".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("could not open the link: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── connector OAuth loopback parsing (PRD A §09) ────────────────────────

    #[test]
    fn query_param_extracts_code_and_state_with_percent_decoding() {
        let q = "code=4%2F0Adeu5BW&state=abc-_123&scope=email+profile";
        assert_eq!(query_param(q, "code").as_deref(), Some("4/0Adeu5BW"));
        assert_eq!(query_param(q, "state").as_deref(), Some("abc-_123"));
        assert_eq!(query_param(q, "scope").as_deref(), Some("email profile"));
        assert_eq!(query_param(q, "missing"), None);
    }

    #[test]
    fn query_param_survives_junk() {
        assert_eq!(query_param("", "code"), None);
        assert_eq!(query_param("code", "code").as_deref(), Some(""));
        assert_eq!(query_param("a=%ZZ", "a").as_deref(), Some("%ZZ")); // bad hex passes through
        assert_eq!(query_param("a=1&a=2", "a").as_deref(), Some("1")); // first wins
    }

    #[test]
    fn parse_loopback_request_classifies_redirects() {
        // Success redirect.
        match parse_loopback_request(
            "GET /callback?code=4%2Fabc&state=st-1 HTTP/1.1\r\nhost: x\r\n\r\n",
        ) {
            CallbackOutcome::Captured(r) => {
                assert_eq!(r.code, "4/abc");
                assert_eq!(r.state, "st-1");
            }
            _ => panic!("expected Captured"),
        }
        // Provider error redirect (the Testing-mode / denied-consent path).
        match parse_loopback_request(
            "GET /callback?error=access_denied&error_description=App+not+verified&state=st-1 HTTP/1.1\r\n\r\n",
        ) {
            CallbackOutcome::Declined(msg) => {
                assert!(msg.contains("access_denied"));
                assert!(msg.contains("App not verified"));
            }
            _ => panic!("expected Declined"),
        }
        // Error without a description still reports the code.
        match parse_loopback_request("GET /callback?error=access_denied&state=s HTTP/1.1\r\n\r\n") {
            CallbackOutcome::Declined(msg) => assert!(msg.ends_with("access_denied")),
            _ => panic!("expected Declined"),
        }
        // Favicon probe / junk keeps the listener alive.
        assert!(matches!(
            parse_loopback_request("GET /favicon.ico HTTP/1.1\r\n\r\n"),
            CallbackOutcome::NotRedirect
        ));
        assert!(matches!(
            parse_loopback_request(""),
            CallbackOutcome::NotRedirect
        ));
    }

    /// Spawn the REAL accept loop (not a mirror), play the provider with a
    /// browser-style redirect, assert the captured outcome + response page.
    fn run_loopback_against(
        request: &[u8],
    ) -> (String, Option<Result<OauthRedirectResult, String>>) {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicBool;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));

        let c2 = cancel.clone();
        let r2 = result.clone();
        let handle = std::thread::spawn(move || run_loopback_accept_loop(listener, c2, r2));

        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request).unwrap();

        // Read to EOF *or* a connection reset. The accept loop writes its
        // response and drops the socket; on macOS that surfaces to the reader
        // as ECONNRESET rather than a clean EOF, so `read_to_string().unwrap()`
        // panicked with "Connection reset by peer" on the macOS CI runner while
        // passing everywhere a clean FIN was delivered. The bytes already read
        // ARE the whole response, so a reset here is a normal end of message,
        // not a failure - and every assertion below is about those bytes.
        // Reading manually rather than via read_to_string because that function
        // leaves the buffer contents unspecified when it returns an error.
        let mut raw: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => raw.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => panic!("loopback read failed: {e}"),
            }
        }
        let response = String::from_utf8_lossy(&raw).into_owned();
        handle.join().unwrap();

        let outcome = result.lock().unwrap().take();
        (response, outcome)
    }

    #[test]
    fn loopback_captures_a_provider_redirect() {
        let (response, outcome) = run_loopback_against(
            b"GET /callback?code=the-code&state=the-state HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n",
        );
        assert!(response.contains("200 OK"));
        assert!(response.contains("return to Luna"));
        let captured = outcome.unwrap().unwrap();
        assert_eq!(captured.code, "the-code");
        assert_eq!(captured.state, "the-state");
    }

    #[test]
    fn loopback_surfaces_a_provider_error_redirect() {
        let (response, outcome) = run_loopback_against(
            b"GET /callback?error=access_denied&state=the-state HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n",
        );
        // The browser tab must NOT claim success…
        assert!(response.contains("Not connected"));
        assert!(!response.contains("Consent received"));
        // …and the waiting client gets the provider's reason immediately.
        let err = outcome.unwrap().unwrap_err();
        assert!(err.contains("access_denied"));
    }
}
