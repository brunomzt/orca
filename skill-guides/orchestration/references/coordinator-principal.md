# Terminal-less coordinator principals (gated)

Use this reference only when an explicitly authorized coordinator-principal
workflow is being prepared or operated. It does not change the normal terminal
coordinator route. Source command availability does not establish live support.

Before any principal operation, `ORCA status --json` must advertise
`orchestration.coordinator-principal.v1`, `orchestration.intake-closed.v1` and
`orchestration.launch-speed.v1`. Otherwise report `incompatible_runtime` and
preserve the existing Run; do not fall back to guessed terminal authority.

Use `principal-create --help` for initial identity and capability-file arguments.
The provider's manager session ID is separate from its root path. The root must
be an exact registered local Git or folder workspace. Principal v1 refuses SSH,
WSL and paired routing.

Shared calls pass `--principal`, `--run` and `--capability-file` together;
mutations also pass `--expected-generation`. Set
`ORCA_COORDINATOR_ROUTING=principal` and scrub terminal, pane and agent-session
caller stamps. Never put a capability's contents in prompts, argv, logs or
receipts. Use only its private absolute file path.

Create and rotation write a pending file before sending. Preserve it after a
timeout and retry the original request with `--retry-request`. Rotation uses a
different `--new-capability-file`; keep the old file until the new file is
committed. A changed request with the same ID is refused.

Reconnect a healthy retained child with `principal-reconnect`. For definitive
loss, enter `principal-recovering` before `principal-replace --reason loss`.
Replacement fences the old generation and returns a resume snapshot. Existing
workers retain their Dispatch authority. Neither a timeout nor absent telemetry
proves loss.

Consume the Run inbox with bounded 45-second `check --wait` calls and an outer
timeout of at least 60 seconds. Process before acknowledging; preserve FIFO
delivery replay. There is no PTY wake for a principal Run.

Worker placement must name an exact `id:` task workspace outside the coordinator home,
or `new-top-level` plus its exact `id:` repository. Omitted placement, `current`,
`active` and `new-child` are refused. Pass `--speed standard`; verify returned
speed enforcement before product work. Requested values do not prove applied
values. Null applied speed is allowed only with positively verified current
fast-off enforcement. Unsupported, unverified, stale, conflicting or known-fast
evidence refuses admission. Preserve the failed attempt and its cleanup receipt.

Retirement is explicit: `principal-retire --request` closes intake, then
`principal-retire` succeeds only after all Tasks, Dispatches, mail, questions,
gates and reclaimable resources settle. Retirement intent survives reconnect
and replacement. Retired show and same-generation retire replay are id-only,
read-only operations.
