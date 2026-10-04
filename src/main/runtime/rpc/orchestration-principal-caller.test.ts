import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoordinatorPrincipalView } from '../../../shared/orchestration-principal-contract'
import { hashCoordinatorPrincipalCapability } from '../orchestration/db/principals/principal-capability-hash'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  resultOf,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const CAPABILITY = `ccap_${'a'.repeat(43)}`
const NEXT_CAPABILITY = `ccap_${'b'.repeat(43)}`

describe('principal callers through the RPC dispatcher', () => {
  let h: SessionCallerHarness
  let principal: CoordinatorPrincipalView

  beforeEach(() => {
    h = createSessionCallerHarness({ current: null })
    principal = h.db.createPrincipal({
      provider: 'codex',
      managerSessionId: 'manager-session',
      childId: 'child-one',
      project: 'single-brain',
      rootPath: '/brain',
      workspaceId: 'repo::/brain',
      capabilityHash: hashCoordinatorPrincipalCapability(CAPABILITY)
    }).principal
  })

  afterEach(() => h.close())

  function request(method: string, params: Record<string, unknown> = {}) {
    return {
      ...orchestrationRequest(method, params),
      orchestrationPrincipal: {
        principalId: principal.id,
        runId: principal.runId,
        generation: principal.generation,
        capability: CAPABILITY
      }
    }
  }

  it('reads only its retained Run and exposes no capability', async () => {
    const response = await h.dispatch(request('orchestration.runCurrent'))
    expect(resultOf(response)).toMatchObject({ run: { id: principal.runId } })
    expect(JSON.stringify(response)).not.toContain(CAPABILITY)
  })

  it('refuses a wrong secret and mixed terminal identity before consuming mail', async () => {
    const base = request('orchestration.check')
    const response = await h.dispatch({
      ...base,
      orchestrationPrincipal: { ...base.orchestrationPrincipal, capability: NEXT_CAPABILITY }
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'principal_capability_invalid' } })
    expect(await h.dispatch(request('orchestration.check', { terminal: 'term_other' })))
      .toMatchObject({ ok: false, error: { code: 'ambiguous_coordinator_routing' } })
  })

  it('refuses the paired-client route without accepting principal ownership', async () => {
    expect(await h.dispatchStreaming(request('orchestration.runCurrent'), 'paired-device'))
      .toMatchObject({ ok: false, error: { code: 'principal_host_boundary' } })
  })

  it('refuses another Run and its tasks', async () => {
    const other = h.db.createRun({ objective: 'other', coordinatorHandle: null, coordinatorPaneKey: null })
    const task = h.db.createTask({ runId: other.id, spec: 'other work' })
    expect(await h.dispatch(request('orchestration.runShow', { id: other.id })))
      .toMatchObject({ ok: false, error: { code: 'principal_resource_mismatch' } })
    expect(await h.dispatch(request('orchestration.taskUpdate', {
      id: task.id, status: 'completed', expectedGeneration: 1
    }))).toMatchObject({ ok: false, error: { code: 'principal_resource_mismatch' } })
    expect(h.db.getTask(task.id)?.status).not.toBe('completed')
  })

  it('replays unacknowledged mailbox delivery and acknowledges it once', async () => {
    h.db.insertMessage({
      from: 'term_worker', to: `run:${principal.runId}`, subject: 'result', body: 'done',
      runId: principal.runId
    })
    const first = resultOf(await h.dispatch(request('orchestration.check', { expectedGeneration: 1 })))
    expect(first.messages).toHaveLength(1)
    const second = resultOf(await h.dispatch(request('orchestration.check', { expectedGeneration: 1 })))
    expect(second.deliveryId).toBe(first.deliveryId)
    expect(second.replayed).toBe(true)
    const ack = resultOf(await h.dispatch(request('orchestration.check', {
      ack: first.deliveryId, expectedGeneration: 1
    })))
    expect(ack.messages).toHaveLength(0)
  })

  it('fences the prior generation after replacement while preserving retirement intent', async () => {
    const target = { principalId: principal.id, runId: principal.runId, expectedGeneration: 1 }
    h.db.retirePrincipal({ ...target, request: true })
    h.db.markPrincipalRecovering({ ...target, reason: 'loss' })
    h.db.replacePrincipal({
      ...target, childId: 'child-two', reason: 'loss', requestId: 'replace-one',
      capabilityHash: hashCoordinatorPrincipalCapability(NEXT_CAPABILITY)
    })
    expect(await h.dispatch(request('orchestration.runCurrent')))
      .toMatchObject({ ok: false, error: { code: 'stale_generation' } })
    expect(h.db.getPrincipalView(principal.id)).toMatchObject({
      generation: 2, retirementRequested: true, intakeClosed: true
    })
  })
})
