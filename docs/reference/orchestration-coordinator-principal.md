# Coordinator principals

This implementation is gated. The runtime does not yet advertise the principal,
intake or launch-speed capabilities. Their presence in source is not permission
to activate hybrid coordination. Live acceptance for both providers is required.

## Identity and authority

A coordinator principal owns one retained Run without a terminal, pane or Orca
agent-session identity. It records the provider, manager's provider session ID,
native child ID, project, registered local root and generation. The manager
session ID is an identity; the root path is a separate location.

The CLI requires the server to advertise all of:

- `orchestration.coordinator-principal.v1`
- `orchestration.intake-closed.v1`
- `orchestration.launch-speed.v1`

Principal v1 is same-host only. SSH, WSL and paired clients refuse principal
routing. Existing terminal and remote worker routing retains its own contract.
Both Git worktrees and registered folder workspaces may be principal roots.

## Capability files

`principal-create` writes a pending private capability file before sending the
request. Use an absolute destination in an existing private directory owned by
the current user. The file contains a randomly generated secret and is bound to
the runtime ID. The server stores its SHA-256 hash. The secret travels only in
the RPC principal envelope, never in params, arguments, output or receipts.

Creation refuses an existing destination unless `--retry-request` matches the
file's original request. After an uncertain result, preserve that pending file
and repeat the original arguments with its request ID. Do not create a second
capability to retry the same operation. A successful response promotes the file
to committed state after checking the principal identity and generation.

Replacement requires `--new-capability-file` at a distinct canonical path. Keep
the old file until the new file has been committed. The server's rotation journal
matches the entire request fingerprint; the old capability authenticates only
that exact committed replay, including after subsequent rotations. A replay
returns the original receipt and resume snapshot without repeating effects.

## Commands

Use each command's `--help` for the complete arguments. Shared principal calls
require `--principal`, `--run` and `--capability-file`. Mutations additionally
require `--expected-generation`. Set `ORCA_COORDINATOR_ROUTING=principal` and
remove terminal, pane and agent-session caller stamps. Mixed identities fail
with `ambiguous_coordinator_routing`; missing flags never select a terminal.

| Command | Operation |
| --- | --- |
| `principal-create` | Create a principal and retained Run using `--speed standard` |
| `principal-show` | Inspect identity, state and retirement blockers |
| `principal-reconnect` | Confirm the same provider, manager and child; obtain a resume snapshot |
| `principal-recovering` | Close admission while reconciling child loss |
| `principal-replace` | Rotate capability and increment generation after recovering, with `--reason loss` |
| `run-intake --close` / `--open` | Change intake under the expected generation |
| `principal-retire --request` | Record retirement intent and close intake |
| `principal-retire` | Retire only after all blockers have settled |

Retirement intent survives recovery and replacement. Reopening intake cannot
override that intent. Retired principals support id-only show and a same-generation
no-effect retire replay; they have no live capability.

## Mail and placement

The principal consumes its Run's FIFO mailbox with `check --wait --timeout-ms
45000`. Keep the outer transport timeout at least 60 seconds. Process a delivery
before acknowledging it; an unacknowledged batch replays. Replacement fences
in-flight waits. Principal Runs do not send PTY wakeups.

Workers require an exact `id:` task workspace outside the coordinator home.
`current`, `active`, omitted placement and `new-child` are refused. Creation uses
`new-top-level` with an exact `id:` target repository. Remote and WSL targets are
refused before resource creation. Existing folder workspaces
are valid placements; folder repositories cannot create Git worktrees. Task and
Dispatch admission check intake and generation inside their database transaction.

## Speed evidence

Requested standard speed and observed applied speed are separate. Unknown
applied speed remains null. Admission requires current request-, phase- and
provider-process-bound evidence with an unexpired validity interval.

Codex reads managed `featureRequirements.fast_mode=false` and config layers on
the current app-server connection. Launch flags alone are source-indicated.
Claude requires its per-launch `CLAUDE_CODE_DISABLE_FAST_MODE=1`, the provider's
`off` / `disabled_by_env` observation, and a current settings read showing fast
off with no enabling layer. Provider reports determine the applied tier.

Observed fast mode is persisted for structured orchestration sessions. Later
option writes cannot clear it, and subsequent turns refuse it. Failure receipts
include the speed code, ordered reasons and available evidence. Refusal order is
fast observed, conflicting override, unsupported control, stale evidence, then
unverified enforcement.

Terminal mode and remote speed enforcement currently refuse as unsupported.
Fresh exact-model catalog evidence, complete phase/inheritance integration and
live acceptance remain required before capability advertisement.
