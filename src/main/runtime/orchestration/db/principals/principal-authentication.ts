import {
  ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES,
  type CoordinatorPrincipalLifecycle,
  type OrchestrationPrincipalAuthority,
  type OrchestrationPrincipalEnvelope
} from '../../../../../shared/orchestration-principal-contract'
import type { CoordinatorPrincipalRow } from './coordinator-principal-row'
import type { OrchestrationDb } from '../orchestration-db'
import { capabilityMatchesHash } from './principal-capability-hash'
import { principalError } from './principal-row'
import {
  committedReplacementReceipt,
  type PrincipalReplaceReceipt,
  type PrincipalReplaceRequest
} from './principal-rotation'

const FENCED_GENERATION_HASH_SQL = `SELECT previous_capability_hash FROM coordinator_principal_rotations
  WHERE principal_id = ? AND from_generation = ?`

function invalidCapability(principalId: string): Error {
  return principalError(
    CODES.capabilityInvalid,
    `The capability does not authenticate coordinator principal ${principalId}.`
  )
}

function requireLivePrincipal(
  db: OrchestrationDb,
  envelope: OrchestrationPrincipalEnvelope
): CoordinatorPrincipalRow {
  const row = db.getCoordinatorPrincipalRow(envelope.principalId)
  if (!row || row.run_id !== envelope.runId) {
    throw principalError(
      CODES.notFound,
      `Coordinator principal ${envelope.principalId} does not own Run ${envelope.runId}.`
    )
  }
  if (row.lifecycle === 'retired') {
    throw principalError(CODES.retired, `Coordinator principal ${row.id} is retired.`)
  }
  return row
}

/**
 * Verifies an envelope for any verb. An old generation's secret learns only that it is stale; it
 * never authenticates, even for the replacement that fenced it (see the replay check below).
 */
export function authenticatePrincipal(
  this: OrchestrationDb,
  envelope: OrchestrationPrincipalEnvelope
): { authority: OrchestrationPrincipalAuthority; lifecycle: CoordinatorPrincipalLifecycle } {
  const row = requireLivePrincipal(this, envelope)
  if (envelope.generation > row.generation) {
    throw principalError(
      CODES.generationUnknown,
      `Coordinator principal ${row.id} has no generation ${envelope.generation}.`
    )
  }
  if (envelope.generation < row.generation) {
    const fenced = this.db.prepare(FENCED_GENERATION_HASH_SQL).get(row.id, envelope.generation)
    const hash =
      typeof fenced?.previous_capability_hash === 'string' ? fenced.previous_capability_hash : null
    if (!capabilityMatchesHash(envelope.capability, hash)) {
      throw invalidCapability(row.id)
    }
    throw principalError(
      CODES.staleGeneration,
      `Coordinator principal ${row.id} moved to generation ${row.generation}.`,
      { currentGeneration: row.generation }
    )
  }
  if (!capabilityMatchesHash(envelope.capability, row.capability_hash)) {
    throw invalidCapability(row.id)
  }
  return {
    authority: { principalId: row.id, runId: row.run_id, generation: row.generation },
    lifecycle: row.lifecycle
  }
}

/**
 * The only path an old generation's secret authenticates: replaying the exact committed
 * replacement that fenced it, after a lost response. The new secret may replay it too. Returns the
 * original receipt and never writes, so no later generation can be disturbed.
 */
export function authenticatePrincipalRotationReplay(
  this: OrchestrationDb,
  envelope: OrchestrationPrincipalEnvelope,
  request: PrincipalReplaceRequest
): PrincipalReplaceReceipt | undefined {
  if (envelope.principalId !== request.principalId || envelope.runId !== request.runId) {
    throw invalidCapability(envelope.principalId)
  }
  requireLivePrincipal(this, envelope)
  const record = this.findPrincipalRotation(request.principalId, request.requestId)
  if (!record) {
    return undefined
  }
  const oldSecret =
    envelope.generation === record.from_generation &&
    capabilityMatchesHash(envelope.capability, record.previous_capability_hash)
  const newSecret =
    envelope.generation === record.to_generation &&
    capabilityMatchesHash(envelope.capability, record.capability_hash)
  if (!oldSecret && !newSecret) {
    throw invalidCapability(envelope.principalId)
  }
  // Authenticated first so an unauthenticated caller cannot probe the committed fingerprint.
  return committedReplacementReceipt(record, request)
}

export type PrincipalAuthenticationMethods = {
  authenticatePrincipal: typeof authenticatePrincipal
  authenticatePrincipalRotationReplay: typeof authenticatePrincipalRotationReplay
}

export function attachPrincipalAuthentication(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { authenticatePrincipal, authenticatePrincipalRotationReplay })
}
