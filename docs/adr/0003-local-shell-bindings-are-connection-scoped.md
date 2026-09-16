# 0003: Local shell bindings are client-scoped and addressable, not a per-thread exclusive slot

Status: Accepted

## Context

`local_shell_run` is the most-called tool in this system; single sessions record 1,184 and 856 invocations. The binding behind it held exactly one client per thread in a `Map<threadId, RegisteredClient>`, and refused a second client unless the incumbent had advertised `replaceable: true`. The server's in-process container sandbox was the only sender of that flag and the Moon desktop client never sent it, so the precedence was one-way and permanent: Moon could take the slot from the container at any time, and the container could never reclaim it.

Both ends were deaf to the refusal. The sandbox called `setCapability` in-process and discarded the returned status; Moon registered a handler for `local-shell-request` and none for `local-shell-status`, and its dispatcher drops unregistered frame types. A refused attach therefore reached nobody, which is why asking the wrong machine surfaced only as `No such file or directory` — indistinguishable from the path being absent. A craft skill exists solely to detect that condition from symptoms, and roughly 43% of sessions that call `list_roots` at all call it more than once mid-session, re-checking defensively. Stage 1 (#644) made the binding legible: every result now names the machine that served it, and refusals are logged and surfaced. This record covers the arity change itself.

Two premises in the first draft were wrong and both changed the design. The Mac binding did not follow the operator's focus; it **accumulated**. Moon sent a capability frame per active thread and never sent `enabled: false` for the thread it left, and its request handler never compared the incoming `threadId` to the active one, so every thread opened during a Moon connection could run commands on the laptop while the operator looked elsewhere. The retained property was "opened once in this connection", not "in view" — so the exposure this change actually adds is threads *never* opened in Moon, namely forked children and channel-originated threads, where an inbound message is an injection surface. And "Moon" is not one client: every chat window mints its own client id and its own socket, so a second window on the same thread was silently rejected.

The per-thread dimension turned out to be an artifact rather than a requirement. Moon's shell scope is application-global and the sandbox's is decided once at boot and identical for every thread, making its per-thread client id pure ceremony; only the CLI is genuinely per-thread, and one CLI serves one thread regardless. Keeping a thread in the key preserved exactly the artifact that generated the handoff machinery: `sandboxReattachers`, `onLocalShellRelease`, and a map that grew one retained closure per thread that had ever existed.

## Decision

Bindings are keyed by **client**. `threadId` becomes optional on the capability frame: absent means the client serves any thread on its connection, present pins it to one thread and preserves the CLI's behaviour unchanged. The sandbox registers once at boot and Moon registers once per connection on `hello`, which deletes the per-thread attach, the reattach closures, the release callback with its teardown and disable paths, and the leak, in a single move. Registering never displaces anyone; `replaceable` is dead.

Targets are addressed by a human **label** (a host name, or the server profile for the sandbox), never by the opaque per-connection client id. Several live clients may share a label and the newest serves, with fallback on disconnect, so a reconnect or a second window is no longer a lockout.

There is **no default target**. With one attached the tool resolves to it and names it; with more than one, `target` is required and omitting it is an error listing the labels; a named-but-absent target is an error and never falls back. Every candidate default rule was either the silent reassignment this record exists to remove or a foot-gun for a command that omits a working directory.

The Mac is gated on **thread origin**, not operator focus: a non-sandbox client is not resolvable at all for threads tagged `forked-from-parent` or `channel`, and the client re-checks the same tags itself rather than trusting the server, because the client owns the actual machine. Result acceptance takes the responder's identity from the connection's registered client set and never from the frame, so one attached machine cannot answer another's pending command. Moon stops advertising `/` as its working directory, and the smart bar resolves its git directory to the sandbox target, since every other target's roots are paths on somebody else's machine.

## Consequences

Easier: one thread reasons across both machines; a wrong-host result identifies itself; reconnects and second windows work; background jobs and unopened threads can reach the sandbox; and a substantial amount of lifecycle code is deleted rather than carried forward.

Harder: the one-client-per-thread invariant was load-bearing in the suite, so the bridge's "registers one client per thread" and replaceable-replacement assertions invert, two server tests disappear entirely, and the tool tests change shape. Four client implementations must keep working across the change. `local_shell_list_roots` returns a different object than before, and any caller reading `roots` off it directly must move to `targets`.

Risk: without the origin gate this change would hand unattended jobs a full-access shell on the operator's laptop. The gate is therefore not optional, and it is enforced twice. Note that coexistence itself grants no capability the desktop client did not already have; what it removes is the human action that used to sit between reading from one machine and writing to the other.

Deferred: per-target approval policy, whether full access should differ per target, and a prompt mode for unattended origins.
