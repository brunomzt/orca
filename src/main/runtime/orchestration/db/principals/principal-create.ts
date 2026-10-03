import type { RunRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  COORDINATOR_PRINCIPAL_ID_PREFIX,
  COORDINATOR_PRINCIPAL_PROVIDERS,
  ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES,
  isCoordinatorPrincipalCapabilityHash,
  type CoordinatorPrincipalProvider,
  type CoordinatorPrincipalView
} from '../../../../../shared/orchestration-principal-contract'
import { generateId } from '../generated-id'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { OrchestrationDb } from '../orchestration-db'
import { principalError, principalViewOf } from './principal-row'

export type CreatePrincipalParams = {
  provider: string
  managerSessionId: string
  childId: string
  project: string
  rootPath: string
  workspaceId?: string | null
  generation?: number
  /** Retain this existing, unbound Run instead of creating one. */
  runId?: string
  objective?: string
  /** sha256 of the secret the CLI wrote to its private file; the secret never reaches the server. */
  capabilityHash: string
}

const LIVE_PRINCIPAL_SQL = `SELECT id, generation FROM coordinator_principals
  WHERE (project = ? OR run_id = ?) AND lifecycle <> 'retired' LIMIT 1`

function isPrincipalProvider(value: string): value is CoordinatorPrincipalProvider {
  return COORDINATOR_PRINCIPAL_PROVIDERS.some((provider) => provider === value)
}

function invalidArgument(message: string): OrchestrationError {
  return principalError('invalid_argument', message)
}

function requireRetainableRun(db: OrchestrationDb, runId: string): void {
  const run = db.getRunRaw(runId)
  if (!run || run.legacy === 1) {
    throw principalError('run_not_found', `Run ${runId} was not found.`)
  }
  if (run.coordinator_principal_id !== null) {
    throw principalError(
      CODES.runOwnedByPrincipal,
      `Run ${runId} already belongs to coordinator principal ${run.coordinator_principal_id}.`
    )
  }
  if (run.coordinator_handle || run.coordinator_pane_key || run.coordinator_orca_session_id) {
    throw principalError(
      CODES.runBoundToCoordinator,
      `Run ${runId} is bound to a terminal or session coordinator.`
    )
  }
}

export function createPrincipal(
  this: OrchestrationDb,
  params: CreatePrincipalParams
): { principal: CoordinatorPrincipalView; run: RunRow } {
  const generation = params.generation ?? 1
  if (!isPrincipalProvider(params.provider)) {
    throw invalidArgument(`Unsupported coordinator principal provider ${params.provider}.`)
  }
  for (const [field, value] of [
    ['managerSessionId', params.managerSessionId],
    ['childId', params.childId],
    ['project', params.project],
    ['rootPath', params.rootPath]
  ] as const) {
    if (value.trim() === '') {
      throw invalidArgument(`Coordinator principal ${field} must not be empty.`)
    }
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw invalidArgument('Coordinator principal generation must be a positive integer.')
  }
  if (!isCoordinatorPrincipalCapabilityHash(params.capabilityHash)) {
    throw principalError(
      CODES.capabilityInvalid,
      'Coordinator principal capability hash must be a lowercase sha256 digest.'
    )
  }
  const provider = params.provider
  return runLifecycleWriteTransaction(this.db, 'create_coordinator_principal', () => {
    const live = this.db.prepare(LIVE_PRINCIPAL_SQL).get(params.project, params.runId ?? null)
    if (live) {
      throw principalError(
        CODES.exists,
        `A coordinator principal already owns project ${params.project} or its Run.`,
        { principalId: String(live.id), generation: Number(live.generation) }
      )
    }
    const principalId = generateId(COORDINATOR_PRINCIPAL_ID_PREFIX)
    const runId = params.runId ?? generateId('run')
    if (params.runId) {
      requireRetainableRun(this, runId)
      this.db
        .prepare(
          `UPDATE runs SET coordinator_principal_id = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .run(principalId, runId)
    } else {
      // Coordinator terminal, pane and session stay null: a principal Run has no PTY to wake.
      this.db
        .prepare(
          `INSERT INTO runs (id, objective, coordinator_principal_id, consumer_generation, legacy)
           VALUES (?, ?, ?, 1, 0)`
        )
        .run(runId, params.objective ?? `Coordinator principal for ${params.project}`, principalId)
    }
    this.db
      .prepare(
        `INSERT INTO coordinator_principals (
           id, run_id, project, provider, manager_session_id, child_id, root_path, workspace_id,
           generation, capability_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        principalId,
        runId,
        params.project,
        provider,
        params.managerSessionId,
        params.childId,
        params.rootPath,
        params.workspaceId ?? null,
        generation,
        params.capabilityHash
      )
    const row = this.getCoordinatorPrincipalRow(principalId)
    const run = this.getRun(runId)
    if (!row || !run) {
      throw new OrchestrationError(
        'runtime_error',
        `Coordinator principal ${principalId} vanished.`
      )
    }
    return { principal: principalViewOf(this, row), run }
  })
}

export type PrincipalCreateMethods = {
  createPrincipal: typeof createPrincipal
}

export function attachPrincipalCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { createPrincipal })
}
