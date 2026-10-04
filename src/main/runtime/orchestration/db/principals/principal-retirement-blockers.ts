import type {
  CoordinatorPrincipalRetirementBlocker,
  CoordinatorPrincipalRetirementBlockerKind
} from '../../../../../shared/orchestration-principal-contract'
import type { OrchestrationDb } from '../orchestration-db'

// Each query yields (id, status) for one blocker kind, all bound to the Run id; the mail queries
// read the Run mailbox address instead.
const BLOCKER_QUERIES: readonly {
  kind: CoordinatorPrincipalRetirementBlockerKind
  sql: string
  mailbox?: true
}[] = [
  {
    kind: 'unfinished_task',
    sql: `SELECT id, status FROM tasks
          WHERE run_id = ? AND status IN ('pending', 'ready', 'dispatched', 'blocked')`
  },
  {
    kind: 'pending_dispatch',
    sql: `SELECT id, status FROM dispatch_contexts
          WHERE run_id = ? AND status IN ('pending', 'dispatched')`
  },
  {
    kind: 'unknown_dispatch',
    sql: `SELECT worker.dispatch_id AS id, worker.state AS status
          FROM worker_dispatches worker
          JOIN dispatch_contexts dispatch ON dispatch.id = worker.dispatch_id
          WHERE dispatch.run_id = ?
            AND worker.state IN ('starting', 'start_unknown', 'stopping', 'stop_unknown')`
  },
  {
    kind: 'unacked_mail',
    mailbox: true,
    sql: `SELECT id, status FROM outstanding_deliveries WHERE mailbox_handle = ?`
  },
  {
    kind: 'unacked_mail',
    mailbox: true,
    sql: `SELECT id, 'unread' AS status FROM messages WHERE to_handle = ? AND read = 0`
  },
  {
    kind: 'pending_question',
    sql: `SELECT message_id AS id, status FROM question_threads
          WHERE run_id = ? AND status = 'pending'`
  },
  {
    kind: 'pending_gate',
    sql: `SELECT id, status FROM decision_gates WHERE run_id = ? AND status = 'pending'`
  },
  {
    kind: 'reclaimable_resource',
    sql: `SELECT resource.id AS id, resource.release_state AS status
          FROM worker_terminal_resources resource
          JOIN dispatch_contexts dispatch ON dispatch.id = resource.owner_dispatch_id
          WHERE dispatch.run_id = ?
            AND resource.ownership_state NOT IN ('user_owned', 'external', 'released')
            AND resource.release_state NOT IN ('released', 'retained')`
  }
]

/** Everything that must drain before a principal's Run may retire, in a stable kind order. */
export function listPrincipalRetirementBlockers(
  this: OrchestrationDb,
  runId: string
): CoordinatorPrincipalRetirementBlocker[] {
  const blockers: CoordinatorPrincipalRetirementBlocker[] = []
  for (const query of BLOCKER_QUERIES) {
    const rows = this.db.prepare(query.sql).all(query.mailbox ? `run:${runId}` : runId)
    for (const row of rows) {
      blockers.push({ kind: query.kind, id: String(row.id), status: String(row.status) })
    }
  }
  return blockers
}

export type PrincipalRetirementBlockersMethods = {
  listPrincipalRetirementBlockers: typeof listPrincipalRetirementBlockers
}

export function attachPrincipalRetirementBlockers(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { listPrincipalRetirementBlockers })
}
