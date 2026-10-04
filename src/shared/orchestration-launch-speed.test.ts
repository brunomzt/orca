import { describe, expect, it } from 'vitest'
import {
  launchSpeedAdmission,
  observeLaunchSpeed,
  type LaunchSpeedContext,
  type LaunchSpeedReceipt
} from './orchestration-launch-speed'

const NOW = Date.parse('2026-10-04T00:00:00Z')

function codexReceipt(overrides: Partial<LaunchSpeedReceipt> = {}): LaunchSpeedReceipt {
  return {
    requested: 'standard',
    applied: null,
    appliedSource: null,
    enforcement: {
      status: 'verified',
      phase: 'launch',
      provider: 'codex',
      providerVersion: '0.160.0',
      processIncarnation: '123:1000',
      requestId: 'req-1',
      observedAt: new Date(NOW).toISOString(),
      validUntil: new Date(NOW + 10_000).toISOString(),
      controls: [
        {
          kind: 'managed',
          name: 'fast_mode',
          value: false,
          source: 'configRequirements/read',
          grade: 'verified',
          precedence: Number.MAX_SAFE_INTEGER
        }
      ],
      overrides: [],
      effectiveLayer: 'managed_requirement',
      reasons: []
    },
    ...overrides
  }
}

function context(overrides: Partial<LaunchSpeedContext> = {}): LaunchSpeedContext {
  return {
    provider: 'codex',
    requestId: 'req-1',
    processIncarnation: '123:1000',
    phase: 'launch',
    now: NOW,
    ...overrides
  }
}

describe('launchSpeedAdmission', () => {
  it('admits a verified managed fast-off receipt matching the current context', () => {
    const decision = launchSpeedAdmission(codexReceipt(), context())
    expect(decision).toEqual({ admitted: true, code: null, reasons: [] })
  })

  it('fails closed when no receipt is present', () => {
    const decision = launchSpeedAdmission(undefined, context())
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_enforcement_unverified')
  })

  it('fails closed with fast_observed when applied speed is fast', () => {
    const receipt = codexReceipt({ applied: 'fast' })
    const decision = launchSpeedAdmission(receipt, context())
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('fast_observed')
  })

  it('fails closed with fast_observed when enforcement status itself is fast', () => {
    const receipt = codexReceipt()
    receipt.enforcement.status = 'fast'
    const decision = launchSpeedAdmission(receipt, context())
    expect(decision.code).toBe('fast_observed')
  })

  it('reports speed_override_conflict when a layer at or above managed precedence enables fast mode', () => {
    const receipt = codexReceipt()
    // Equal to the managed control's precedence, so it is not outranked by the fast-off requirement.
    receipt.enforcement.overrides = [
      {
        name: 'service_tier',
        value: 'priority',
        source: 'session_option',
        precedence: Number.MAX_SAFE_INTEGER
      }
    ]
    const decision = launchSpeedAdmission(receipt, context())
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_override_conflict')
  })

  it('does not flag an override that fast-off managed precedence outranks', () => {
    const receipt = codexReceipt()
    // Managed control precedence is MAX_SAFE_INTEGER, so a lower-precedence override cannot conflict.
    receipt.enforcement.overrides = [
      { name: 'service_tier', value: 'priority', source: 'legacy_launch_argv', precedence: 0 }
    ]
    const decision = launchSpeedAdmission(receipt, context())
    expect(decision.admitted).toBe(true)
  })

  it('reports speed_control_unsupported when the provider cannot expose controls', () => {
    const receipt = codexReceipt()
    receipt.enforcement.status = 'unsupported'
    receipt.enforcement.controls = []
    const decision = launchSpeedAdmission(receipt, context())
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_control_unsupported')
  })

  it('reports speed_evidence_stale when the process incarnation does not match the current context', () => {
    const receipt = codexReceipt()
    const decision = launchSpeedAdmission(receipt, context({ processIncarnation: '456:2000' }))
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_evidence_stale')
  })

  it('reports speed_evidence_stale when evidence has expired', () => {
    const receipt = codexReceipt()
    const decision = launchSpeedAdmission(receipt, context({ now: NOW + 60_000 }))
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_evidence_stale')
  })

  it('reports speed_evidence_stale when the phase does not match the current request', () => {
    const receipt = codexReceipt()
    const decision = launchSpeedAdmission(receipt, context({ phase: 'resume' }))
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_evidence_stale')
  })

  it('admits a verified fast-off receipt even when applied tier is unknown (Bruno-approved clarification)', () => {
    const receipt = codexReceipt({ applied: null })
    const decision = launchSpeedAdmission(receipt, context())
    expect(decision.admitted).toBe(true)
  })

  it('requires both the env control and a fresh fast-off settings read for Claude verification', () => {
    const receipt: LaunchSpeedReceipt = {
      requested: 'standard',
      applied: null,
      appliedSource: null,
      enforcement: {
        status: 'verified',
        phase: 'launch',
        provider: 'claude',
        providerVersion: '1.0.0',
        processIncarnation: '9:1',
        requestId: 'req-2',
        observedAt: new Date(NOW).toISOString(),
        validUntil: new Date(NOW + 10_000).toISOString(),
        controls: [
          {
            kind: 'env',
            name: 'CLAUDE_CODE_DISABLE_FAST_MODE',
            value: '1',
            source: 'provider.disabled_by_env',
            grade: 'verified',
            precedence: 2000
          }
          // Missing the matching verified `setting` control for fastMode:false.
        ],
        overrides: [],
        effectiveLayer: 'provider.disabled_by_env',
        reasons: []
      }
    }
    const decision = launchSpeedAdmission(
      receipt,
      context({ provider: 'claude', requestId: 'req-2', processIncarnation: '9:1' })
    )
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_enforcement_unverified')
  })

  it('admits Claude only once both the env control and the settings read are verified', () => {
    const receipt: LaunchSpeedReceipt = {
      requested: 'standard',
      applied: null,
      appliedSource: null,
      enforcement: {
        status: 'verified',
        phase: 'launch',
        provider: 'claude',
        providerVersion: '1.0.0',
        processIncarnation: '9:1',
        requestId: 'req-2',
        observedAt: new Date(NOW).toISOString(),
        validUntil: new Date(NOW + 10_000).toISOString(),
        controls: [
          {
            kind: 'env',
            name: 'CLAUDE_CODE_DISABLE_FAST_MODE',
            value: '1',
            source: 'provider.disabled_by_env',
            grade: 'verified',
            precedence: 2000
          },
          {
            kind: 'setting',
            name: 'fastMode',
            value: false,
            source: 'get_settings',
            grade: 'verified',
            precedence: 1000
          }
        ],
        overrides: [],
        effectiveLayer: 'provider.disabled_by_env',
        reasons: []
      }
    }
    const decision = launchSpeedAdmission(
      receipt,
      context({ provider: 'claude', requestId: 'req-2', processIncarnation: '9:1' })
    )
    expect(decision.admitted).toBe(true)
  })

  it('rejects stale catalog-only evidence for a different model than the current admission context', () => {
    const receipt = codexReceipt()
    receipt.enforcement.controls = [
      {
        kind: 'catalog',
        name: 'gpt-other',
        value: 'fast-unavailable',
        source: 'model/list',
        grade: 'verified',
        precedence: 0
      }
    ]
    receipt.enforcement.catalog = {
      model: 'gpt-other',
      clientVersion: '0.160.0',
      fetchedAt: new Date(NOW).toISOString(),
      advertisedTiers: ['default'],
      source: 'live'
    }
    const decision = launchSpeedAdmission(receipt, context({ model: 'gpt-live' }))
    expect(decision.admitted).toBe(false)
    expect(decision.code).toBe('speed_enforcement_unverified')
  })

  it('requires a current (non-stale) parent receipt for inherited child evidence', () => {
    // Parent expires earlier than the child so a `now` between the two isolates parent staleness.
    const parentReceipt = codexReceipt()
    parentReceipt.enforcement.validUntil = new Date(NOW + 5_000).toISOString()
    const childReceipt = codexReceipt()
    childReceipt.enforcement.validUntil = new Date(NOW + 10_000).toISOString()
    childReceipt.enforcement.requestId = 'req-child'
    childReceipt.enforcement.inheritedFrom = parentReceipt.enforcement.requestId

    const decision = launchSpeedAdmission(
      childReceipt,
      context({
        requestId: 'req-child',
        parent: { receipt: parentReceipt, context: context() }
      })
    )
    expect(decision.admitted).toBe(true)

    // The parent is re-checked against the real current time, not a stale `now` the caller supplies.
    // At NOW + 7000 the child's own evidence is still fresh, but the parent's has expired.
    const staleDecision = launchSpeedAdmission(childReceipt, {
      ...context({ requestId: 'req-child', now: NOW + 7_000 }),
      parent: { receipt: parentReceipt, context: context() }
    })
    expect(staleDecision.admitted).toBe(false)
    expect(staleDecision.code).toBe('speed_evidence_stale')
  })
})

describe('observeLaunchSpeed', () => {
  it('records a fast observation and revokes further admission', () => {
    const receipt = codexReceipt()
    const observed = observeLaunchSpeed(receipt, 'fast', 'provider.usage.speed', 'now')
    expect(observed.applied).toBe('fast')
    expect(observed.enforcement.status).toBe('fast')
    expect(observed.enforcement.phase).toBe('post-turn')
    expect(observed.enforcement.reasons).toContain('fast_observed')
  })

  it('never lets a later standard observation overwrite an earlier fast revocation', () => {
    const fastReceipt = observeLaunchSpeed(codexReceipt(), 'fast', 'provider.usage.speed', 'now')
    const relapsed = observeLaunchSpeed(fastReceipt, 'standard', 'provider.usage.speed', 'later')
    expect(relapsed).toBe(fastReceipt)
    expect(relapsed.applied).toBe('fast')
  })
})
