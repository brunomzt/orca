import { z } from 'zod'
import type { LaunchSpeedPhase, LaunchSpeedReceipt } from '../../shared/orchestration-launch-speed'
import { launchSpeedAdmission } from '../../shared/orchestration-launch-speed'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import type { CodexSession } from './codex-structured-session-state'

const SpeedConfig = z.object({
  service_tier: z.string().nullable().optional(),
  features: z.object({ fast_mode: z.boolean().optional() }).optional()
})
const ConfigRead = z.object({
  config: SpeedConfig,
  layers: z
    .array(
      z.object({
        config: SpeedConfig,
        name: z.object({ type: z.string() }),
        disabledReason: z.string().nullable().optional()
      })
    )
    .nullable()
})
const Requirements = z.object({
  requirements: z
    .object({
      featureRequirements: z.record(z.string(), z.boolean()).nullable().optional()
    })
    .nullable()
})

export async function readCodexLaunchSpeedEvidence(
  session: Pick<
    CodexSession,
    'connection' | 'ended' | 'options' | 'reportedOptions' | 'fastModeTierByModel'
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
  const [requirements, config] = await Promise.all([
    session.connection
      .request('configRequirements/read', {}, { timeoutMs: 10_000 })
      .catch(() => null),
    session.connection
      .request('config/read', { includeLayers: true }, { timeoutMs: 10_000 })
      .catch(() => null)
  ])
  const managed = Requirements.safeParse(requirements)
  const layers = ConfigRead.safeParse(config)
  const fastTier = session.fastModeTierByModel.get(session.reportedOptions.model ?? '')
  const tier = session.reportedOptions.serviceTier
  const applied =
    session.reportedOptions.serviceTierKnown && tier != null
      ? tier === 'default'
        ? 'standard'
        : tier === 'fast' || tier === 'priority' || tier === fastTier
          ? 'fast'
          : null
      : null
  const receipt: LaunchSpeedReceipt = {
    requested: 'standard',
    applied,
    appliedSource: applied ? 'provider.serviceTier' : null,
    enforcement: {
      status: 'unverified',
      provider: 'codex',
      providerVersion: session.connection.providerVersion ?? null,
      phase: input.phase,
      requestId: input.requestId,
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
  if (layers.success && layers.data.layers) {
    layers.data.layers.forEach((layer, precedence) => {
      if (layer.disabledReason) {
        return
      }
      if (layer.config.features?.fast_mode !== undefined) {
        evidence.overrides.push({
          name: 'fast_mode',
          value: layer.config.features.fast_mode,
          source: layer.name.type,
          precedence
        })
      }
      if (layer.config.service_tier != null) {
        evidence.overrides.push({
          name: 'service_tier',
          value: layer.config.service_tier,
          source: layer.name.type,
          precedence
        })
      }
    })
    if (managed.success && managed.data.requirements?.featureRequirements?.fast_mode === false) {
      evidence.controls.push({
        kind: 'managed',
        name: 'fast_mode',
        value: false,
        source: 'configRequirements/read',
        grade: 'verified',
        precedence: Number.MAX_SAFE_INTEGER
      })
      evidence.effectiveLayer = 'managed_requirement'
      evidence.status = 'verified'
    }
  }
  if (session.options.get('fastMode') === 'true') {
    evidence.overrides.push({
      name: 'fastMode',
      value: true,
      source: 'session_option',
      precedence: 1000
    })
  }
  if (
    session.ended ||
    session.connection.closed ||
    (pid !== undefined && (await readStartTime(pid)) !== start)
  ) {
    evidence.processIncarnation = null
  }
  const decision = launchSpeedAdmission(receipt, {
    ...input,
    provider: 'codex',
    now: Date.now(),
    processIncarnation: incarnation ?? ''
  })
  evidence.reasons = decision.reasons
  if (!decision.admitted) {
    evidence.status =
      decision.code === 'fast_observed'
        ? 'fast'
        : decision.code === 'speed_override_conflict'
          ? 'conflict'
          : 'unverified'
  }
  return receipt
}
