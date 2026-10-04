import type { OrchestrationPrincipalEnvelope } from '../../shared/orchestration-principal-contract'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError } from './types'

export type PrincipalRoute = {
  envelope: OrchestrationPrincipalEnvelope
  runtimeId: string
  expectedGeneration?: number
}
export const PRINCIPAL_CAPABILITIES = [
  'orchestration.contract.v1',
  'orchestration.coordinator-principal.v1',
  'orchestration.intake-closed.v1',
  'orchestration.launch-speed.v1'
] as const

export function requirePrincipalRuntime(
  status: RuntimeStatus,
  runtimeId: string,
  expectedRuntimeId?: string
): void {
  if (expectedRuntimeId && runtimeId !== expectedRuntimeId) {
    throw new RuntimeClientError(
      'principal_runtime_mismatch',
      'The capability belongs to another runtime.'
    )
  }
  if (!PRINCIPAL_CAPABILITIES.every((capability) => status.capabilities?.includes(capability))) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This runtime does not support the complete principal contract.'
    )
  }
}

export function principalRouteParams(
  params: unknown,
  route: PrincipalRoute
): Record<string, unknown> {
  const result: Record<string, unknown> = params && typeof params === 'object' ? { ...params } : {}
  if (
    (result.run !== undefined && result.run !== route.envelope.runId) ||
    (result.principal !== undefined && result.principal !== route.envelope.principalId) ||
    (result.expectedGeneration !== undefined &&
      result.expectedGeneration !== route.expectedGeneration)
  ) {
    throw new RuntimeClientError(
      'ambiguous_coordinator_routing',
      'Principal routing identity does not match the request.'
    )
  }
  for (const key of ['from', 'terminal', 'callerTerminalHandle']) {
    if (result[key] === `run:${route.envelope.runId}`) {
      delete result[key]
    }
  }
  return {
    ...result,
    run: route.envelope.runId,
    principal: route.envelope.principalId,
    ...(route.expectedGeneration !== undefined
      ? { expectedGeneration: route.expectedGeneration }
      : {})
  }
}
