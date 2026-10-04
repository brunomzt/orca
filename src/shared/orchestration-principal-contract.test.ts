import { describe, expect, it } from 'vitest'
import {
  COORDINATOR_PRINCIPAL_REPLACE_REASONS,
  ORCHESTRATION_PRINCIPAL_METHODS,
  ORCHESTRATION_PRINCIPAL_MUTATION_METHODS,
  ORCHESTRATION_PRINCIPAL_VERB_METHODS,
  isCoordinatorPrincipalCapabilityHash
} from './orchestration-principal-contract'
import { isOrchestrationMutation } from './orchestration-rpc-contract'
import {
  ORCHESTRATION_COORDINATOR_PRINCIPAL_RUNTIME_CAPABILITY,
  ORCHESTRATION_INTAKE_CLOSED_RUNTIME_CAPABILITY,
  ORCHESTRATION_LAUNCH_SPEED_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

describe('coordinator principal contract', () => {
  it('replaces only for loss, never for a model update', () => {
    expect(COORDINATOR_PRINCIPAL_REPLACE_REASONS).toEqual(['loss'])
  })

  it('treats every principal verb but principalShow as a durable mutation', () => {
    expect(ORCHESTRATION_PRINCIPAL_MUTATION_METHODS).not.toContain('orchestration.principalShow')
    for (const method of ORCHESTRATION_PRINCIPAL_VERB_METHODS) {
      expect(isOrchestrationMutation(method, {})).toBe(method !== 'orchestration.principalShow')
      expect(ORCHESTRATION_PRINCIPAL_METHODS.has(method)).toBe(true)
    }
  })

  it('accepts only a lowercase hex sha256 capability hash', () => {
    expect(isCoordinatorPrincipalCapabilityHash('a'.repeat(64))).toBe(true)
    expect(isCoordinatorPrincipalCapabilityHash('A'.repeat(64))).toBe(false)
    expect(isCoordinatorPrincipalCapabilityHash('a'.repeat(63))).toBe(false)
    expect(isCoordinatorPrincipalCapabilityHash(`ccap_${'a'.repeat(59)}`)).toBe(false)
    expect(isCoordinatorPrincipalCapabilityHash(undefined)).toBe(false)
  })

  it('defines the principal capabilities without advertising them yet', () => {
    const advertised: readonly string[] = RUNTIME_CAPABILITIES
    for (const capability of [
      ORCHESTRATION_COORDINATOR_PRINCIPAL_RUNTIME_CAPABILITY,
      ORCHESTRATION_INTAKE_CLOSED_RUNTIME_CAPABILITY,
      ORCHESTRATION_LAUNCH_SPEED_RUNTIME_CAPABILITY
    ]) {
      expect(advertised).not.toContain(capability)
    }
  })
})
