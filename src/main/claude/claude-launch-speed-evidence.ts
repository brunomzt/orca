import { z } from 'zod'
import {
  launchSpeedAdmission,
  type LaunchSpeedPhase,
  type LaunchSpeedReceipt
} from '../../shared/orchestration-launch-speed'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import type { ClaudeSession } from './claude-structured-session-state'

const Settings = z.object({
  effective: z.object({ fastMode: z.boolean().optional() }),
  sources: z.array(
    z.object({ source: z.string(), settings: z.object({ fastMode: z.boolean().optional() }) })
  )
})

export async function readClaudeLaunchSpeedEvidence(
  session: Pick<
    ClaudeSession,
    | 'connection'
    | 'providerVersion'
    | 'launchFastModeDisabled'
    | 'fastModeState'
    | 'fastModeDisabledReason'
    | 'observedAppliedSpeed'
  >,
  input: {
    requestId: string
    phase: LaunchSpeedPhase
  },
  readStartTime = readProcessStartTimeMs
): Promise<LaunchSpeedReceipt> {
  const now = Date.now()
  const pid = session.connection.pid
  const start = pid === undefined ? null : await readStartTime(pid)
  const incarnation = start === null ? null : `${pid}:${start}`
  const settings = Settings.safeParse(
    await session.connection.getSettings({ timeoutMs: 10_000 }).catch(() => null)
  )
  const receipt: LaunchSpeedReceipt = {
    requested: 'standard',
    applied: session.observedAppliedSpeed ?? null,
    appliedSource: session.observedAppliedSpeed ? 'provider.usage.speed' : null,
    enforcement: {
      status: 'unverified',
      provider: 'claude',
      providerVersion: session.providerVersion ?? null,
      requestId: input.requestId,
      phase: input.phase,
      processIncarnation: incarnation,
      observedAt: new Date(now).toISOString(),
      validUntil: new Date(now + 30_000).toISOString(),
      controls: [],
      overrides: [],
      effectiveLayer: null,
      reasons: []
    }
  }
  const evidence = receipt.enforcement
  if (settings.success) {
    evidence.overrides = settings.data.sources.flatMap((layer, precedence) =>
      layer.settings.fastMode === undefined
        ? []
        : [{ name: 'fastMode', value: layer.settings.fastMode, source: layer.source, precedence }]
    )
    if (settings.data.effective.fastMode !== undefined) {
      evidence.controls.push({
        kind: 'setting',
        name: 'fastMode',
        value: settings.data.effective.fastMode,
        source: 'get_settings',
        grade: 'verified',
        precedence: 1000
      })
    }
  }
  if (session.launchFastModeDisabled) {
    const observedDisabled =
      session.fastModeState === 'off' && session.fastModeDisabledReason === 'disabled_by_env'
    evidence.controls.push({
      kind: 'env',
      name: 'CLAUDE_CODE_DISABLE_FAST_MODE',
      value: '1',
      source: observedDisabled ? 'provider.disabled_by_env' : 'provider_launch_environment',
      grade: observedDisabled ? 'verified' : 'source-indicated',
      precedence: 2000
    })
    if (observedDisabled && settings.success && settings.data.effective.fastMode === false) {
      evidence.status = 'verified'
      evidence.effectiveLayer = 'provider.disabled_by_env'
    }
  }
  // An off snapshot does not by itself prove which control disabled fast mode.
  if (
    session.fastModeState === 'on' ||
    session.fastModeState === 'cooldown' ||
    session.observedAppliedSpeed === 'fast'
  ) {
    evidence.status = 'fast'
  }
  if (session.connection.closed || (pid !== undefined && (await readStartTime(pid)) !== start)) {
    evidence.processIncarnation = null
  }
  const decision = launchSpeedAdmission(receipt, {
    ...input,
    provider: 'claude',
    now: Date.now(),
    processIncarnation: incarnation ?? ''
  })
  evidence.reasons = decision.reasons
  if (decision.code === 'speed_override_conflict') {
    evidence.status = 'conflict'
  }
  return receipt
}
