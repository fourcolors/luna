//! VNC screen share: a loopback WebSocket↔TCP bridge.
//!
//! The Screen Share panel runs noVNC — an RFB client that speaks over
//! WebSocket binary frames — but real VNC servers only listen on raw TCP.
//! `vnc_connect` dials the target first (so a refused host errors before any
//! URL is handed out), then binds a one-shot WS listener on 127.0.0.1 with an
//! ephemeral port and a random path token, and pipes bytes both ways.
//!
//! One bridge = one accepted WS connection paired with one TCP stream. The
//! task ends when either side closes or the WS never arrives within a short
//! accept window, so nothing leaks when a panel window is closed mid-connect.
//! Auth never crosses this boundary: RFB negotiates its own password over the
//! same byte stream the bridge only copies.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// Live bridge tasks keyed by the id handed back to the frontend. Managed via
/// `.manage()` in main.rs.
#[derive(Default)]
pub(crate) struct VncBridges {
    inner: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl VncBridges {
    /// Reserve an id BEFORE spawning so the task can carry it for
    /// self-cleanup; insert() then records id→task in one step.
    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    fn insert(&self, id: u64, task: tauri::async_runtime::JoinHandle<()>) {
        if let Ok(mut m) = self.inner.lock() {
            // Prune finished tasks so the bound reflects live bridges only.
            m.retain(|_, h| !h.inner().is_finished());
            m.insert(id, task);
        }
    }

    fn remove(&self, id: u64) -> Option<tauri::async_runtime::JoinHandle<()>> {
        self.inner.lock().ok()?.remove(&id)
    }

    fn live_count(&self) -> usize {
        self.inner
            .lock()
            .map(|m| m.values().filter(|h| !h.inner().is_finished()).count())
            .unwrap_or(0)
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
/// ephemeral port it would have to guess anyway.
fn bridge_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = nanos ^ ((std::process::id() as u128) << 64);
    format!("{seed:032x}")
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

/// Dial `host:port`, giving up after `limit` with a human-readable error.
async fn dial_within(host: &str, port: u16, limit: Duration) -> Result<TcpStream, String> {
    match tokio::time::timeout(limit, TcpStream::connect((host, port))).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => Err(format!("can't reach {host}:{port} - {e}")),
        Err(_) => Err(format!("can't reach {host}:{port} - timed out")),
    }
}

async fn dial(host: &str, port: u16) -> Result<TcpStream, String> {
    dial_within(host, port, DIAL_TIMEOUT).await
}

#[tauri::command]
pub(crate) async fn vnc_connect(
    app: AppHandle,
    host: String,
    port: u16,
) -> Result<VncBridgeInfo, String> {
    let host = validate_host(&host)?.to_string();
    if port == 0 {
        return Err("port must be 1-65535".to_string());
    }
    let bridges = app.state::<VncBridges>();
    if bridges.live_count() >= MAX_BRIDGES {
        return Err("too many open screen shares".to_string());
    }
    // Dial the VNC server first: a refused/unreachable target surfaces the
    // real error right here instead of handing back a ws URL that only
    // fails inside noVNC's own handshake.
    // Bounded: the OS default connect timeout is ~75s on macOS, long enough
    // for a panel to sit on "Connecting" far past the point a user gives up.
    let vnc = dial(&host, port).await?;
    let _ = vnc.set_nodelay(true);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| format!("bridge listen failed: {e}"))?;
    let ws_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let token = bridge_token();
    let id = bridges.alloc_id();
    let task = tauri::async_runtime::spawn(bridge_task(app.clone(), listener, vnc, token.clone(), id));
    bridges.insert(id, task);
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
    let run = async {
        let accepted = tokio::time::timeout(ACCEPT_TIMEOUT, listener.accept()).await;
        let ws_stream = match accepted {
            Ok(Ok((stream, _))) => stream,
            _ => return,
        };
        let expected_path = format!("/vnc-{token}");
        let ws = tokio_tungstenite::accept_hdr_async(
            ws_stream,
            move |req: &Request, res: Response| {
                if req.uri().path() == expected_path {
                    Ok(res)
                } else {
                    let mut err = ErrorResponse::new(None);
                    *err.status_mut() = StatusCode::NOT_FOUND;
                    Err(err)
                }
            },
        )
        .await;
        let Ok(ws) = ws else { return };
        pipe(vnc, ws).await;
    };
    run.await;
    let _ = app.state::<VncBridges>().remove(id);
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
                    if ws_sink
                        .send(Message::Binary(buf[..n].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = ws_sink.send(Message::Close(None)).await;
    };
    let to_tcp = async {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(bytes)) => {
                    if tcp_tx.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        let _ = tcp_tx.shutdown().await;
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

    /// A black-holed target must fail within the bound, not the OS's ~75s.
    /// 10.255.255.1 is unroutable on most networks; if the sandbox rejects it
    /// instantly instead, the error is still "can't reach", so accept either.
    #[tokio::test]
    async fn dial_gives_up_within_the_bound() {
        let started = std::time::Instant::now();
        let err = dial_within("10.255.255.1", 5900, Duration::from_millis(300))
            .await
            .expect_err("dial should not succeed");
        assert!(err.starts_with("can't reach 10.255.255.1:5900 - "), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
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
}
