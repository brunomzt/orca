import { assertPrincipalResourceScope } from './principal-resource-scope'
import {
  ORCHESTRATION_PRINCIPAL_METHODS,
  ORCHESTRATION_PRINCIPAL_VERB_METHODS
} from '../../../shared/orchestration-principal-contract'
import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { RpcRequest } from './core'
import {
  ORCHESTRATION_CALLER_PARAM,
  type OrchestrationRequestRoute,
  type ResolvedOrchestrationRequest
} from './orchestration-session-caller'

export function needsPrincipalResolution(request: RpcRequest): boolean {
  return (
    request.orchestrationPrincipal !== undefined ||
    ORCHESTRATION_PRINCIPAL_VERB_METHODS.some((method) => method === request.method)
  )
}

export function resolveOrchestrationPrincipalCaller(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  route?: OrchestrationRequestRoute
): ResolvedOrchestrationRequest {
  const refuse = (code: string): never => {
    throw new OrchestrationError(code, code, { effectsApplied: false })
  }
  if (
    request.orchestrationRuntimeId !== undefined &&
    request.orchestrationRuntimeId !== runtime.getRuntimeId()
  ) {
    refuse('principal_runtime_mismatch')
  }
  const envelope = request.orchestrationPrincipal
  const evidence = request.orchestrationCompatibilityEvidence
  if (route?.pairedDeviceId || evidence?.host) {
    refuse('principal_host_boundary')
  }
  const params =
    request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? { ...request.params }
      : {}
  const values: Record<string, unknown> = params
  if (
    request.orchestrationCapability ||
    evidence?.terminalHandle ||
    evidence?.paneKey ||
    evidence?.agentSessionId ||
    values.from !== undefined ||
    (values.terminal !== undefined && request.method !== 'orchestration.workerStart') ||
    values.callerTerminalHandle !== undefined ||
    values.terminalPaneKey !== undefined
  ) {
    refuse('ambiguous_coordinator_routing')
  }
  if (!ORCHESTRATION_PRINCIPAL_METHODS.has(request.method)) {
    refuse('principal_method_unsupported')
  }
  const db = runtime.getOrchestrationDb()
  const principalId = envelope?.principalId ?? values.principal
  const runId = envelope?.runId ?? values.run
  if (
    typeof principalId === 'string' &&
    typeof runId === 'string' &&
    (request.method === 'orchestration.principalShow' ||
      request.method === 'orchestration.principalRetire')
  ) {
    const retired = db.findRetiredPrincipalView(principalId)
    if (retired?.runId === runId) {
      if (
        (values.principal !== undefined && values.principal !== principalId) ||
        (values.run !== undefined && values.run !== runId)
      ) {
        refuse('ambiguous_coordinator_routing')
      }
      if (request.method === 'orchestration.principalShow') {
        return { request, principalReplay: { principal: retired, blockers: [] } }
      }
      if (values.expectedGeneration !== retired.generation) {
        refuse('principal_retired')
      }
      return {
        request,
        principalReplay: { principal: retired, retired: true, blockers: [], effectsApplied: false }
      }
    }
  }
  if (!envelope) {
    if (request.method === 'orchestration.principalCreate') {
      return { request }
    }
    return refuse('principal_capability_invalid')
  }
  if (
    typeof envelope.principalId !== 'string' ||
    !envelope.principalId ||
    typeof envelope.runId !== 'string' ||
    !envelope.runId ||
    !Number.isSafeInteger(envelope.generation) ||
    envelope.generation < 1 ||
    typeof envelope.capability !== 'string' ||
    !/^ccap_[A-Za-z0-9_-]{43}$/.test(envelope.capability)
  ) {
    refuse('principal_capability_invalid')
  }
  if (
    (values.run !== undefined && values.run !== envelope.runId) ||
    (values.principal !== undefined && values.principal !== envelope.principalId)
  ) {
    refuse('ambiguous_coordinator_routing')
  }
  if (request.method === 'orchestration.principalReplace') {
    if (
      typeof values.childId !== 'string' ||
      typeof values.capabilityHash !== 'string' ||
      values.reason !== 'loss' ||
      typeof values.expectedGeneration !== 'number' ||
      !request.orchestrationRequestId
    ) {
      return refuse('invalid_argument')
    }
    const replay = db.authenticatePrincipalRotationReplay(envelope, {
      principalId: envelope.principalId,
      runId: envelope.runId,
      expectedGeneration: values.expectedGeneration,
      childId: values.childId,
      capabilityHash: values.capabilityHash,
      reason: values.reason,
      requestId: request.orchestrationRequestId
    })
    if (replay) {
      return { request, principalReplay: replay }
    }
  }
  if (request.method === 'orchestration.principalCreate') {
    return refuse('principal_method_unsupported')
  }
  const { authority } = db.authenticatePrincipal(envelope)
  assertPrincipalResourceScope(db, request.method, values, authority.runId)
  if (
    isOrchestrationMutation(request.method, values) &&
    values.expectedGeneration !== authority.generation
  ) {
    refuse('stale_generation')
  }
  const principal = db.getCoordinatorPrincipalRow(authority.principalId)
  if (!principal?.workspace_id) {
    return refuse('principal_root_unregistered')
  }
  const caller = {
    address: `run:${authority.runId}`,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: null,
    workspaceId: principal.workspace_id,
    principal: authority
  } as const
  const callerKey = ORCHESTRATION_CALLER_PARAM[request.method]
  return {
    request: {
      ...request,
      params: {
        ...values,
        principal: authority.principalId,
        run: authority.runId,
        ...(callerKey ? { [callerKey]: caller.address } : {})
      }
    },
    caller,
    principal: authority
  }
}
