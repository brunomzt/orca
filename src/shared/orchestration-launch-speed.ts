export type LaunchSpeedPhase = 'launch' | 'resume' | 'reuse' | 'replacement' | 'post-turn'
export type LaunchSpeedControl = {
  kind: 'argv' | 'env' | 'config' | 'managed' | 'setting' | 'catalog'
  name: string
  value: string | boolean | number | null
  source: string
  grade: 'verified' | 'source-indicated' | 'hypothesis'
  precedence: number
}
export type LaunchSpeedReceipt = {
  requested: 'standard'
  applied: 'standard' | 'fast' | null
  appliedSource: string | null
  enforcement: {
    status: 'verified' | 'unverified' | 'unsupported' | 'conflict' | 'fast'
    phase: LaunchSpeedPhase
    provider: 'claude' | 'codex'
    providerVersion: string | null
    processIncarnation: string | null
    requestId: string
    observedAt: string
    validUntil: string
    controls: LaunchSpeedControl[]
    overrides: {
      name: string
      value: string | boolean | number | null
      source: string
      precedence: number
    }[]
    effectiveLayer: string | null
    inheritedFrom?: string
    catalog?: {
      model: string
      clientVersion: string
      fetchedAt: string
      advertisedTiers: string[]
      source: 'live'
    }
    reasons: string[]
  }
}

export type LaunchSpeedContext = {
  provider: string | null
  requestId: string
  processIncarnation: string
  phase: LaunchSpeedPhase
  now: number
  /** Exact provider model for catalog-only evidence; aliases are not interchangeable. */
  model?: string
  parent?: { receipt: LaunchSpeedReceipt; context: LaunchSpeedContext }
}

const ERROR_PRECEDENCE = [
  'fast_observed',
  'speed_override_conflict',
  'speed_control_unsupported',
  'speed_evidence_stale',
  'speed_enforcement_unverified'
] as const

function hasVerifiedBasis(receipt: LaunchSpeedReceipt, context: LaunchSpeedContext): boolean {
  const evidence = receipt.enforcement
  const verified = evidence.controls.filter((control) => control.grade === 'verified')
  if (evidence.provider === 'claude') {
    return (
      verified.some(
        (control) =>
          control.kind === 'env' &&
          control.name === 'CLAUDE_CODE_DISABLE_FAST_MODE' &&
          (control.value === true || control.value === '1')
      ) &&
      verified.some(
        (control) =>
          control.kind === 'setting' && control.name === 'fastMode' && control.value === false
      )
    )
  }
  if (
    verified.some(
      (control) =>
        control.kind === 'managed' && control.name === 'fast_mode' && control.value === false
    )
  ) {
    return true
  }
  const catalog = evidence.catalog
  if (
    !catalog ||
    !evidence.providerVersion ||
    catalog.clientVersion !== evidence.providerVersion ||
    !catalog.model ||
    catalog.model !== context.model ||
    catalog.source !== 'live' ||
    catalog.advertisedTiers.length === 0
  ) {
    return false
  }
  const fetched = Date.parse(catalog.fetchedAt)
  return (
    Number.isFinite(fetched) &&
    fetched <= context.now &&
    context.now - fetched <= 30_000 &&
    catalog.advertisedTiers.every((tier) => tier === 'standard' || tier === 'default') &&
    verified.some(
      (control) =>
        control.kind === 'catalog' &&
        control.name === catalog.model &&
        control.value === 'fast-unavailable'
    )
  )
}

export function launchSpeedAdmission(
  receipt: LaunchSpeedReceipt | undefined,
  context: LaunchSpeedContext
): {
  admitted: boolean
  code: string | null
  reasons: string[]
} {
  if (!receipt) {
    return {
      admitted: false,
      code: 'speed_enforcement_unverified',
      reasons: ['speed_enforcement_unverified']
    }
  }
  const evidence = receipt.enforcement
  const reasons = new Set<string>()
  if (receipt.applied === 'fast' || evidence.status === 'fast') {
    reasons.add('fast_observed')
  }
  const managedOff =
    evidence.provider === 'codex' &&
    evidence.controls.find(
      (control) =>
        control.kind === 'managed' &&
        control.name === 'fast_mode' &&
        control.value === false &&
        control.grade === 'verified'
    )
  const enablesFast = (layer: LaunchSpeedReceipt['enforcement']['overrides'][number]): boolean =>
    (!managedOff || layer.precedence >= managedOff.precedence) &&
    (((layer.name === 'fastMode' || layer.name === 'fast_mode') &&
      (layer.value === true || layer.value === 'true')) ||
      ((layer.name === 'serviceTier' || layer.name === 'service_tier') &&
        (layer.value === 'fast' || layer.value === 'priority')))
  if (evidence.controls.some(enablesFast)) {
    reasons.add('fast_observed')
  }
  if (evidence.status === 'conflict' || evidence.overrides.some(enablesFast)) {
    reasons.add('speed_override_conflict')
  }
  if (evidence.status === 'unsupported') {
    reasons.add('speed_control_unsupported')
  }
  const observed = Date.parse(evidence.observedAt)
  const expiry = Date.parse(evidence.validUntil)
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expiry) ||
    observed > context.now ||
    expiry <= context.now ||
    expiry <= observed ||
    evidence.requestId !== context.requestId ||
    !evidence.processIncarnation ||
    evidence.processIncarnation !== context.processIncarnation ||
    evidence.provider !== context.provider ||
    evidence.phase !== context.phase
  ) {
    reasons.add('speed_evidence_stale')
  }
  if (evidence.inheritedFrom) {
    const parent = context.parent
    if (
      !parent ||
      parent.receipt.enforcement.requestId !== evidence.inheritedFrom ||
      parent.receipt.enforcement.inheritedFrom ||
      !launchSpeedAdmission(parent.receipt, {
        ...parent.context,
        now: context.now,
        parent: undefined
      }).admitted
    ) {
      reasons.add('speed_evidence_stale')
    }
  }
  if (evidence.status !== 'verified' || !hasVerifiedBasis(receipt, context)) {
    reasons.add('speed_enforcement_unverified')
  }
  const ordered = ERROR_PRECEDENCE.filter((code) => reasons.has(code))
  return { admitted: ordered.length === 0, code: ordered[0] ?? null, reasons: ordered }
}

export function observeLaunchSpeed(
  receipt: LaunchSpeedReceipt,
  applied: 'standard' | 'fast',
  source: string,
  observedAt: string
): LaunchSpeedReceipt {
  if (receipt.applied === 'fast' || receipt.enforcement.status === 'fast') {
    return receipt
  }
  return {
    ...receipt,
    applied,
    appliedSource: source,
    enforcement: {
      ...receipt.enforcement,
      ...(applied === 'fast'
        ? {
            status: 'fast',
            phase: 'post-turn',
            observedAt,
            reasons: [...new Set(['fast_observed', ...receipt.enforcement.reasons])]
          }
        : {})
    }
  }
}
