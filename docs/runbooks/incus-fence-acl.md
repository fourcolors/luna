# Runbook: Incus fence ACL — container not reaching host services

## Symptom chain

1. Luna container is not responding to WebSocket clients.
2. Inside the container, `journalctl -u luna-<profile>-chat-server` shows repeated `EmbedderError: connection refused` (or similar Ollama connect failures).
3. The container cannot reach the host's Ollama service (port 11434 on the gateway).

## Root cause

The container is protected by a bridge-isolation ACL ("fence ACL") that is supposed to block bridge peers while allowing the default gateway. However, the ACL has a broad `reject` destination that **includes the gateway of the bridge the ACL is attached to**. Because the firewall backend (nftables via incus) evaluates the broad `reject` rule before the narrow `allow gateway` rule, all container→gateway traffic is dropped — including Ollama on port 11434.

### Why does rule ordering matter?

Incus translates ACL egress rules into nftables chains. The backend can emit the `reject` rule before the `allow` rule regardless of the order they appear in the ACL YAML. A `/24` reject destination like `10.77.0.0/24` covers `.1` (the gateway), so the allow-gateway rule is never reached.

### Bad ACL (gateway inside the reject range)

```
egress:
  - action: allow
    destination: 10.77.0.1/32   # <-- intended to allow gateway
    state: enabled
  - action: reject
    destination: 10.77.0.0/24   # <-- COVERS .1 — kills gateway traffic
    state: enabled
```

### Good ACL (gateway carved out of the reject range)

```
egress:
  - action: allow
    destination: 10.77.0.1/32   # allow gateway explicitly
    state: enabled
  - action: reject
    destination: 10.77.0.2-10.77.0.254   # reject ONLY peers, never the gateway
    state: enabled
```

The `reject` destination uses a range (`A.B.C.2-A.B.C.254`) instead of the full subnet CIDR, so the gateway at `.1` is never inside any reject rule. Rule ordering becomes irrelevant.

### Cross-bridge fence ACLs are correct by design

A fence ACL attached to bridge `runnerbr0` (gateway `10.66.0.1`) that rejects `10.77.0.0/24` (a different bridge's subnet) is **not** a problem. The invariant is: a fence must not reject the gateway of **the bridge it is attached to**. Rejecting addresses on other bridges is the intended cross-bridge isolation behaviour.

## Diagnosis steps

### 1. Check the ACL definition

```bash
incus network acl show <container>-fence
```

Look at the `egress:` section. If any `action: reject` entry has a `destination` that is a CIDR covering the ACL's own bridge gateway IP (or a range that includes it), this is the problem.

### 2. Test container→gateway connectivity

```bash
incus exec <container> -- curl -s --max-time 3 http://<gateway>:11434/
```

If this hangs or returns `Connection refused` and you know Ollama is running on the gateway, the fence ACL is blocking the traffic.

### 3. Run luna-doctor

```bash
scripts/luna-doctor <profile>
```

If `LUNA_EMBEDDER=ollama` is configured, luna-doctor probes the Ollama URL and reports:

```
[doctor:<profile>] FAIL: embedder unreachable: http://<gateway>:11434
  If this is a fenced container, the fence ACL may have the
  gateway inside its reject set; see docs/runbooks/incus-fence-acl.md
```

### 4. Run the harness probe

```bash
bash seeds/harness-corpus/probes/060-incus-fence-acl-gateway-guard.sh
```

- `OK` — all fence ACLs have reject destinations that exclude the gateway of the bridge they are attached to.
- `DRIFT` — a reject destination covers the ACL's own bridge gateway. The probe prints the ACL name, bridge, and destination.
- `SKIP` — incus is absent, no fence ACLs exist, or no fence ACL has a resolvable network-level or instance-NIC-level bridge attachment.

## Fix

**Delete the bad ACL first.**
`luna-container-create --fence` is idempotent at the ACL level: when an ACL with the target name already exists it is reused AS-IS (with a warning) — its rules are never verified or rewritten.
Re-running `--fence` over a bad ACL therefore fixes nothing.
Detach and delete the existing ACL, then re-run:

```bash
incus config device set <container> eth0 security.acls=   # detach (delete fails while attached)
incus network acl delete <container>-fence
```

Then recreate the fence ACL using `luna-container-create --fence`. The script auto-detects the bridge gateway and derives a reject range that excludes it:

```bash
scripts/luna-container-create \
  --name <container> \
  --profile <profile> \
  --fence \
  [--fence-bridge incusbr0] \
  [--fence-gateway <ip>/<prefix>]   # optional: override auto-detection
```

The `--fence` flag is **off by default** to avoid changing behaviour for existing callers. Set `LUNA_FENCE=true` to enable it from the environment.

### What the script derives

Given `incus network get incusbr0 ipv4.address` → `10.77.0.1/24`:

- Gateway IP: `10.77.0.1`
- First usable host: `10.77.0.1` (= gateway)
- Reject range: `10.77.0.2-10.77.0.254` (all usable hosts except the gateway)

The derivation uses integer arithmetic on the four octets; it handles any prefix from `/1` to `/30`. `/31` and `/32` are rejected with a clear error (no usable peer host range).

### Manual fix (if you cannot re-run the script)

```bash
# Detach the ACL from the container NIC (delete fails while it is in use)
incus config device set <container> eth0 security.acls=

# Delete the bad ACL
incus network acl delete <container>-fence

# Recreate with the correct range
incus network acl create <container>-fence
incus network acl rule add <container>-fence egress \
  action=allow destination=<gateway>/32 state=enabled description="allow gateway"
incus network acl rule add <container>-fence egress \
  action=reject destination=<first-peer>-<last-peer> state=enabled description="reject bridge peers"

# Re-attach to the container NIC
incus config device set <container> eth0 security.acls=<container>-fence
```

Replace `<gateway>`, `<first-peer>`, and `<last-peer>` with the values for your bridge (example: `10.77.0.1`, `10.77.0.2`, `10.77.0.254`).

## Related

- `scripts/luna-container-create --fence` — creates the ACL correctly by construction.
- `seeds/harness-corpus/probes/060-incus-fence-acl-gateway-guard.sh` — CI probe that catches regressions.
- `scripts/luna-doctor` — runtime check that reports embedder unreachability with a pointer to this runbook.
- `seeds/harness-corpus/probes/040-incus-nftables-guard.sh` — guards the underlying nftables prerequisites.
