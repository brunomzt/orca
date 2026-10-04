import { expect } from 'vitest'
import type { OrchestrationDb } from '../orchestration-db'
import { hashCoordinatorPrincipalCapability } from './principal-capability-hash'

export const MANAGER_SESSION_ID = 'manager-session-secret-value'

export function createTestPrincipal(
  db: OrchestrationDb,
  overrides: { project?: string; runId?: string; capability?: string; childId?: string } = {}
) {
  return db.createPrincipal({
    provider: 'claude',
    managerSessionId: MANAGER_SESSION_ID,
    childId: overrides.childId ?? 'child-one',
    project: overrides.project ?? 'my-orca',
    rootPath: '/home/user/single-brain',
    runId: overrides.runId,
    capabilityHash: hashCoordinatorPrincipalCapability(overrides.capability ?? 'ccap_one')
  }).principal
}

/** Asserts the call throws an OrchestrationError with `code`, returning its data for more checks. */
export function expectOrchestrationError(run: () => unknown, code: string): unknown {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ code })
  return caught
}

/** Every column of the principal row and its Run, to prove a refusal wrote nothing. */
export function principalSnapshot(db: OrchestrationDb, principalId: string): unknown {
  const principal = db.getCoordinatorPrincipalRow(principalId)
  return {
    principal,
    run: principal ? db.getRunRaw(principal.run_id) : undefined,
    rotations: db.db
      .prepare('SELECT * FROM coordinator_principal_rotations WHERE principal_id = ?')
      .all(principalId)
  }
}
