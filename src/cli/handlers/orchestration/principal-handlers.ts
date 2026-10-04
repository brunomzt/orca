import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { CommandHandler, HandlerContext } from '../../dispatch'
import { getOptionalStringFlag } from '../../flags'
import { printResult } from '../../format'
import { RuntimeClientError } from '../../runtime/types'
import type { CoordinatorPrincipalView } from '../../../shared/orchestration-principal-contract'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  PrincipalCreateParams,
  PrincipalReplaceParams
} from '../../../shared/rpc-contract/orchestration-principal-params'
import {
  assertDistinctRotationPath,
  committedPrincipalCapability,
  newPendingPrincipalCapability,
  createPrincipalCapabilityFile,
  principalCapabilityHash,
  readPrincipalCapabilityFile,
  writePrincipalCapabilityFile
} from './principal-capability-file'
import { requirePrincipalRuntime } from '../../runtime/principal-route'
import { callOrchestrationMutation } from './mutation-request'

function required(ctx: HandlerContext, key: string): string {
  const value = getOptionalStringFlag(ctx.flags, key)
  if (!value) {
    throw new RuntimeClientError('invalid_argument', `Missing --${key}`)
  }
  return value
}

async function rotateOrCreate(ctx: HandlerContext, create: boolean): Promise<void> {
  const { flags, client, json } = ctx
  const status = await client.call<RuntimeStatus>('status.get')
  requirePrincipalRuntime(status.result, status._meta.runtimeId)
  const output = required(ctx, create ? 'capability-file' : 'new-capability-file')
  if (!create) {
    assertDistinctRotationPath(required(ctx, 'capability-file'), output)
  }
  const retry = getOptionalStringFlag(flags, 'retry-request')
  const requestId = retry ?? randomUUID()
  let file = newPendingPrincipalCapability(status._meta.runtimeId, requestId)
  const fileExists = existsSync(output)
  if (fileExists) {
    file = readPrincipalCapabilityFile(output, status._meta.runtimeId)
    if (!retry || file.requestId !== retry) {
      throw new RuntimeClientError(
        'request_mismatch',
        'Existing capability needs its original retry request.'
      )
    }
  }
  const params = create
    ? {
        provider: required(ctx, 'provider'),
        managerSessionId: required(ctx, 'manager-session-id'),
        childId: required(ctx, 'child-id'),
        project: required(ctx, 'project'),
        rootPath: required(ctx, 'root-path'),
        objective: getOptionalStringFlag(flags, 'objective'),
        generation: flags.has('generation') ? Number(required(ctx, 'generation')) : 1,
        run: getOptionalStringFlag(flags, 'run'),
        speed: required(ctx, 'speed')
      }
    : {
        principal: required(ctx, 'principal'),
        run: required(ctx, 'run'),
        expectedGeneration: Number(required(ctx, 'expected-generation')),
        childId: required(ctx, 'child-id'),
        reason: required(ctx, 'reason')
      }
  const parsed = (create ? PrincipalCreateParams : PrincipalReplaceParams).safeParse({
    ...params,
    capabilityHash: principalCapabilityHash(file)
  })
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid principal creation or replacement parameters.'
    )
  }
  if (!fileExists) {
    createPrincipalCapabilityFile(output, file)
  }
  const result = await client.call<{ principal: CoordinatorPrincipalView }>(
    create ? 'orchestration.principalCreate' : 'orchestration.principalReplace',
    parsed.data,
    { orchestrationRequestId: requestId, orchestrationRuntimeId: status._meta.runtimeId }
  )
  const principal = result.result.principal
  const expectedGeneration = create
    ? Number(getOptionalStringFlag(flags, 'generation') ?? '1')
    : Number(required(ctx, 'expected-generation')) + 1
  if (
    !principal ||
    principal.generation !== expectedGeneration ||
    principal.childId !== required(ctx, 'child-id') ||
    (file.state === 'committed' &&
      (file.principalId !== principal.id ||
        file.runId !== principal.runId ||
        file.generation !== principal.generation)) ||
    (!create &&
      (principal.id !== required(ctx, 'principal') || principal.runId !== required(ctx, 'run'))) ||
    (create &&
      (principal.provider !== required(ctx, 'provider') ||
        principal.managerSessionId !== required(ctx, 'manager-session-id') ||
        principal.project !== required(ctx, 'project') ||
        (flags.has('run') && principal.runId !== required(ctx, 'run'))))
  ) {
    throw new RuntimeClientError(
      'request_mismatch',
      'Principal receipt did not match the capability request; the pending file was preserved.'
    )
  }
  const committed = committedPrincipalCapability(file, principal)
  writePrincipalCapabilityFile(output, committed)
  printResult(
    {
      ...result,
      result: {
        ...result.result,
        capabilityFile: { path: output, generation: committed.generation }
      }
    },
    json,
    () => `Principal ${result.result.principal.id}, generation ${committed.generation}`
  )
}

const verbs = {
  'principal-show': 'principalShow',
  'principal-reconnect': 'principalReconnect',
  'principal-recovering': 'principalMarkRecovering',
  'principal-retire': 'principalRetire',
  'run-intake': 'runIntakeSet'
} as const

export const ORCHESTRATION_PRINCIPAL_HANDLERS: Record<string, CommandHandler> = {
  'orchestration principal-create': (ctx) => rotateOrCreate(ctx, true),
  'orchestration principal-replace': (ctx) => rotateOrCreate(ctx, false)
}
for (const [verb, method] of Object.entries(verbs)) {
  ORCHESTRATION_PRINCIPAL_HANDLERS[`orchestration ${verb}`] = async (ctx) => {
    const { flags, client, json } = ctx
    for (const flag of ['request', 'close', 'open']) {
      if (flags.has(flag) && flags.get(flag) !== true) {
        throw new RuntimeClientError('invalid_argument', `--${flag} does not take a value.`)
      }
    }
    const params = {
      principal: required(ctx, 'principal'),
      run: required(ctx, 'run'),
      ...(flags.has('expected-generation')
        ? { expectedGeneration: Number(required(ctx, 'expected-generation')) }
        : {}),
      provider: getOptionalStringFlag(flags, 'provider'),
      managerSessionId: getOptionalStringFlag(flags, 'manager-session-id'),
      childId: getOptionalStringFlag(flags, 'child-id'),
      reason: getOptionalStringFlag(flags, 'reason'),
      ...(flags.has('request') ? { request: true } : {}),
      ...(verb === 'run-intake' ? { closed: flags.has('close') } : {})
    }
    if (verb === 'run-intake' && flags.has('close') === flags.has('open')) {
      throw new RuntimeClientError('invalid_argument', 'Choose exactly one of --close and --open.')
    }
    const result =
      verb === 'principal-show'
        ? await client.call(`orchestration.${method}`, params)
        : await callOrchestrationMutation(client, flags, `orchestration.${method}`, params)
    printResult(result, json, () => JSON.stringify(result.result, null, 2))
  }
}
