import type { CoordinatorPrincipalRow } from './coordinator-principal-row'
import {
  ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES,
  isCoordinatorPrincipalCapabilityHash,
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
import { RESUMED_LIFECYCLE_SQL } from './principal-store'

/** The immutable replacement request; its replay must match every field. */
export type PrincipalReplaceRequest = PrincipalWriteTarget & {
  requestId: string
  reason: string
  childId: string
  capabilityHash: string
}

/** Public receipt; carries no secret or hash. */
export type PrincipalReplaceReceipt = {
  principal: CoordinatorPrincipalView
  fencedGeneration: number
  replayed: boolean
}

/** Private journal row; only the store and replay authentication read the hashes. */
export type PrincipalRotationRecord = {
  principal_id: string
  request_id: string
  run_id: string
  reason: string
  from_generation: number
  to_generation: number
  child_id: string
  previous_capability_hash: string
  capability_hash: string
  receipt: string
}

const ROTATION_SQL = `SELECT principal_id, request_id, run_id, reason, from_generation,
  to_generation, child_id, previous_capability_hash, capability_hash, receipt
  FROM coordinator_principal_rotations WHERE principal_id = ? AND request_id = ?`

export function findPrincipalRotation(
  this: OrchestrationDb,
  principalId: string,
  requestId: string
): PrincipalRotationRecord | undefined {
  const row = this.db.prepare(ROTATION_SQL).get(principalId, requestId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ROTATION_SQL selects exactly PrincipalRotationRecord's NOT NULL columns.
  return row as PrincipalRotationRecord | undefined
}

/** Refuses a reused requestId unless the whole immutable request matches what was committed. */
export function committedReplacementReceipt(
  record: PrincipalRotationRecord,
  request: PrincipalReplaceRequest
): PrincipalReplaceReceipt {
  const matches =
    record.principal_id === request.principalId &&
    record.run_id === request.runId &&
    record.from_generation === request.expectedGeneration &&
    record.reason === request.reason &&
    record.child_id === request.childId &&
    record.capability_hash === request.capabilityHash
  if (!matches) {
    throw principalError(
      'request_mismatch',
      `Replacement request ${request.requestId} was already used with different input.`
    )
  }
  const committed: { principal: CoordinatorPrincipalView; fencedGeneration: number } = JSON.parse(
    record.receipt
  )
  return {
    principal: committed.principal,
    fencedGeneration: committed.fencedGeneration,
    replayed: true
  }
}

// D2: the single place replacement preconditions live.
function assertReplaceable(row: CoordinatorPrincipalRow, request: PrincipalReplaceRequest): void {
  if (request.reason !== 'loss') {
    throw principalError(
      'invalid_argument',
      'Replacement requires reason loss; a model update keeps the same child.'
    )
  }
  if (row.lifecycle !== 'recovering') {
    throw principalError(
      CODES.notRecovering,
      `Coordinator principal ${row.id} must be marked recovering before replacement.`
    )
  }
  if (request.childId.trim() === '' || request.childId === row.child_id) {
    throw principalError('invalid_argument', 'Replacement requires a different native child.')
  }
  if (
    !isCoordinatorPrincipalCapabilityHash(request.capabilityHash) ||
    request.capabilityHash === row.capability_hash
  ) {
    throw principalError(
      CODES.capabilityInvalid,
      'Replacement requires a new lowercase sha256 capability hash.'
    )
  }
}

/**
 * Fenced generation change for a proven-lost child. Worker Dispatch capabilities are untouched;
 * the Run's consumer generation bumps so the lost child's unacknowledged mail replays.
 */
export function replacePrincipal(
  this: OrchestrationDb,
  request: PrincipalReplaceRequest
): PrincipalReplaceReceipt {
  return runLifecycleWriteTransaction(this.db, 'replace_coordinator_principal', () => {
    const committed = this.findPrincipalRotation(request.principalId, request.requestId)
    if (committed) {
      return committedReplacementReceipt(committed, request)
    }
    const row = requireWritablePrincipal(this, request)
    assertReplaceable(row, request)
    const result = this.db
      .prepare(
        `UPDATE coordinator_principals
         SET generation = generation + 1, child_id = ?, capability_hash = ?,
             lifecycle = ${RESUMED_LIFECYCLE_SQL}, recovering_reason = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND generation = ? AND lifecycle = 'recovering'`
      )
      .run(request.childId, request.capabilityHash, row.id, row.generation)
    assertPrincipalCasApplied(result.changes, row.id)
    this.db
      .prepare(
        `UPDATE runs SET consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(row.run_id)
    this.fenceUnacknowledgedMailboxDeliveries(`run:${row.run_id}`)
    const replaced = this.getCoordinatorPrincipalRow(row.id)
    if (!replaced) {
      throw principalError('runtime_error', `Coordinator principal ${row.id} vanished.`)
    }
    const receipt = { principal: principalViewOf(this, replaced), fencedGeneration: row.generation }
    this.db
      .prepare(
        `INSERT INTO coordinator_principal_rotations (
           principal_id, request_id, run_id, reason, from_generation, to_generation,
           previous_child_id, child_id, previous_capability_hash, capability_hash, receipt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        request.requestId,
        row.run_id,
        request.reason,
        row.generation,
        replaced.generation,
        row.child_id,
        request.childId,
        row.capability_hash ?? '',
        request.capabilityHash,
        JSON.stringify(receipt)
      )
    return { ...receipt, replayed: false }
  })
}

export type PrincipalRotationMethods = {
  findPrincipalRotation: typeof findPrincipalRotation
  replacePrincipal: typeof replacePrincipal
}

export function attachPrincipalRotation(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { findPrincipalRotation, replacePrincipal })
}
