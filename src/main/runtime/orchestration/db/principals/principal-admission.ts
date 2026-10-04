import { ORCHESTRATION_PRINCIPAL_ERROR_CODES as CODES } from '../../../../../shared/orchestration-principal-contract'
import type { OrchestrationDb } from '../orchestration-db'
import {
  principalError,
  requireWritablePrincipal,
  type PrincipalWriteTarget
} from './principal-row'

const RUN_INTAKE_CLOSED_SQL = 'SELECT 1 FROM runs WHERE id = ? AND intake_closed = 1'

/**
 * Refuses new Tasks and Dispatches on a closed Run, and when a principal fence is given, unless
 * that principal owns this Run live at exactly the fenced generation. Callers run it inside the
 * same transaction as their insert so closure and admission cannot interleave.
 */
export function assertRunAdmission(
  this: OrchestrationDb,
  runId: string,
  fence?: PrincipalWriteTarget
): void {
  if (fence) {
    const row = requireWritablePrincipal(this, { ...fence, runId })
    if (row.lifecycle === 'recovering') {
      throw principalError(
        CODES.recovering,
        `Coordinator principal ${row.id} is recovering; it admits no new work until reconnected or replaced.`
      )
    }
  }
  if (this.db.prepare(RUN_INTAKE_CLOSED_SQL).get(runId)) {
    throw principalError(
      CODES.intakeClosed,
      `Run ${runId} is closed to new Tasks and Dispatches.`,
      {
        runId
      }
    )
  }
}

export type PrincipalAdmissionMethods = {
  assertRunAdmission: typeof assertRunAdmission
}

export function attachPrincipalAdmission(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { assertRunAdmission })
}
