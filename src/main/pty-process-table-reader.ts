import type { ProcessTableRow } from './pty-process-table-parser'

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = (timeoutMs?: number) => Promise<ProcessTableCapture>
/** Coalesces same-turn teardown bursts but never serves a completed or already
 * started scan to a later request, because stale PIDs are unsafe to signal. */
export function createProcessTableSnapshotReader(
  readFresh: ProcessTableReader
): ProcessTableReader {
  let queued: { promise: Promise<ProcessTableCapture>; started: boolean } | null = null

  return (timeoutMs) => {
    if (queued && !queued.started) {
      return queued.promise
    }

    const entry: { promise: Promise<ProcessTableCapture>; started: boolean } = {
      promise: Promise.resolve(undefined as never),
      started: false
    }
    entry.promise = Promise.resolve().then(() => {
      // Why: a later caller's deadline starts when it requests a fresh table.
      // Waiting behind an older scan can consume that entire budget, then run
      // this subprocess after nobody can use its result.
      entry.started = true
      return readFresh(timeoutMs)
    })
    queued = entry
    const clearQueued = (): void => {
      if (queued === entry) {
        queued = null
      }
    }
    void entry.promise.then(clearQueued, clearQueued)
    return entry.promise
  }
}
