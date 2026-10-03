import type { CoordinatorPrincipalRow } from './coordinator-principal-row'
import { OrchestrationError } from '../../orchestration-error'
import {
  ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES,
  type CoordinatorPrincipalView
} from '../../../../../shared/orchestration-principal-contract'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { OrchestrationDb } from '../orchestration-db'
import {
  assertPrincipalCasApplied,
  principalError,
  principalViewOf,
  requireWritablePrincipal,
  type PrincipalWriteTarget
} from './principal-row'

/** The lifecycle a live principal returns to; retirement intent is never dropped (correction 6). */
export const RESUMED_LIFECYCLE_SQL = `CASE WHEN retirement_requested_at IS NULL
  THEN 'active' ELSE 'retirement-requested' END`

export function currentPrincipalView(
  db: OrchestrationDb,
  principalId: string
): CoordinatorPrincipalView {
  const row = db.getCoordinatorPrincipalRow(principalId)
  if (!row) {
    throw new OrchestrationError('runtime_error', `Coordinator principal ${principalId} vanished.`)
  }
  return principalViewOf(db, row)
}

/** Names the identity fields that differ; never their values, which include session ids. */
function mismatchedIdentityFields(
  row: CoordinatorPrincipalRow,
  identity: { provider: string; managerSessionId: string; childId: string }
): string[] {
  const fields: string[] = []
  if (identity.provider !== row.provider) {
    fields.push('provider')
  }
  if (identity.managerSessionId !== row.manager_session_id) {
    fields.push('managerSessionId')
  }
  if (identity.childId !== row.child_id) {
    fields.push('childId')
  }
  return fields
}

/**
 * Same-generation reattachment of the SAME native child. A different identity is refused before
 * any write; replacing the child is `replacePrincipal`, which fences a new generation.
 */
export function reconnectPrincipal(
  this: OrchestrationDb,
  params: PrincipalWriteTarget & { provider: string; managerSessionId: string; childId: string }
): { principal: CoordinatorPrincipalView } {
  return runLifecycleWriteTransaction(this.db, 'reconnect_coordinator_principal', () => {
    const row = requireWritablePrincipal(this, params)
    const fields = mismatchedIdentityFields(row, params)
    if (fields.length > 0) {
      throw principalError(
        CODES.identityMismatch,
        `Coordinator principal ${row.id} has a different ${fields.join(', ')} at generation ${row.generation}.`,
        { fields }
      )
    }
    if (row.lifecycle === 'recovering') {
      const result = this.db
        .prepare(
          `UPDATE coordinator_principals
           SET lifecycle = ${RESUMED_LIFECYCLE_SQL}, recovering_reason = NULL,
               updated_at = datetime('now')
           WHERE id = ? AND generation = ? AND lifecycle = 'recovering'`
        )
        .run(row.id, row.generation)
      assertPrincipalCasApplied(result.changes, row.id)
    }
    return { principal: currentPrincipalView(this, row.id) }
  })
}

/** Records that the child may be lost; keeps the generation, capability and retirement intent. */
export function markPrincipalRecovering(
  this: OrchestrationDb,
  params: PrincipalWriteTarget & { reason?: string }
): { principal: CoordinatorPrincipalView } {
  return runLifecycleWriteTransaction(this.db, 'mark_coordinator_principal_recovering', () => {
    const row = requireWritablePrincipal(this, params)
    const result = this.db
      .prepare(
        `UPDATE coordinator_principals
         SET lifecycle = 'recovering', recovering_reason = ?, updated_at = datetime('now')
         WHERE id = ? AND generation = ? AND lifecycle <> 'retired'`
      )
      .run(params.reason ?? row.recovering_reason, row.id, row.generation)
    assertPrincipalCasApplied(result.changes, row.id)
    return { principal: currentPrincipalView(this, row.id) }
  })
}

/** Pauses or resumes admission of new Tasks and Dispatches on the principal's Run. */
export function setRunIntake(
  this: OrchestrationDb,
  params: PrincipalWriteTarget & { closed: boolean }
): { runId: string; intakeClosed: boolean; principal: CoordinatorPrincipalView } {
  return runLifecycleWriteTransaction(this.db, 'set_coordinator_run_intake', () => {
    const row = requireWritablePrincipal(this, params)
    if (!params.closed && row.retirement_requested_at !== null) {
      throw principalError(
        CODES.retirementRequested,
        `Run ${row.run_id} is draining for retirement; its intake stays closed.`
      )
    }
    // Touch the principal under CAS so a concurrent rotation cannot interleave with this write.
    const cas = this.db
      .prepare(
        `UPDATE coordinator_principals SET updated_at = datetime('now')
         WHERE id = ? AND generation = ? AND lifecycle <> 'retired'`
      )
      .run(row.id, row.generation)
    assertPrincipalCasApplied(cas.changes, row.id)
    this.db
      .prepare(`UPDATE runs SET intake_closed = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(params.closed ? 1 : 0, row.run_id)
    return {
      runId: row.run_id,
      intakeClosed: params.closed,
      principal: currentPrincipalView(this, row.id)
    }
  })
}

export type PrincipalStoreMethods = {
  reconnectPrincipal: typeof reconnectPrincipal
  markPrincipalRecovering: typeof markPrincipalRecovering
  setRunIntake: typeof setRunIntake
}

export function attachPrincipalStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { reconnectPrincipal, markPrincipalRecovering, setRunIntake })
}
