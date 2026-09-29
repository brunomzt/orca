# Codex shared server and local tab cleanup

Codex 0.158.0 can launch a shared managed app-server in its own process group
while retaining the launching terminal as an ancestor. Closing that terminal
previously included the shared server in Orca's descendant cleanup, disconnecting
other Codex clients.

Local POSIX terminal cleanup now stops its traversal at a managed Codex server
or its PID updater. Their descendants never enter the initial cleanup snapshot
or its delayed forced-kill list. Other terminal descendants still receive normal
cleanup. Windows and remote-host cleanup are outside this change.

Command arguments identify candidates; a bounded, independent executable read
rejects known shell wrappers. Missing or stale evidence preserves the candidate
branch. Tab close continues. PID records from package-derived account homes,
configured homes, and the default home corroborate the diagnostic only. A
`record-matched` log means PID and start-time matching, not verification of the
kernel identity or executable digest. Missing records produce `unverifiable`.

## Cleanup tradeoff

Shell commands running under the shared server can survive closing a Codex tab.
Cancel those commands through Codex. Closing the tab is not a cancellation API
for work owned by the shared server.

## Evidence and limits

On macOS, an isolated Codex 0.158.0 server with a fresh unauthenticated home and
Unix socket was launched beneath a disposable owner alongside an ordinary sleep
process. Two WebSocket clients initialized and requested `thread/list`.

| After owner cleanup                    | Previous behavior | Protected behavior |
| -------------------------------------- | ----------------- | ------------------ |
| Owner stopped                          | Yes               | Yes                |
| Ordinary child stopped                 | Yes               | Yes                |
| Same shared server alive               | No                | Yes                |
| Second client answered another request | No                | Yes                |

The experiment exercised the production cleanup functions and actual Codex
transport. It did not exercise an authenticated model turn or the complete Orca
UI lifecycle. Scoped automated tests cover traversal, forced cleanup, command
classification, executable evidence, stale records, and existing teardown paths.

The underlying Codex fix would fully detach its shared server from the launching
terminal's process ancestry. This Orca protection is a local workaround until
that lifecycle behavior changes. Installing a rebuilt Orca is a separate rollout
step; a source change alone does not protect already running Orca code.
