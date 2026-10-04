import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { hashCoordinatorPrincipalCapability } from './principal-capability-hash'
import { createTestPrincipal, expectOrchestrationError } from './principal-test-fixture'

describe('Run intake closure and principal admission', () => {
  let db: OrchestrationDb
  let principal: ReturnType<typeof createTestPrincipal>
  let fence: { principalId: string; runId: string; expectedGeneration: number }
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    principal = createTestPrincipal(db)
    fence = { principalId: principal.id, runId: principal.runId, expectedGeneration: 1 }
  })
  afterEach(() => {
    db.close()
  })

  function closeIntake(): void {
    db.setRunIntake({ ...fence, closed: true })
  }
  function counts() {
    return db.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM tasks) AS tasks,
                (SELECT COUNT(*) FROM dispatch_contexts) AS dispatches,
                (SELECT COUNT(*) FROM worker_dispatches) AS workers,
                (SELECT COUNT(*) FROM mutation_receipts) AS receipts`
      )
      .get()
  }
  function startWorker(params: { taskId?: string; taskSpec?: string; retryOf?: string }) {
    return db.createStartingWorkerDispatch({
      ...params,
      taskRunId: params.taskSpec ? principal.runId : undefined,
      startOptions: {},
      mutationReceipt: {
        callerFingerprint: 'principal-caller',
        requestId: `req-${params.retryOf ?? params.taskId ?? params.taskSpec}`,
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      },
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
  }

  it('refuses a new task with intake_closed and creates nothing', () => {
    closeIntake()
    const before = counts()
    expect(
      expectOrchestrationError(
        () => db.createTask({ spec: 'late', runId: principal.runId }),
        'intake_closed'
      )
    ).toMatchObject({ data: { runId: principal.runId, effectsApplied: false } })
    expect(counts()).toEqual(before)
  })

  it('refuses worker start for an existing task, a spec task and a retry, leaving no receipt', () => {
    const task = db.createTask({ spec: 'ready', runId: principal.runId })
    const failed = db.createTask({ spec: 'retry me', runId: principal.runId })
    const prior = startWorker({ taskId: failed.id })
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?")
      .run(prior.dispatch.id)
    db.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(failed.id)
    closeIntake()
    const before = counts()
    expectOrchestrationError(() => startWorker({ taskId: task.id }), 'intake_closed')
    expectOrchestrationError(() => startWorker({ taskSpec: 'inline' }), 'intake_closed')
    expectOrchestrationError(
      () => startWorker({ taskId: failed.id, retryOf: prior.dispatch.id }),
      'intake_closed'
    )
    expect(counts()).toEqual(before)
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('checks intake_closed inside the createDispatchContext savepoint, rolling back only itself', () => {
    const task = db.createTask({ spec: 'ready', runId: principal.runId })
    closeIntake()
    db.db.exec('BEGIN IMMEDIATE')
    db.insertMessage({ runId: principal.runId, from: 'term_a', to: 'term_b', subject: 'outer' })
    expectOrchestrationError(
      () =>
        db.createDispatchContext({
          taskId: task.id,
          assigneeHandle: 'term_worker',
          creator: { kind: 'terminal', handle: 'term_coord' },
          maxDepth: Number.MAX_SAFE_INTEGER
        }),
      'intake_closed'
    )
    db.db.exec('COMMIT')
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE subject = 'outer'").get()
    ).toEqual({ count: 1 })
  })

  it('admits work again after intake reopens', () => {
    closeIntake()
    db.setRunIntake({ ...fence, closed: false })
    expect(db.createTask({ spec: 'again', runId: principal.runId }).run_id).toBe(principal.runId)
  })

  it('refuses a fenced write from a stale or recovering principal before any insert', () => {
    db.markPrincipalRecovering(fence)
    expectOrchestrationError(
      () => db.createTask({ spec: 'x', runId: principal.runId, principalFence: fence }),
      'principal_recovering'
    )
    db.replacePrincipal({
      ...fence,
      requestId: 'req-1',
      reason: 'loss',
      childId: 'child-two',
      capabilityHash: hashCoordinatorPrincipalCapability('ccap_two')
    })
    const before = counts()
    expectOrchestrationError(
      () => db.createTask({ spec: 'x', runId: principal.runId, principalFence: fence }),
      'stale_generation'
    )
    expect(counts()).toEqual(before)
    expect(
      db.createTask({
        spec: 'x',
        runId: principal.runId,
        principalFence: { ...fence, expectedGeneration: 2 }
      }).run_id
    ).toBe(principal.runId)
  })

  it('refuses a fenced write aimed at a Run the principal does not own', () => {
    const other = db.createRun({
      objective: 'other',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    expectOrchestrationError(
      () => db.createTask({ spec: 'x', runId: other.id, principalFence: fence }),
      'principal_not_found'
    )
  })
})
