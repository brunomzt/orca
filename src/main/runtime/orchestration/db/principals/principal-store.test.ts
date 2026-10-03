import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { hashCoordinatorPrincipalCapability } from './principal-capability-hash'
import {
  MANAGER_SESSION_ID,
  createTestPrincipal,
  expectOrchestrationError,
  principalSnapshot
} from './principal-test-fixture'

const PANE = 'tab:11111111-1111-4111-8111-111111111111'

describe('coordinator principal store', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  function target(principal: { id: string; runId: string; generation: number }) {
    return {
      principalId: principal.id,
      runId: principal.runId,
      expectedGeneration: principal.generation
    }
  }

  it('creates a principal on its own Run with no coordinator terminal and no capability data', () => {
    const principal = createTestPrincipal(db)
    expect(principal).toMatchObject({
      provider: 'claude',
      childId: 'child-one',
      project: 'my-orca',
      generation: 1,
      lifecycle: 'active',
      state: 'idle-retained',
      retirementRequested: false,
      intakeClosed: false,
      coordinatorHandle: null,
      launch: { requested: { speed: 'standard' } }
    })
    expect(JSON.stringify(principal)).not.toMatch(/capability|hash/i)
    expect(db.getRunRaw(principal.runId)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_orca_session_id: null,
      coordinator_principal_id: principal.id
    })
  })

  it('allows one live principal per project and per Run', () => {
    const principal = createTestPrincipal(db)
    expect(
      expectOrchestrationError(() => createTestPrincipal(db), 'principal_exists')
    ).toMatchObject({ data: { principalId: principal.id, generation: 1, effectsApplied: false } })
    expectOrchestrationError(
      () => createTestPrincipal(db, { project: 'other', runId: principal.runId }),
      'principal_exists'
    )
  })

  it('retains an unbound Run but refuses one bound to a terminal coordinator', () => {
    const bound = db.createRun({
      objective: 'terminal',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: PANE
    })
    expectOrchestrationError(
      () => createTestPrincipal(db, { runId: bound.id }),
      'run_bound_to_coordinator'
    )
    db.db
      .prepare(
        'UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL WHERE id = ?'
      )
      .run(bound.id)
    expect(createTestPrincipal(db, { runId: bound.id }).runId).toBe(bound.id)
  })

  it('refuses a terminal or session binding a principal-owned Run with run_owned_by_principal', () => {
    const principal = createTestPrincipal(db)
    const before = principalSnapshot(db, principal.id)
    expectOrchestrationError(
      () =>
        db.bindRun({
          runId: principal.runId,
          coordinatorHandle: 'term_x',
          coordinatorPaneKey: PANE
        }),
      'run_owned_by_principal'
    )
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('rejects a same-generation reconnect with a different childId, naming fields only', () => {
    const principal = createTestPrincipal(db)
    db.markPrincipalRecovering(target(principal))
    const before = principalSnapshot(db, principal.id)
    const error = expectOrchestrationError(
      () =>
        db.reconnectPrincipal({
          ...target(principal),
          provider: 'codex',
          managerSessionId: 'another-manager-session-value',
          childId: 'child-two'
        }),
      'principal_identity_mismatch'
    )
    expect(error).toMatchObject({
      data: { fields: ['provider', 'managerSessionId', 'childId'], effectsApplied: false }
    })
    const text = JSON.stringify({ error, message: String(error) })
    expect(text).not.toContain('another-manager-session-value')
    expect(text).not.toContain(MANAGER_SESSION_ID)
    expect(text).not.toContain('child-two')
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('reconnects the same child at the same generation without changing identity', () => {
    const principal = createTestPrincipal(db)
    db.markPrincipalRecovering({ ...target(principal), reason: 'heartbeat lost' })
    const result = db.reconnectPrincipal({
      ...target(principal),
      provider: 'claude',
      managerSessionId: MANAGER_SESSION_ID,
      childId: 'child-one'
    })
    expect(result.principal).toMatchObject({ lifecycle: 'active', generation: 1 })
    expect(db.getRunRaw(principal.runId)?.consumer_generation).toBe(1)
  })

  it('refuses writes from an older generation with stale_generation and from a future one', () => {
    const principal = createTestPrincipal(db)
    db.markPrincipalRecovering(target(principal))
    db.replacePrincipal({
      ...target(principal),
      requestId: 'req-1',
      reason: 'loss',
      childId: 'child-two',
      capabilityHash: hashCoordinatorPrincipalCapability('ccap_two')
    })
    const before = principalSnapshot(db, principal.id)
    expect(
      expectOrchestrationError(
        () => db.setRunIntake({ ...target(principal), closed: true }),
        'stale_generation'
      )
    ).toMatchObject({ data: { currentGeneration: 2, effectsApplied: false } })
    expectOrchestrationError(
      () => db.markPrincipalRecovering(target(principal)),
      'stale_generation'
    )
    expectOrchestrationError(
      () => db.markPrincipalRecovering({ ...target(principal), expectedGeneration: 9 }),
      'principal_generation_unknown'
    )
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('keeps retirement requested through recovering, reconnect and replacement', () => {
    const principal = createTestPrincipal(db)
    const requested = db.retirePrincipal({ ...target(principal), request: true })
    expect(requested.principal).toMatchObject({
      lifecycle: 'retirement-requested',
      retirementRequested: true,
      intakeClosed: true
    })
    const recovering = db.markPrincipalRecovering(target(principal)).principal
    expect(recovering).toMatchObject({ lifecycle: 'recovering', retirementRequested: true })
    const reconnected = db.reconnectPrincipal({
      ...target(principal),
      provider: 'claude',
      managerSessionId: MANAGER_SESSION_ID,
      childId: 'child-one'
    }).principal
    expect(reconnected).toMatchObject({
      lifecycle: 'retirement-requested',
      retirementRequested: true
    })
    db.markPrincipalRecovering(target(principal))
    const replaced = db.replacePrincipal({
      ...target(principal),
      requestId: 'req-1',
      reason: 'loss',
      childId: 'child-two',
      capabilityHash: hashCoordinatorPrincipalCapability('ccap_two')
    }).principal
    expect(replaced).toMatchObject({
      generation: 2,
      lifecycle: 'retirement-requested',
      retirementRequested: true,
      intakeClosed: true
    })
  })

  it('requesting retirement while recovering keeps recovering and records the intent', () => {
    const principal = createTestPrincipal(db)
    db.markPrincipalRecovering(target(principal))
    const requested = db.retirePrincipal({ ...target(principal), request: true }).principal
    expect(requested).toMatchObject({ lifecycle: 'recovering', retirementRequested: true })
  })

  it('refuses reopening intake once retirement is requested with retirement_requested', () => {
    const principal = createTestPrincipal(db)
    db.retirePrincipal({ ...target(principal), request: true })
    const before = principalSnapshot(db, principal.id)
    expectOrchestrationError(
      () => db.setRunIntake({ ...target(principal), closed: false }),
      'retirement_requested'
    )
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('closes and reopens intake under the generation CAS', () => {
    const principal = createTestPrincipal(db)
    expect(db.setRunIntake({ ...target(principal), closed: true })).toMatchObject({
      runId: principal.runId,
      intakeClosed: true,
      principal: { intakeClosed: true }
    })
    expect(db.setRunIntake({ ...target(principal), closed: false }).intakeClosed).toBe(false)
  })

  it('retires to an id-only view with no capability hash, and a retire replay has no effects', () => {
    const principal = createTestPrincipal(db)
    const retired = db.retirePrincipal(target(principal))
    expect(retired).toMatchObject({ retired: true, effectsApplied: true })
    expect(db.getCoordinatorPrincipalRow(principal.id)).toMatchObject({
      lifecycle: 'retired',
      capability_hash: null
    })
    const view = db.findRetiredPrincipalView(principal.id)
    expect(view).toMatchObject({ lifecycle: 'retired', retirementRequested: true })
    expect(JSON.stringify(view)).not.toMatch(/capability|hash/i)

    const before = principalSnapshot(db, principal.id)
    const replay = db.retirePrincipal(target(principal))
    expect(replay).toEqual({ principal: view, retired: true, blockers: [], effectsApplied: false })
    const requestReplay = db.retirePrincipal({ ...target(principal), request: true })
    expect(requestReplay.effectsApplied).toBe(false)
    expect(principalSnapshot(db, principal.id)).toEqual(before)

    expectOrchestrationError(
      () => db.setRunIntake({ ...target(principal), closed: false }),
      'principal_retired'
    )
    expectOrchestrationError(
      () =>
        db.authenticatePrincipal({
          principalId: principal.id,
          runId: principal.runId,
          generation: 1,
          capability: 'ccap_one'
        }),
      'principal_retired'
    )
    expectOrchestrationError(
      () =>
        db.bindRun({
          runId: principal.runId,
          coordinatorHandle: 'term_x',
          coordinatorPaneKey: PANE
        }),
      'run_owned_by_principal'
    )
  })

  it('only answers the retired view for retired principals', () => {
    const principal = createTestPrincipal(db)
    expect(db.findRetiredPrincipalView(principal.id)).toBeUndefined()
  })

  it('refuses final retirement while blockers remain, applying nothing', () => {
    const principal = createTestPrincipal(db)
    const task = db.createTask({ spec: 'open work', runId: principal.runId })
    const before = principalSnapshot(db, principal.id)
    expect(
      expectOrchestrationError(() => db.retirePrincipal(target(principal)), 'retirement_blocked')
    ).toMatchObject({
      data: { blockers: [{ kind: 'unfinished_task', id: task.id }], effectsApplied: false }
    })
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('authenticates only the current generation secret', () => {
    const principal = createTestPrincipal(db)
    const envelope = {
      principalId: principal.id,
      runId: principal.runId,
      generation: 1,
      capability: 'ccap_one'
    }
    expect(db.authenticatePrincipal(envelope).authority).toEqual({
      principalId: principal.id,
      runId: principal.runId,
      generation: 1
    })
    expectOrchestrationError(
      () => db.authenticatePrincipal({ ...envelope, capability: 'ccap_wrong' }),
      'principal_capability_invalid'
    )
    expectOrchestrationError(
      () => db.authenticatePrincipal({ ...envelope, runId: 'run_other' }),
      'principal_not_found'
    )
  })
})

describe('coordinator principal rotation', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  const NEW_HASH = hashCoordinatorPrincipalCapability('ccap_two')

  function recoveringPrincipal(project = 'my-orca', capability = 'ccap_one') {
    const principal = createTestPrincipal(db, { project, capability })
    db.markPrincipalRecovering({
      principalId: principal.id,
      runId: principal.runId,
      expectedGeneration: 1,
      reason: 'child lost'
    })
    return principal
  }

  function replaceRequest(principal: { id: string; runId: string }) {
    return {
      principalId: principal.id,
      runId: principal.runId,
      expectedGeneration: 1,
      requestId: 'req-rotate-1',
      reason: 'loss',
      childId: 'child-two',
      capabilityHash: NEW_HASH
    }
  }

  function envelope(
    principal: { id: string; runId: string },
    generation: number,
    capability: string
  ) {
    return { principalId: principal.id, runId: principal.runId, generation, capability }
  }

  it('requires principal-recovering before replacement with principal_not_recovering', () => {
    const principal = createTestPrincipal(db)
    const before = principalSnapshot(db, principal.id)
    expectOrchestrationError(
      () => db.replacePrincipal(replaceRequest(principal)),
      'principal_not_recovering'
    )
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('accepts only reason loss, a different childId and a new capability hash', () => {
    const principal = recoveringPrincipal()
    const before = principalSnapshot(db, principal.id)
    const request = replaceRequest(principal)
    expectOrchestrationError(
      () => db.replacePrincipal({ ...request, reason: 'update' }),
      'invalid_argument'
    )
    expectOrchestrationError(
      () => db.replacePrincipal({ ...request, childId: 'child-one' }),
      'invalid_argument'
    )
    expectOrchestrationError(
      () =>
        db.replacePrincipal({
          ...request,
          capabilityHash: hashCoordinatorPrincipalCapability('ccap_one')
        }),
      'principal_capability_invalid'
    )
    expect(principalSnapshot(db, principal.id)).toEqual(before)
  })

  it('fences the old generation and its Run mail but leaves worker Dispatch capabilities alone', () => {
    const principal = recoveringPrincipal()
    const task = db.createTask({ spec: 'worker task', runId: principal.runId })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'terminal', handle: 'term_worker', paneKey: PANE },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db
      .prepare("UPDATE dispatch_contexts SET capability_hash = 'worker-hash' WHERE id = ?")
      .run(dispatch.id)
    db.insertMessage({
      runId: principal.runId,
      from: 'term_worker',
      to: `run:${principal.runId}`,
      subject: 'progress'
    })
    const delivery = db.getOrCreateRunDelivery({ runId: principal.runId, consumerGeneration: 1 })
    const deliveryId = delivery?.delivery.id ?? ''

    const receipt = db.replacePrincipal(replaceRequest(principal))
    expect(receipt).toMatchObject({
      fencedGeneration: 1,
      replayed: false,
      principal: { generation: 2, childId: 'child-two', lifecycle: 'active' }
    })
    expect(JSON.stringify(receipt)).not.toMatch(/ccap_|[0-9a-f]{64}/)
    expect(db.getDeliveryRaw(deliveryId)?.status).toBe('fenced')
    expect(db.getRunRaw(principal.runId)?.consumer_generation).toBe(2)
    expect(db.getDispatchContextById(dispatch.id)?.capability_hash).toBe('worker-hash')
  })

  it('rotation crash before send: nothing pending server-side and the old secret still works', () => {
    const principal = recoveringPrincipal()
    expect(db.findPrincipalRotation(principal.id, 'req-rotate-1')).toBeUndefined()
    expect(db.authenticatePrincipal(envelope(principal, 1, 'ccap_one')).lifecycle).toBe(
      'recovering'
    )
    expect(db.replacePrincipal(replaceRequest(principal)).replayed).toBe(false)
  })

  it('rotation committed but response lost: the old secret replays only that exact replacement', () => {
    const principal = recoveringPrincipal()
    const original = db.replacePrincipal(replaceRequest(principal))
    const after = principalSnapshot(db, principal.id)
    const oldEnvelope = envelope(principal, 1, 'ccap_one')

    expectOrchestrationError(() => db.authenticatePrincipal(oldEnvelope), 'stale_generation')
    expect(db.authenticatePrincipalRotationReplay(oldEnvelope, replaceRequest(principal))).toEqual({
      ...original,
      replayed: true
    })
    expect(db.replacePrincipal(replaceRequest(principal))).toEqual({ ...original, replayed: true })
    expect(
      db.authenticatePrincipalRotationReplay(oldEnvelope, {
        ...replaceRequest(principal),
        requestId: 'req-other'
      })
    ).toBeUndefined()
    expectOrchestrationError(
      () =>
        db.authenticatePrincipalRotationReplay(
          envelope(principal, 1, 'ccap_wrong'),
          replaceRequest(principal)
        ),
      'principal_capability_invalid'
    )
    expect(principalSnapshot(db, principal.id)).toEqual(after)
  })

  it('rotation pending local promotion: the new secret authenticates and may also replay', () => {
    const principal = recoveringPrincipal()
    const original = db.replacePrincipal(replaceRequest(principal))
    const newEnvelope = envelope(principal, 2, 'ccap_two')
    expect(db.authenticatePrincipal(newEnvelope).authority.generation).toBe(2)
    expect(db.authenticatePrincipalRotationReplay(newEnvelope, replaceRequest(principal))).toEqual({
      ...original,
      replayed: true
    })
  })

  it('rotation replay after a later rotation returns the original receipt and leaves the later generation', () => {
    const principal = recoveringPrincipal()
    const first = db.replacePrincipal(replaceRequest(principal))
    db.markPrincipalRecovering({
      principalId: principal.id,
      runId: principal.runId,
      expectedGeneration: 2
    })
    db.replacePrincipal({
      ...replaceRequest(principal),
      expectedGeneration: 2,
      requestId: 'req-rotate-2',
      childId: 'child-three',
      capabilityHash: hashCoordinatorPrincipalCapability('ccap_three')
    })
    const later = principalSnapshot(db, principal.id)
    expect(
      db.authenticatePrincipalRotationReplay(
        envelope(principal, 1, 'ccap_one'),
        replaceRequest(principal)
      )
    ).toEqual({ ...first, replayed: true })
    expect(db.replacePrincipal(replaceRequest(principal))).toEqual({ ...first, replayed: true })
    expect(principalSnapshot(db, principal.id)).toEqual(later)
    expect(db.getCoordinatorPrincipalRow(principal.id)).toMatchObject({
      generation: 3,
      child_id: 'child-three'
    })
    expectOrchestrationError(
      () => db.authenticatePrincipal(envelope(principal, 1, 'ccap_one')),
      'stale_generation'
    )
  })

  it('rotation replay with an altered childId, reason, hash or generation is request_mismatch', () => {
    const principal = recoveringPrincipal()
    db.replacePrincipal(replaceRequest(principal))
    const after = principalSnapshot(db, principal.id)
    const oldEnvelope = envelope(principal, 1, 'ccap_one')
    for (const altered of [
      { childId: 'child-other' },
      { reason: 'update' },
      { capabilityHash: hashCoordinatorPrincipalCapability('ccap_other') },
      { expectedGeneration: 2 }
    ]) {
      const request = { ...replaceRequest(principal), ...altered }
      expectOrchestrationError(
        () => db.authenticatePrincipalRotationReplay(oldEnvelope, request),
        'request_mismatch'
      )
      expectOrchestrationError(() => db.replacePrincipal(request), 'request_mismatch')
    }
    expect(principalSnapshot(db, principal.id)).toEqual(after)
  })

  it('refuses rotation replay across principals and Runs', () => {
    const first = recoveringPrincipal('project-a', 'ccap_a')
    const second = recoveringPrincipal('project-b', 'ccap_b')
    db.replacePrincipal(replaceRequest(first))
    const firstAfter = principalSnapshot(db, first.id)
    const secondBefore = principalSnapshot(db, second.id)

    expectOrchestrationError(
      () =>
        db.authenticatePrincipalRotationReplay(
          envelope(second, 1, 'ccap_b'),
          replaceRequest(first)
        ),
      'principal_capability_invalid'
    )
    expect(
      db.authenticatePrincipalRotationReplay(envelope(second, 1, 'ccap_b'), replaceRequest(second))
    ).toBeUndefined()
    expectOrchestrationError(
      () =>
        db.authenticatePrincipalRotationReplay(
          { ...envelope(first, 1, 'ccap_a'), runId: second.runId },
          { ...replaceRequest(first), runId: second.runId }
        ),
      'principal_not_found'
    )
    expectOrchestrationError(
      () => db.replacePrincipal({ ...replaceRequest(first), runId: second.runId }),
      'request_mismatch'
    )
    expect(principalSnapshot(db, first.id)).toEqual(firstAfter)
    expect(principalSnapshot(db, second.id)).toEqual(secondBefore)
  })

  it('refuses rotation replay once the principal is retired', () => {
    const principal = recoveringPrincipal()
    db.replacePrincipal(replaceRequest(principal))
    db.retirePrincipal({ principalId: principal.id, runId: principal.runId, expectedGeneration: 2 })
    expectOrchestrationError(
      () =>
        db.authenticatePrincipalRotationReplay(
          envelope(principal, 1, 'ccap_one'),
          replaceRequest(principal)
        ),
      'principal_retired'
    )
  })
})
