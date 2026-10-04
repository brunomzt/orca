import type { OrchestrationDb } from '../orchestration-db'

export function principalResumeSnapshot(db: OrchestrationDb, runId: string) {
  const blockers = db.listPrincipalRetirementBlockers(runId)
  const delivery = db.db
    .prepare(
      'SELECT id, json_array_length(message_ids) AS message_count FROM outstanding_deliveries WHERE mailbox_handle = ? LIMIT 1'
    )
    .get(`run:${runId}`)
  return {
    unfinishedTasks: blockers.filter((item) => item.kind === 'unfinished_task'),
    dispatches: blockers.filter(
      (item) => item.kind === 'pending_dispatch' || item.kind === 'unknown_dispatch'
    ),
    pendingQuestions: blockers.filter((item) => item.kind === 'pending_question'),
    outstandingDelivery: delivery
      ? { deliveryId: String(delivery.id), messageCount: Number(delivery.message_count) }
      : null,
    resources: blockers.filter((item) => item.kind === 'reclaimable_resource')
  }
}
