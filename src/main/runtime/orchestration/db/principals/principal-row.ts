import type { CoordinatorPrincipalRow } from './coordinator-principal-row'
import { OrchestrationError } from '../../orchestration-error'
import {
  ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES,
  type CoordinatorPrincipalState,
  type CoordinatorPrincipalView
} from '../../../../../shared/orchestration-principal-contract'
import { COORDINATOR_PRINCIPAL_COLUMN_LIST } from '../row-column-lists'
import { exposeUtcTimestamp } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

const PRINCIPAL_BY_ID_SQL = `SELECT ${COORDINATOR_PRINCIPAL_COLUMN_LIST} FROM coordinator_principals WHERE id = ?`
const RUN_INTAKE_SQL = 'SELECT intake_closed FROM runs WHERE id = ?'

/** The principal and Run a write claims, with the generation it last observed. */
export type PrincipalWriteTarget = {
  principalId: string
  runId: string
  expectedGeneration: number
}

export function principalError(code: string, message: string, data?: object): OrchestrationError {
  return new OrchestrationError(code, `${message} No effects were applied.`, {
    ...data,
    effectsApplied: false
  })
}

export function getCoordinatorPrincipalRow(
  this: OrchestrationDb,
  principalId: string
): CoordinatorPrincipalRow | undefined {
  const row = this.db.prepare(PRINCIPAL_BY_ID_SQL).get(principalId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection lists exactly CoordinatorPrincipalRow's columns, pinned by row-column-lists.
  return row as CoordinatorPrincipalRow | undefined
}

/** Reads the principal a write targets and refuses unless it is live at exactly that generation. */
export function requireWritablePrincipal(
  db: OrchestrationDb,
  target: PrincipalWriteTarget
): CoordinatorPrincipalRow {
  const row = db.getCoordinatorPrincipalRow(target.principalId)
  if (!row || row.run_id !== target.runId) {
    throw principalError(
      CODES.notFound,
      `Coordinator principal ${target.principalId} does not own Run ${target.runId}.`
    )
  }
  if (row.lifecycle === 'retired') {
    throw principalError(CODES.retired, `Coordinator principal ${row.id} is retired.`)
  }
  assertPrincipalGeneration(row, target.expectedGeneration)
  return row
}

export function assertPrincipalGeneration(
  row: CoordinatorPrincipalRow,
  expectedGeneration: number
): void {
  if (expectedGeneration < row.generation) {
    throw principalError(
      CODES.staleGeneration,
      `Coordinator principal ${row.id} moved to generation ${row.generation}.`,
      { currentGeneration: row.generation }
    )
  }
  if (expectedGeneration > row.generation) {
    throw principalError(
      CODES.generationUnknown,
      `Coordinator principal ${row.id} has no generation ${expectedGeneration}.`
    )
  }
}

/** Fails closed when a CAS update lost a race the precheck could not see. */
export function assertPrincipalCasApplied(changes: number | bigint, principalId: string): void {
  if (Number(changes) !== 1) {
    throw principalError(
      CODES.staleGeneration,
      `Coordinator principal ${principalId} changed concurrently.`
    )
  }
}

export function derivePrincipalState(
  row: CoordinatorPrincipalRow,
  presence: { hasBlockers: boolean; waiting: boolean }
): CoordinatorPrincipalState {
  if (row.lifecycle !== 'active') {
    return row.lifecycle
  }
  if (presence.waiting) {
    return 'waiting'
  }
  return presence.hasBlockers ? 'active' : 'idle-retained'
}

// Built field by field so the capability hash can never ride along.
export function buildPrincipalView(
  row: CoordinatorPrincipalRow,
  intakeClosed: boolean,
  state: CoordinatorPrincipalState
): CoordinatorPrincipalView {
  return {
    id: row.id,
    provider: row.provider,
    managerSessionId: row.manager_session_id,
    childId: row.child_id,
    project: row.project,
    rootPath: row.root_path,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    generation: row.generation,
    state,
    lifecycle: row.lifecycle,
    retirementRequested: row.retirement_requested_at !== null,
    intakeClosed,
    coordinatorHandle: null,
    launch: { requested: { speed: row.requested_speed } },
    createdAt: exposeUtcTimestamp(row.created_at) ?? row.created_at,
    updatedAt: exposeUtcTimestamp(row.updated_at) ?? row.updated_at,
    retiredAt: exposeUtcTimestamp(row.retired_at)
  }
}

/** `waiting` is the caller's knowledge of a parked check on `run:<id>`; the store cannot see waiters. */
export function getPrincipalView(
  this: OrchestrationDb,
  principalId: string,
  presence: { waiting?: boolean } = {}
): CoordinatorPrincipalView | undefined {
  const row = this.getCoordinatorPrincipalRow(principalId)
  return row ? principalViewOf(this, row, presence.waiting === true) : undefined
}

export function principalViewOf(
  db: OrchestrationDb,
  row: CoordinatorPrincipalRow,
  waiting = false
): CoordinatorPrincipalView {
  const run = db.db.prepare(RUN_INTAKE_SQL).get(row.run_id)
  const hasBlockers =
    row.lifecycle === 'active' && db.listPrincipalRetirementBlockers(row.run_id).length > 0
  return buildPrincipalView(
    row,
    Number(run?.intake_closed) === 1,
    derivePrincipalState(row, { hasBlockers, waiting })
  )
}

/**
 * The one read path for a retired principal, by id alone: it never authenticates, so it answers
 * only for retired rows and the view carries no capability-derived data.
 */
export function findRetiredPrincipalView(
  this: OrchestrationDb,
  principalId: string
): CoordinatorPrincipalView | undefined {
  const row = this.getCoordinatorPrincipalRow(principalId)
  return row?.lifecycle === 'retired' ? principalViewOf(this, row) : undefined
}

export type PrincipalRowMethods = {
  getCoordinatorPrincipalRow: typeof getCoordinatorPrincipalRow
  getPrincipalView: typeof getPrincipalView
  findRetiredPrincipalView: typeof findRetiredPrincipalView
}

export function attachPrincipalRow(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getCoordinatorPrincipalRow,
    getPrincipalView,
    findRetiredPrincipalView
  })
}
