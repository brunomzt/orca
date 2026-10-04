import type { OrchestrationDb } from '../orchestration/db'
import { OrchestrationError } from '../orchestration/orchestration-error'

export function assertPrincipalResourceScope(
  db: OrchestrationDb,
  method: string,
  params: Record<string, unknown>,
  runId: string
): void {
  const belongs = (resourceRunId: string | null | undefined): void => {
    if (resourceRunId !== runId) {
      throw new OrchestrationError(
        'principal_resource_mismatch',
        'Resource is outside this principal Run.',
        { effectsApplied: false }
      )
    }
  }
  if (method === 'orchestration.runShow') {
    belongs(typeof params.id === 'string' ? params.id : runId)
  }
  if (typeof params.task === 'string') {
    belongs(db.getTask(params.task)?.run_id)
  }
  if (typeof params.dispatch === 'string') {
    belongs(db.getDispatchContextById(params.dispatch)?.run_id)
  }
  if (method === 'orchestration.taskUpdate' && typeof params.id === 'string') {
    belongs(db.getTask(params.id)?.run_id)
  }
  if (method === 'orchestration.gateResolve' && typeof params.id === 'string') {
    belongs(db.getGate(params.id)?.run_id)
  }
  if (method === 'orchestration.reply' && typeof params.id === 'string') {
    belongs(db.getMessageById(params.id)?.run_id)
  }
  if (typeof params.to === 'string' && params.to.startsWith('dispatch:')) {
    belongs(db.getDispatchContextById(params.to.slice('dispatch:'.length))?.run_id)
  }
  if (
    typeof params.to === 'string' &&
    !params.to.startsWith('dispatch:') &&
    params.to !== `run:${runId}`
  ) {
    throw new OrchestrationError(
      'recipient_run_mismatch',
      'Principal mail must target its Run or a Dispatch it owns.',
      { effectsApplied: false }
    )
  }
}
