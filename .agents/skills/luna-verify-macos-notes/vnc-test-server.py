#!/usr/bin/env python3
"""Minimal RFB 3.8 server for testing the Luna VNC widget.

- :5900 raw TCP RFB (security type 1 = None) for the Rust bridge path.
- :5910 WebSocket-fronted RFB for direct-browser testing (ws:// URL field).

Draws an animated test pattern; a magenta cross follows pointer events and
turns green while a button is held — visible proof input round-tripped.
Key events are logged (and shift the pattern hue) to prove keyboard input.
"""
import base64
import hashlib
import socket
import struct
import sys
import threading
import time

W, H = 640, 480
POINTER = {"x": W // 2, "y": H // 2, "down": False}
HUE_SHIFT = [0]
LOG_LOCK = threading.Lock()


def log(msg):
    with LOG_LOCK:
        print(msg, flush=True)


def pixel_frame(t):
    px, py, down = POINTER["x"], POINTER["y"], POINTER["down"]
    shift = HUE_SHIFT[0]
    buf = bytearray()
    for y in range(H):
        row = y * 255 // H
        for x in range(W):
            r = (x + t * 4 + shift) % 256
            g = row
            b = 200 if (x // 40 + y // 40) % 2 == 0 else 90
            buf += struct.pack("BBBB", b, g, r, 0)  # little-endian BGRX
    # pointer crosshair: 21px magenta/green cross
    color = (0, 255, 0) if down else (255, 0, 255)
    cr, cg, cb = color
    for d in range(-10, 11):
        for xx, yy in ((px + d, py), (px, py + d)):
            if 0 <= xx < W and 0 <= yy < H:
                i = (yy * W + xx) * 4
                buf[i:i+4] = struct.pack("BBBB", cb, cg, cr, 0)
    return bytes(buf)


PIXEL_FORMAT = struct.pack(
    ">BBBBHHHBBBxxx",
    32,      # bits-per-pixel
    24,      # depth
    0,       # big-endian flag
    1,       # true-colour flag
    255, 255, 255,  # red/green/blue max
    16, 8, 0,       # red/green/blue shift
)


def recvn(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def send_update(sock, t):
    frame = pixel_frame(t)
    rect = struct.pack(">HHHHi", 0, 0, W, H, 0)  # Raw encoding
    header = struct.pack(">BxH", 0, 1)
    sock.sendall(header + rect + frame)


def rfb_session(sock):
    """Run one RFB session on an already-connected socket (no WS framing)."""
    sock.sendall(b"RFB 003.008\n")
    recvn(sock, 12)
    sock.sendall(struct.pack(">BB", 1, 1))  # one security type: None(1)
    recvn(sock, 1)                          # client choice
    sock.sendall(struct.pack(">I", 0))      # security result OK
    shared = recvn(sock, 1)                 # ClientInit
    name = b"luna-test-vnc"
    sock.sendall(struct.pack(">HH", W, H) + PIXEL_FORMAT +
                 struct.pack(">I", len(name)) + name)
    log("rfb: session init complete")
    t0 = time.time()
    sock.settimeout(0.05)
    while True:
        t = int((time.time() - t0) * 20)
        try:
            send_update(sock, t)
        except OSError:
            return
        # drain client messages for ~120ms
        end = time.time() + 0.12
        while time.time() < end:
            try:
                mtype = sock.recv(1)
            except socket.timeout:
                continue
            except OSError:
                return
            if not mtype:
                return
            mt = mtype[0]
            try:
                if mt == 0:      # SetPixelFormat
                    recvn(sock, 3 + 16)
                elif mt == 1:    # FixColourMapEntries
                    d = recvn(sock, 5)
                    recvn(sock, struct.unpack(">xH", d[3:])[0] * 6)
                elif mt == 2:    # SetEncodings
                    d = recvn(sock, 3)
                    n = struct.unpack(">xH", d)[0]
                    recvn(sock, n * 4)
                elif mt == 3:    # FramebufferUpdateRequest — pushed anyway
                    recvn(sock, 9)
                elif mt == 4:    # KeyEvent
                    d = recvn(sock, 7)
                    down, key = d[0], struct.unpack(">I", d[3:])[0]
                    if down:
                        HUE_SHIFT[0] = (HUE_SHIFT[0] + 17) % 256
                    log(f"rfb: KeyEvent keysym={key:#x} down={down}")
                elif mt == 5:    # PointerEvent
                    d = recvn(sock, 5)
                    mask = d[0]
                    x, y = struct.unpack(">HH", d[1:5])
                    POINTER["x"], POINTER["y"], POINTER["down"] = x, y, bool(mask & 1)
                    log(f"rfb: PointerEvent x={x} y={y} mask={mask:#x}")
                elif mt == 6:    # ClientCutText
                    d = recvn(sock, 7)
                    recvn(sock, struct.unpack(">I", d[3:])[0])
                else:
                    log(f"rfb: unknown msg type {mt}, dropping session")
                    return
            except socket.timeout:
                continue


# ---- minimal WebSocket wrapper -------------------------------------------

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def ws_handshake(sock):
    req = b""
    while b"\r\n\r\n" not in req:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("closed")
        req += chunk
    key = ""
    wants_binary = False
    for line in req.split(b"\r\n"):
        low = line.lower()
        if low.startswith(b"sec-websocket-key:"):
            key = line.split(b":", 1)[1].strip().decode()
        elif low.startswith(b"sec-websocket-protocol:"):
            wants_binary = b"binary" in line
    accept = base64.b64encode(
        hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
    resp = ("HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n")
    if wants_binary:
        resp += "Sec-WebSocket-Protocol: binary\r\n"
    sock.sendall((resp + "\r\n").encode())


def ws_send(sock, payload):
    n = len(payload)
    if n < 126:
        hdr = struct.pack(">BB", 0x82, n)
    elif n < 65536:
        hdr = struct.pack(">BBH", 0x82, 126, n)
    else:
        hdr = struct.pack(">BBQ", 0x82, 127, n)
    sock.sendall(hdr + payload)


def ws_recv(sock):
    hdr = recvn(sock, 2)
    opcode = hdr[0] & 0x0F
    masked = hdr[1] & 0x80
    ln = hdr[1] & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", recvn(sock, 2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", recvn(sock, 8))[0]
    mask = recvn(sock, 4) if masked else b"\x00" * 4
    data = bytearray(recvn(sock, ln))
    for i in range(ln):
        data[i] ^= mask[i % 4]
    if opcode == 8:
        raise ConnectionError("ws close")
    return bytes(data) if opcode == 2 else b""


def ws_session(sock):
    """WebSocket front-end: pipe ws frames <-> the raw RFB listener on :5900."""
    ws_handshake(sock)
    tcp = socket.create_connection(("127.0.0.1", 5900))
    log("ws: bridged ws client -> tcp :5900")

    def to_ws():
        try:
            while True:
                data = tcp.recv(65536)
                if not data:
                    break
                ws_send(sock, data)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    threading.Thread(target=to_ws, daemon=True).start()
    try:
        while True:
            data = ws_recv(sock)
            if data:
                tcp.sendall(data)
    finally:
        tcp.close()


def listen(port, handler, label):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(8)
    log(f"{label}: listening on 127.0.0.1:{port}")
    while True:
        client, addr = srv.accept()
        log(f"{label}: connection from {addr}")
        threading.Thread(target=lambda: _run(handler, client), daemon=True).start()


def _run(handler, client):
    try:
        handler(client)
    except (ConnectionError, OSError) as e:
        log(f"session ended: {e}")
    finally:
        try:
            client.close()
        except OSError:
            pass


if __name__ == "__main__":
    threading.Thread(target=listen, args=(5900, rfb_session, "rfb"), daemon=True).start()
    threading.Thread(target=listen, args=(5910, ws_session, "ws"), daemon=True).start()
    while True:
        time.sleep(3600)
