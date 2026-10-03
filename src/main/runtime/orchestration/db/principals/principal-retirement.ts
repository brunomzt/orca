import {
  ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES,
  type CoordinatorPrincipalRetirementBlocker,
  type CoordinatorPrincipalView
} from '../../../../../shared/orchestration-principal-contract'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { OrchestrationDb } from '../orchestration-db'
import {
  assertPrincipalCasApplied,
  principalError,
  requireWritablePrincipal,
  type PrincipalWriteTarget
} from './principal-row'
import { currentPrincipalView } from './principal-store'

export type PrincipalRetireResult = {
  principal: CoordinatorPrincipalView
  retired: boolean
  blockers: CoordinatorPrincipalRetirementBlocker[]
  effectsApplied: boolean
}

const CLOSE_RUN_INTAKE_SQL = `UPDATE runs SET intake_closed = 1, updated_at = datetime('now')
  WHERE id = ?`

/**
 * A replay against an already-retired principal: answered from the id-only retired view with no
 * effects, so it can neither reactivate the principal nor mutate it without a capability.
 */
function retiredReplay(
  db: OrchestrationDb,
  target: PrincipalWriteTarget
): PrincipalRetireResult | undefined {
  const view = db.findRetiredPrincipalView(target.principalId)
  if (!view || view.runId !== target.runId) {
    return undefined
  }
  if (view.generation !== target.expectedGeneration) {
    throw principalError(CODES.retired, `Coordinator principal ${view.id} is retired.`)
  }
  return { principal: view, retired: true, blockers: [], effectsApplied: false }
}

/**
 * `request` records retirement intent and closes intake so the Run drains; without it, retires
 * only once nothing blocks. The Run keeps its principal id, so no terminal can bind it afterwards.
 */
export function retirePrincipal(
  this: OrchestrationDb,
  params: PrincipalWriteTarget & { request?: boolean }
): PrincipalRetireResult {
  return runLifecycleWriteTransaction(this.db, 'retire_coordinator_principal', () => {
    const replay = retiredReplay(this, params)
    if (replay) {
      return replay
    }
    const row = requireWritablePrincipal(this, params)
    const blockers = this.listPrincipalRetirementBlockers(row.run_id)
    if (params.request) {
      // Recovery keeps its lifecycle; the separate intent restores retirement-requested afterwards.
      const result = this.db
        .prepare(
          `UPDATE coordinator_principals
           SET retirement_requested_at = COALESCE(retirement_requested_at, datetime('now')),
               lifecycle = CASE WHEN lifecycle = 'recovering'
                 THEN 'recovering' ELSE 'retirement-requested' END,
               updated_at = datetime('now')
           WHERE id = ? AND generation = ? AND lifecycle <> 'retired'`
        )
        .run(row.id, row.generation)
      assertPrincipalCasApplied(result.changes, row.id)
      this.db.prepare(CLOSE_RUN_INTAKE_SQL).run(row.run_id)
      return {
        principal: currentPrincipalView(this, row.id),
        retired: false,
        blockers,
        effectsApplied: true
      }
    }
    if (blockers.length > 0) {
      throw principalError(
        CODES.retirementBlocked,
        `Coordinator principal ${row.id} still has ${blockers.length} unfinished item(s).`,
        { blockers }
      )
    }
    // The capability hash goes with the active principal; only the id-only retired view remains.
    const result = this.db
      .prepare(
        `UPDATE coordinator_principals
         SET lifecycle = 'retired', capability_hash = NULL, recovering_reason = NULL,
             retirement_requested_at = COALESCE(retirement_requested_at, datetime('now')),
             retired_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND generation = ? AND lifecycle <> 'retired'`
      )
      .run(row.id, row.generation)
    assertPrincipalCasApplied(result.changes, row.id)
    this.db.prepare(CLOSE_RUN_INTAKE_SQL).run(row.run_id)
    return {
      principal: currentPrincipalView(this, row.id),
      retired: true,
      blockers: [],
      effectsApplied: true
    }
  })
}

export type PrincipalRetirementMethods = {
  retirePrincipal: typeof retirePrincipal
}

export function attachPrincipalRetirement(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { retirePrincipal })
}
