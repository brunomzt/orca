import type { HandlerContext } from '../../dispatch'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime/types'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { readPrincipalCapabilityFile } from './principal-capability-file'
import { requirePrincipalRuntime } from '../../runtime/principal-route'

export async function configurePrincipalRouting(
  ctx: HandlerContext,
  command: string
): Promise<void> {
  const { flags, client } = ctx
  const principal = getOptionalStringFlag(flags, 'principal')
  const run = getOptionalStringFlag(flags, 'run')
  const path = getOptionalStringFlag(flags, 'capability-file')
  const create = command === 'orchestration principal-create'
  const retiredView =
    !path &&
    (command === 'orchestration principal-show' || command === 'orchestration principal-retire')
  if (!principal && !path && process.env.ORCA_COORDINATOR_ROUTING !== 'principal') {
    return
  }
  if (
    process.env.ORCA_COORDINATOR_ROUTING !== 'principal' ||
    process.env.ORCA_TERMINAL_HANDLE ||
    process.env.ORCA_PANE_KEY ||
    process.env.ORCA_AGENT_SESSION_ID ||
    flags.has('from') ||
    flags.has('dispatch-capability') ||
    (flags.has('terminal') && command !== 'orchestration worker-start') ||
    (!create && (!principal || !run || (!path && !retiredView))) ||
    (create && (!path || principal))
  ) {
    throw new RuntimeClientError(
      'ambiguous_coordinator_routing',
      'Use one complete principal identity and no terminal identity.'
    )
  }
  if (
    client.isRemote ||
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP
  ) {
    throw new RuntimeClientError('principal_host_boundary', 'Principal routing is local only.')
  }
  const status = await client.call<RuntimeStatus>('status.get')
  requirePrincipalRuntime(status.result, status._meta.runtimeId)
  if (create || retiredView) {
    return
  }
  const file = readPrincipalCapabilityFile(path!, status._meta.runtimeId)
  if (
    file.state !== 'committed' ||
    file.principalId !== principal ||
    file.runId !== run ||
    file.generation === null
  ) {
    throw new RuntimeClientError(
      'principal_capability_invalid',
      'Capability identity does not match the request.'
    )
  }
  const expected = getOptionalStringFlag(flags, 'expected-generation')
  const generation = expected === undefined ? undefined : Number(expected)
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Expected generation must be a positive integer.'
    )
  }
  client.setPrincipalRoute({
    runtimeId: file.runtimeId,
    expectedGeneration: generation,
    envelope: {
      principalId: principal!,
      runId: run!,
      generation: file.generation,
      capability: file.capability
    }
  })
}
