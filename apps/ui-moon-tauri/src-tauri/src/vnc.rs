//! VNC screen share: a loopback WebSocket↔TCP bridge.
//!
//! The Screen Share panel runs noVNC — an RFB client that speaks over
//! WebSocket binary frames — but real VNC servers only listen on raw TCP.
//! `vnc_connect` dials the target first (so a refused host errors before any
//! URL is handed out), then binds a one-shot WS listener on 127.0.0.1 with an
//! ephemeral port and a random path token, and pipes bytes both ways.
//!
//! One bridge = one accepted WS connection paired with one TCP stream. The
//! task ends when either side closes, when the WS never arrives within the
//! accept window, when a write stalls past WRITE_STALL_TIMEOUT, or when the
//! window that opened it is destroyed (`abort_for_window`, wired from
//! main.rs). Auth never crosses this boundary: RFB negotiates its own
//! password over the same byte stream the bridge only copies.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

/// Upper bound on simultaneously live bridges — a panel leaks nothing when
/// it forgets to disconnect, but an unbounded map still shouldn't grow.
const MAX_BRIDGES: usize = 16;
/// How long an unclaimed listener waits for its one WS client before giving
/// up (the frontend dials within milliseconds of getting the URL).
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound on the TCP dial to the VNC server.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// TCP read chunk → one WS binary frame.
const PIPE_BUF: usize = 64 * 1024;
/// After the one WS client connects over TCP it has this long to complete
/// the WebSocket handshake — a socket that never speaks HTTP can't hold the
/// bridge (and its VNC connection) open forever.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A slot reserved by an in-flight `vnc_connect` is dropped if the command
/// future is cancelled before it can spawn the task (IPC abort).
const RESERVATION_TTL: Duration = Duration::from_secs(60);
/// A single write (TCP to the VNC server, or a WS frame to the panel) that
/// cannot complete in this long means the far side stopped reading. End the
/// bridge instead of letting it hold both sockets forever.
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(20);

/// One map entry per bridge, tagged with the window that opened it so a
/// destroyed window can take its bridges down (`abort_for_window`).
/// `Reserved` holds a slot for the whole `vnc_connect` call so the
/// MAX_BRIDGES cap can't be raced by two concurrent connects both passing
/// the check before either spawns.
enum Slot {
    Reserved(Instant),
    Live(tauri::async_runtime::JoinHandle<()>),
}

struct BridgeSlot {
    window: String,
    slot: Slot,
}

/// Live bridge tasks keyed by the id handed back to the frontend. Managed via
/// `.manage()` in main.rs.
#[derive(Default)]
pub(crate) struct VncBridges {
    inner: Mutex<HashMap<u64, BridgeSlot>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl VncBridges {
    /// Hold a bridge slot BEFORE dialing. The reservation counts against
    /// MAX_BRIDGES until `finish` (spawned task takes it) or `remove`
    /// (dial/bind failed); a reservation abandoned by a cancelled command
    /// future is pruned after RESERVATION_TTL.
    fn try_reserve(&self, window: &str) -> Result<u64, String> {
        let mut m = self.inner.lock().map_err(|_| "bridge state poisoned")?;
        m.retain(|_, b| match &b.slot {
            Slot::Live(h) => !h.inner().is_finished(),
            Slot::Reserved(at) => at.elapsed() < RESERVATION_TTL,
        });
        if m.len() >= MAX_BRIDGES {
            return Err("too many open screen shares".to_string());
        }
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        m.insert(id, BridgeSlot { window: window.to_string(), slot: Slot::Reserved(Instant::now()) });
        Ok(id)
    }

    /// Swap a reservation for its spawned task (id came from try_reserve).
    /// If the reservation is gone (its window was destroyed mid-dial), the
    /// task is aborted at once instead of being parked in the map.
    fn finish(&self, id: u64, task: tauri::async_runtime::JoinHandle<()>) {
        let Ok(mut m) = self.inner.lock() else {
            task.abort();
            return;
        };
        match m.get_mut(&id) {
            Some(b) => b.slot = Slot::Live(task),
            None => task.abort(),
        }
    }

    /// Drop the slot and return the task to abort, if one was spawned.
    fn remove(&self, id: u64) -> Option<tauri::async_runtime::JoinHandle<()>> {
        match self.inner.lock().ok()?.remove(&id) {
            Some(BridgeSlot { slot: Slot::Live(h), .. }) => Some(h),
            _ => None,
        }
    }

    /// Remove every slot owned by `window`; returns the live tasks to abort.
    fn take_for_window(&self, window: &str) -> Vec<tauri::async_runtime::JoinHandle<()>> {
        let Ok(mut m) = self.inner.lock() else { return Vec::new() };
        let ids: Vec<u64> = m.iter().filter(|(_, b)| b.window == window).map(|(id, _)| *id).collect();
        ids.into_iter()
            .filter_map(|id| match m.remove(&id) {
                Some(BridgeSlot { slot: Slot::Live(h), .. }) => Some(h),
                _ => None,
            })
            .collect()
    }
}

/// Abort every bridge opened by `window`. Called from main.rs on
/// `WindowEvent::Destroyed`: React's unmount cleanup does not reliably run
/// when a webview is torn down, so the native side owns this guarantee.
pub(crate) fn abort_for_window(app: &AppHandle, window: &str) {
    if let Some(bridges) = app.try_state::<VncBridges>() {
        for task in bridges.take_for_window(window) {
            task.abort();
        }
    }
}

#[derive(Serialize)]
pub(crate) struct VncBridgeInfo {
    /// Handle for `vnc_disconnect`.
    pub(crate) id: u64,
    /// The ws:// URL the noVNC client should connect to.
    pub(crate) url: String,
}

/// Path token checked during the WS handshake so a same-host process can't
/// steal a freshly-opened bridge by racing the panel's own dial to an
/// ephemeral port it would have to guess anyway. Cryptographically random:
/// pid+time is guessable by another local process.
fn bridge_token() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| format!("bridge token failed: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Reject anything that can't be a plain host (no whitespace/control chars,
/// no scheme — the frontend skips the bridge entirely for ws:// URLs).
fn validate_host(host: &str) -> Result<&str, String> {
    let host = host.trim();
    if host.is_empty() || host.len() > 255 {
        return Err("enter a host name or IP".to_string());
    }
    if host
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '/' || c == '@')
    {
        return Err("host must be a plain name or IP, not a URL".to_string());
    }
    Ok(host)
}

/// Run `connect`, giving up after `limit` with a human-readable error.
/// The connector is a seam so the bound can be tested without a network.
async fn dial_via<T>(
    host: &str,
    port: u16,
    limit: Duration,
    connect: impl std::future::Future<Output = std::io::Result<T>>,
) -> Result<T, String> {
    match tokio::time::timeout(limit, connect).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => Err(format!("can't reach {host}:{port} - {e}")),
        Err(_) => Err(format!("can't reach {host}:{port} - timed out")),
    }
}

/// Dial `host:port`, giving up after `limit` with a human-readable error.
async fn dial_within(host: &str, port: u16, limit: Duration) -> Result<TcpStream, String> {
    dial_via(host, port, limit, TcpStream::connect((host, port))).await
}

async fn dial(host: &str, port: u16) -> Result<TcpStream, String> {
    dial_within(host, port, DIAL_TIMEOUT).await
}

#[tauri::command]
pub(crate) async fn vnc_connect(
    app: AppHandle,
    window: tauri::Window,
    host: String,
    port: u16,
) -> Result<VncBridgeInfo, String> {
    let host = validate_host(&host)?.to_string();
    if port == 0 {
        return Err("port must be 1-65535".to_string());
    }
    let bridges = app.state::<VncBridges>();
    // Reserve the slot BEFORE dialing: the cap is held under the same lock
    // that counts live bridges, so concurrent connects can't both slip under
    // it. Every fallible step below returns the slot on its way out.
    let id = bridges.try_reserve(window.label())?;
    // Dial the VNC server first: a refused/unreachable target surfaces the
    // real error right here instead of handing back a ws URL that only
    // fails inside noVNC's own handshake.
    // Bounded: the OS default connect timeout is ~75s on macOS, long enough
    // for a panel to sit on "Connecting" far past the point a user gives up.
    let setup = async {
        let vnc = dial(&host, port).await?;
        let _ = vnc.set_nodelay(true);
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| format!("bridge listen failed: {e}"))?;
        let ws_port = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        let token = bridge_token()?;
        Ok::<_, String>((vnc, listener, ws_port, token))
    };
    // Any setup failure returns the reserved slot with the error.
    let (vnc, listener, ws_port, token) = match setup.await {
        Ok(t) => t,
        Err(e) => {
            bridges.remove(id);
            return Err(e);
        }
    };
    let task = tauri::async_runtime::spawn(bridge_task(app.clone(), listener, vnc, token.clone(), id));
    bridges.finish(id, task);
    Ok(VncBridgeInfo {
        id,
        url: format!("ws://127.0.0.1:{ws_port}/vnc-{token}"),
    })
}

#[tauri::command]
pub(crate) fn vnc_disconnect(app: AppHandle, id: u64) -> Result<(), String> {
    if let Some(task) = app.state::<VncBridges>().remove(id) {
        task.abort();
    }
    Ok(())
}

/// Accept the one expected WS client, check its path token, then run the
/// pipe. Every exit path removes this bridge's registry entry via the id the
/// caller reserved before spawning.
async fn bridge_task(
    app: AppHandle,
    listener: TcpListener,
    vnc: TcpStream,
    token: String,
    id: u64,
) {
    accept_and_pipe_within(listener, vnc, token, ACCEPT_TIMEOUT, HANDSHAKE_TIMEOUT).await;
    let _ = app.state::<VncBridges>().remove(id);
}

/// The bridge lifecycle with the registry coupling removed so tests can run
/// the real accept → token-check → pipe path without an AppHandle.
///
/// Keeps accepting until a client presents the token path or the accept
/// window closes: a wrong-path or silent connection (another local process
/// probing the ephemeral port) is dropped and the listener keeps waiting, so
/// it cannot kill the panel's real session. Each attempt gets its own
/// handshake bound, and the overall deadline still caps the whole wait.
async fn accept_and_pipe_within(
    listener: TcpListener,
    vnc: TcpStream,
    token: String,
    accept_timeout: Duration,
    handshake_timeout: Duration,
) {
    let deadline = tokio::time::Instant::now() + accept_timeout;
    let expected_path = format!("/vnc-{token}");
    loop {
        let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
        let Ok(Ok((ws_stream, _))) = accepted else { return };
        let path = expected_path.clone();
        let bound = std::cmp::min(deadline, tokio::time::Instant::now() + handshake_timeout);
        let ws = tokio::time::timeout_at(
            bound,
            tokio_tungstenite::accept_hdr_async(ws_stream, move |req: &Request, res: Response| {
                if req.uri().path() == path {
                    Ok(res)
                } else {
                    let mut err = ErrorResponse::new(None);
                    *err.status_mut() = StatusCode::NOT_FOUND;
                    Err(err)
                }
            }),
        )
        .await;
        if let Ok(Ok(ws)) = ws {
            pipe(vnc, ws).await;
            return;
        }
        // Wrong token, not a WebSocket, or too slow: drop it, keep waiting.
    }
}

/// Copy bytes both ways; when either direction ends, dropping the futures
/// closes both sockets (the panel's WS and the VNC TCP) together.
async fn pipe<S>(vnc: TcpStream, ws: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut ws_sink, mut ws_rx) = ws.split();
    let (mut tcp_rx, mut tcp_tx) = vnc.into_split();
    let to_ws = async {
        let mut buf = vec![0u8; PIPE_BUF];
        loop {
            match tcp_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let sent = tokio::time::timeout(
                        WRITE_STALL_TIMEOUT,
                        ws_sink.send(Message::Binary(buf[..n].to_vec().into())),
                    )
                    .await;
                    if !matches!(sent, Ok(Ok(()))) {
                        break;
                    }
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), ws_sink.send(Message::Close(None))).await;
    };
    let to_tcp = async {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(bytes)) => {
                    let wrote =
                        tokio::time::timeout(WRITE_STALL_TIMEOUT, tcp_tx.write_all(&bytes)).await;
                    if !matches!(wrote, Ok(Ok(()))) {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), tcp_tx.shutdown()).await;
    };
    tokio::select! {
        _ = to_ws => {}
        _ = to_tcp => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn validate_host_rejects_urls_and_junk() {
        assert!(validate_host("192.168.1.20").is_ok());
        assert!(validate_host("my-mac.local").is_ok());
        assert!(validate_host("::1").is_ok());
        assert!(validate_host("").is_err());
        assert!(validate_host("   ").is_err());
        assert!(validate_host("ws://evil/x").is_err());
        assert!(validate_host("user@host").is_err());
        assert!(validate_host("a b").is_err());
    }

    /// A connect that never completes (a black-holed host) must fail within
    /// the bound, not the OS's ~75s. The fake connector never resolves, so no
    /// network is involved; the outer timeout turns a missing bound into a
    /// test failure instead of a hang.
    #[tokio::test]
    async fn dial_gives_up_within_the_bound() {
        let limit = Duration::from_millis(100);
        let started = std::time::Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            dial_via("black.hole", 5900, limit, std::future::pending::<std::io::Result<()>>()),
        )
        .await
        .expect("dial_via did not honor its bound");
        let err = outcome.expect_err("dial should not succeed");
        assert_eq!(err, "can't reach black.hole:5900 - timed out");
        assert!(started.elapsed() >= limit, "gave up before the bound");
    }

    /// A connect that fails fast reports the underlying error, not "timed out".
    #[tokio::test]
    async fn dial_reports_a_connect_error() {
        let err = dial_via("h", 1, Duration::from_secs(5), async {
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))
        })
        .await
        .expect_err("dial should fail");
        assert!(err.starts_with("can't reach h:1 - "), "{err}");
        assert!(!err.contains("timed out"), "{err}");
    }

    /// The real connector path against a loopback listener succeeds.
    #[tokio::test]
    async fn dial_within_connects_to_a_local_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        dial_within("127.0.0.1", port, Duration::from_secs(5))
            .await
            .expect("loopback dial should succeed");
    }

    /// The pipe is the whole reason the bridge exists: prove bytes flow
    /// TCP→WS (server greeting) and WS→TCP (client bytes echoed server-side)
    /// over real loopback sockets.
    #[tokio::test]
    async fn pipe_moves_bytes_both_ways() {
        // Fake VNC server: send the RFB greeting, then read back 5 bytes.
        let server = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let server_port = server.local_addr().unwrap().port();
        let (echo_tx, echo_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        tokio::spawn(async move {
            let (mut s, _) = server.accept().await.unwrap();
            s.write_all(b"RFB 003.008\n").await.unwrap();
            let mut buf = vec![0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            let _ = echo_tx.send(buf);
        });
        // Bridge side: one WS listener piped to that TCP connection.
        let vnc = TcpStream::connect((Ipv4Addr::LOCALHOST, server_port))
            .await
            .unwrap();
        let ws_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let ws_port = ws_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = ws_listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            pipe(vnc, ws).await;
        });
        // Client (the noVNC stand-in): greeting arrives as a binary frame.
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}/vnc-x"))
                .await
                .unwrap();
        let greeting = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("greeting timed out")
            .expect("stream ended")
            .expect("ws error");
        assert_eq!(greeting.into_data().as_ref(), b"RFB 003.008\n");
        ws.send(Message::Binary(b"hello".to_vec().into())).await.unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(5), echo_rx)
            .await
            .expect("echo timed out")
            .expect("server task dropped");
        assert_eq!(&echoed, b"hello");
    }

    /// A fake VNC server: sends the RFB greeting on connect, then holds the
    /// socket open. Returns the ws listener + vnc stream already wired to it.
    async fn fake_vnc_and_ws_listener() -> (TcpListener, TcpStream) {
        let server = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let server_port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = server.accept().await.unwrap();
            s.write_all(b"RFB 003.008\n").await.unwrap();
            // Hold the connection so the bridge stays up for the client.
            let mut buf = [0u8; 64];
            while s.read(&mut buf).await.unwrap_or(0) > 0 {}
        });
        let vnc = TcpStream::connect((Ipv4Addr::LOCALHOST, server_port))
            .await
            .unwrap();
        let ws_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        (ws_listener, vnc)
    }

    /// The bridge is token-gated but not killable: a client that guesses the
    /// ephemeral port without the path token gets a 404, and the bridge keeps
    /// waiting, so the panel's real (token-bearing) client still connects.
    #[tokio::test]
    async fn bridge_rejects_a_wrong_path_and_still_serves_the_real_client() {
        let (ws_listener, vnc) = fake_vnc_and_ws_listener().await;
        let ws_port = ws_listener.local_addr().unwrap().port();
        tokio::spawn(accept_and_pipe_within(
            ws_listener,
            vnc,
            "right".to_string(),
            Duration::from_secs(5),
            Duration::from_secs(5),
        ));
        let res = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}/vnc-wrong"))
            .await;
        assert!(res.is_err(), "wrong path must fail the handshake");
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}/vnc-right"))
                .await
                .expect("the real client must still get in after a rejected probe");
        let greeting = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("greeting timed out")
            .expect("stream ended")
            .expect("ws error");
        assert_eq!(greeting.into_data().as_ref(), b"RFB 003.008\n");
    }

    /// With no valid client the bridge still ends at the accept deadline.
    #[tokio::test]
    async fn bridge_ends_at_the_accept_deadline_after_only_bad_clients() {
        let (ws_listener, vnc) = fake_vnc_and_ws_listener().await;
        let ws_port = ws_listener.local_addr().unwrap().port();
        let task = tokio::spawn(accept_and_pipe_within(
            ws_listener,
            vnc,
            "right".to_string(),
            Duration::from_millis(400),
            Duration::from_secs(5),
        ));
        let _ = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}/vnc-wrong")).await;
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .expect("bridge must end at the accept deadline")
            .unwrap();
    }

    /// Same as pipe_moves_bytes_both_ways but through the full
    /// accept → token check → handshake → pipe path the task itself runs.
    #[tokio::test]
    async fn bridge_accepts_the_token_path_and_pipes() {
        let (ws_listener, vnc) = fake_vnc_and_ws_listener().await;
        let ws_port = ws_listener.local_addr().unwrap().port();
        tokio::spawn(accept_and_pipe_within(
            ws_listener,
            vnc,
            "tok".to_string(),
            Duration::from_secs(5),
            Duration::from_secs(5),
        ));
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}/vnc-tok"))
                .await
                .expect("correct path should handshake");
        let greeting = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("greeting timed out")
            .expect("stream ended")
            .expect("ws error");
        assert_eq!(greeting.into_data().as_ref(), b"RFB 003.008\n");
    }

    /// A TCP client that connects but never completes the WS handshake is
    /// dropped after the handshake bound and cannot block the real client.
    #[tokio::test]
    async fn a_silent_socket_cannot_hold_the_bridge() {
        let (ws_listener, vnc) = fake_vnc_and_ws_listener().await;
        let ws_port = ws_listener.local_addr().unwrap().port();
        tokio::spawn(accept_and_pipe_within(
            ws_listener,
            vnc,
            "tok".to_string(),
            Duration::from_secs(5),
            Duration::from_millis(100),
        ));
        let _silent = TcpStream::connect((Ipv4Addr::LOCALHOST, ws_port)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let res = tokio::time::timeout(
            Duration::from_secs(3),
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}/vnc-tok")),
        )
        .await
        .expect("real client must not be blocked by a silent socket");
        assert!(res.is_ok(), "real client should handshake");
    }

    /// Slots are held for the whole vnc_connect call: reserved entries count
    /// against MAX_BRIDGES exactly like live ones, release on remove, and a
    /// reservation abandoned past RESERVATION_TTL is pruned.
    #[test]
    fn reservations_hold_the_cap_until_finished_or_expired() {
        let b = VncBridges::default();
        let mut ids = Vec::new();
        for _ in 0..MAX_BRIDGES {
            ids.push(b.try_reserve("panel-vnc").expect("under cap"));
        }
        assert!(b.try_reserve("panel-vnc").is_err(), "cap must count reservations");
        b.remove(ids.pop().unwrap());
        assert!(b.try_reserve("panel-vnc").is_ok(), "a freed slot is reusable");
        // An abandoned reservation expires instead of leaking the slot:
        // age out one held id so pruning drops the map back under the cap.
        let stale_id = ids.pop().unwrap();
        b.inner
            .lock()
            .unwrap()
            .insert(stale_id, BridgeSlot {
                window: "panel-vnc".to_string(),
                slot: Slot::Reserved(Instant::now() - RESERVATION_TTL),
            });
        assert!(b.try_reserve("panel-vnc").is_ok(), "stale reservations are pruned");
    }

    /// A destroyed window takes exactly its own slots with it.
    #[test]
    fn take_for_window_removes_only_that_windows_slots() {
        let b = VncBridges::default();
        let mine = b.try_reserve("panel-vnc-a").unwrap();
        let other = b.try_reserve("panel-vnc-b").unwrap();
        assert!(b.take_for_window("panel-vnc-a").is_empty(), "reservations have no task to abort");
        let m = b.inner.lock().unwrap();
        assert!(!m.contains_key(&mine), "the destroyed window's slot is gone");
        assert!(m.contains_key(&other), "another window's slot is untouched");
    }

    /// The anti-hijack token is 128 bits of OS entropy, not pid+time.
    #[test]
    fn bridge_token_is_random_128bit_hex() {
        let a = bridge_token().unwrap();
        let b = bridge_token().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
