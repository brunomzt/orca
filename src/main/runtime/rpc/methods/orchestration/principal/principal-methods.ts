import { isWslUncPath } from '../../../../../../shared/wsl-paths'
import { assertPrincipalLocalWorkspace } from '../../../principal-workspace-boundary'
import { principalResumeSnapshot } from '../../../../orchestration/db/principals/principal-resume-snapshot'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { defineMethod, type RpcContext } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  PrincipalCreateParams,
  PrincipalTargetParams,
  PrincipalReconnectParams,
  PrincipalRecoveringParams,
  PrincipalReplaceParams,
  PrincipalRetireParams,
  PrincipalIntakeParams
} from '../../../../../../shared/rpc-contract/orchestration-principal-params'

function target(
  params: { principal: string; run: string; expectedGeneration: number },
  ctx: RpcContext
) {
  const authority = ctx.orchestrationPrincipal
  if (
    !authority ||
    authority.principalId !== params.principal ||
    authority.runId !== params.run ||
    authority.generation !== params.expectedGeneration
  ) {
    throw new OrchestrationError('principal_capability_invalid', 'Principal authority is required.')
  }
  return {
    principalId: params.principal,
    runId: params.run,
    expectedGeneration: params.expectedGeneration
  }
}

export const ORCHESTRATION_PRINCIPAL_VERBS = [
  defineMethod({
    name: 'orchestration.principalCreate',
    params: PrincipalCreateParams,
    handler: async (params, { runtime }) => {
      if (isWslUncPath(params.rootPath)) {
        throw new OrchestrationError(
          'principal_host_boundary',
          'Principal roots require the owning host.'
        )
      }
      if (!isAbsolute(params.rootPath)) {
        throw new OrchestrationError(
          'principal_root_unregistered',
          'A registered absolute root is required.'
        )
      }
      const root = await realpath(params.rootPath)
      const workspace = await runtime.showManagedTerminalWorkspace(`path:${root}`)
      const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${workspace.id}`)
      assertPrincipalLocalWorkspace(scope)
      if ((await realpath(workspace.path)) !== root) {
        throw new OrchestrationError(
          'principal_root_unregistered',
          'Root does not match its registered workspace.'
        )
      }
      const result = runtime.getOrchestrationDb().createPrincipal({
        ...params,
        rootPath: root,
        workspaceId: workspace.id,
        runId: params.run
      })
      return {
        principal: result.principal,
        run: {
          id: result.run.id,
          objective: result.run.objective,
          coordinatorHandle: null,
          consumerGeneration: result.run.consumer_generation
        }
      }
    }
  }),
  defineMethod({
    name: 'orchestration.principalShow',
    params: PrincipalTargetParams,
    handler: (params, { runtime, orchestrationPrincipal }) => {
      const db = runtime.getOrchestrationDb()
      const principal = db.getPrincipalView(params.principal)
      if (
        !principal ||
        principal.runId !== params.run ||
        (!orchestrationPrincipal && principal.lifecycle !== 'retired')
      ) {
        throw new OrchestrationError('principal_not_found', 'Principal was not found.')
      }
      return { principal, blockers: db.listPrincipalRetirementBlockers(params.run) }
    }
  }),
  defineMethod({
    name: 'orchestration.principalReconnect',
    params: PrincipalReconnectParams,
    handler: (params, ctx) => {
      const db = ctx.runtime.getOrchestrationDb()
      const result = db.reconnectPrincipal({
        ...target(params, ctx),
        provider: params.provider,
        managerSessionId: params.managerSessionId,
        childId: params.childId
      })
      return { ...result, resume: principalResumeSnapshot(db, params.run) }
    }
  }),
  defineMethod({
    name: 'orchestration.principalMarkRecovering',
    params: PrincipalRecoveringParams,
    handler: (params, ctx) =>
      ctx.runtime.getOrchestrationDb().markPrincipalRecovering({
        ...target(params, ctx),
        reason: params.reason
      })
  }),
  defineMethod({
    name: 'orchestration.principalReplace',
    params: PrincipalReplaceParams,
    handler: (params, ctx) => {
      if (!ctx.orchestrationMutation) {
        throw new OrchestrationError('request_id_required', 'A mutation request is required.')
      }
      const result = ctx.runtime.getOrchestrationDb().replacePrincipal({
        ...target(params, ctx),
        childId: params.childId,
        capabilityHash: params.capabilityHash,
        reason: params.reason,
        requestId: ctx.orchestrationMutation.requestId
      })
      ctx.runtime.cancelMessageWaiters(`run:${params.run}`)
      return result
    }
  }),
  defineMethod({
    name: 'orchestration.principalRetire',
    params: PrincipalRetireParams,
    handler: (params, ctx) =>
      ctx.runtime.getOrchestrationDb().retirePrincipal({
        ...target(params, ctx),
        request: params.request
      })
  }),
  defineMethod({
    name: 'orchestration.runIntakeSet',
    params: PrincipalIntakeParams,
    handler: (params, ctx) =>
      ctx.runtime.getOrchestrationDb().setRunIntake({
        ...target(params, ctx),
        closed: params.closed
      })
  })
]
