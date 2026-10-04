import type { OrchestrationPrincipalAuthority } from '../../../shared/orchestration-principal-contract'
import type { OrchestrationDb } from '../orchestration/db'
import { OrchestrationError } from '../orchestration/orchestration-error'

export function assertPrincipalGeneration(
  db: OrchestrationDb,
  authority: OrchestrationPrincipalAuthority | undefined
): void {
  if (!authority) {
    return
  }
  const row = db.getCoordinatorPrincipalRow(authority.principalId)
  if (
    !row ||
    row.run_id !== authority.runId ||
    row.lifecycle === 'retired' ||
    row.generation !== authority.generation
  ) {
    throw new OrchestrationError('stale_generation', 'Principal ownership changed.', {
      effectsApplied: false
    })
  }
}
