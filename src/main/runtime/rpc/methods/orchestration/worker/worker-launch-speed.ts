import {
  launchSpeedAdmission,
  type LaunchSpeedPhase,
  type LaunchSpeedReceipt
} from '../../../../../../shared/orchestration-launch-speed'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

export class WorkerLaunchSpeedError extends OrchestrationError {
  constructor(
    code: string,
    message: string,
    readonly reasons: string[],
    readonly speed?: LaunchSpeedReceipt
  ) {
    super(code, message, { reasons, ...(speed ? { speed } : {}) })
  }
}

export async function enforceWorkerLaunchSpeed(input: {
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  requestId: string
  phase: LaunchSpeedPhase
  provider: string | null
}): Promise<LaunchSpeedReceipt> {
  const session = input.structuredSession
  if (!session) {
    throw new WorkerLaunchSpeedError(
      'speed_control_unsupported',
      'The terminal provider does not expose current speed enforcement evidence.',
      ['speed_control_unsupported', 'speed_enforcement_unverified']
    )
  }
  const sessionId = session.identity.sessionId
  const receipt = await session.host
    .readLaunchSpeed(sessionId, input.requestId, input.phase)
    .catch(() => undefined)
  const record = session.host.deps.store.getRecord(sessionId)
  const owner = record?.lease.ownerProcess
  const incarnation =
    owner?.processStartTimeMs == null || record?.provider !== input.provider
      ? ''
      : `${owner.pid}:${owner.processStartTimeMs}`
  const decision = launchSpeedAdmission(receipt, {
    provider: input.provider,
    requestId: input.requestId,
    phase: input.phase,
    processIncarnation: incarnation,
    now: Date.now()
  })
  if (!decision.admitted || !receipt || record?.lease.claimStatus !== 'live') {
    const reasons = [...decision.reasons]
    if (record?.lease.claimStatus !== 'live' && !reasons.includes('speed_evidence_stale')) {
      const unverified = reasons.indexOf('speed_enforcement_unverified')
      reasons.splice(unverified === -1 ? reasons.length : unverified, 0, 'speed_evidence_stale')
    }
    throw new WorkerLaunchSpeedError(
      reasons[0] ?? 'speed_evidence_stale',
      'Current provider speed controls could not be verified.',
      reasons,
      receipt
    )
  }
  return receipt
}
