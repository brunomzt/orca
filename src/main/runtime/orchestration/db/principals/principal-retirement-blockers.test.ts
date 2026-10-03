import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createTestPrincipal } from './principal-test-fixture'

describe('coordinator principal retirement blockers', () => {
  let db: OrchestrationDb
  let runId: string
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runId = createTestPrincipal(db).runId
  })
  afterEach(() => {
    db.close()
  })

  function dispatchFor(spec: string) {
    const task = db.createTask({ spec, runId })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: `term_${spec}`,
      creator: { kind: 'terminal', handle: `term_${spec}` },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    return { task, dispatch }
  }

  function settle(taskId: string, dispatchId: string): void {
    db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(taskId)
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(dispatchId)
  }

  it('has none for an empty Run', () => {
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([])
  })

  it('reports unfinished tasks and pending Dispatches', () => {
    const { task, dispatch } = dispatchFor('a')
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([
      { kind: 'unfinished_task', id: task.id, status: 'dispatched' },
      { kind: 'pending_dispatch', id: dispatch.id, status: 'dispatched' }
    ])
  })

  it('reports a worker start whose outcome is unknown', () => {
    const { task, dispatch } = dispatchFor('b')
    settle(task.id, dispatch.id)
    db.db
      .prepare("INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, 'start_unknown')")
      .run(dispatch.id)
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([
      { kind: 'unknown_dispatch', id: dispatch.id, status: 'start_unknown' }
    ])
  })

  it('reports unread Run mail and its outstanding delivery', () => {
    const message = db.insertMessage({ runId, from: 'term_w', to: `run:${runId}`, subject: 'hi' })
    const delivery = db.getOrCreateRunDelivery({ runId, consumerGeneration: 1 })
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([
      { kind: 'unacked_mail', id: delivery?.delivery.id, status: 'outstanding' },
      { kind: 'unacked_mail', id: message.id, status: 'unread' }
    ])
  })

  it('reports a pending question', () => {
    db.db
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
         VALUES ('msg_q', ?, 'ctx_q', 'term_q')`
      )
      .run(runId)
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([
      { kind: 'pending_question', id: 'msg_q', status: 'pending' }
    ])
  })

  it('reports a pending_gate until it is resolved', () => {
    const { task, dispatch } = dispatchFor('c')
    settle(task.id, dispatch.id)
    const gate = db.createGate({ taskId: task.id, question: 'ship?' })
    db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id)
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([
      { kind: 'pending_gate', id: gate.id, status: 'pending' }
    ])
    db.db.prepare("UPDATE decision_gates SET status = 'resolved' WHERE id = ?").run(gate.id)
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([])
  })

  it('reports reclaimable worker terminals but not retained, released or user-owned ones', () => {
    const { task, dispatch } = dispatchFor('d')
    settle(task.id, dispatch.id)
    const insert = db.db.prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, terminal_handle, ownership_state, release_state
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    insert.run('res_live', dispatch.id, dispatch.id, 'term_d', 'owned', 'requested')
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([
      { kind: 'reclaimable_resource', id: 'res_live', status: 'requested' }
    ])
    for (const [ownership, release] of [
      ['owned', 'retained'],
      ['owned', 'released'],
      ['user_owned', 'not_requested']
    ]) {
      db.db
        .prepare(
          'UPDATE worker_terminal_resources SET ownership_state = ?, release_state = ? WHERE id = ?'
        )
        .run(ownership, release, 'res_live')
      expect(db.listPrincipalRetirementBlockers(runId)).toEqual([])
    }
  })

  it('ignores another Run', () => {
    const other = db.createRun({
      objective: 'other',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    db.createTask({ spec: 'elsewhere', runId: other.id })
    expect(db.listPrincipalRetirementBlockers(runId)).toEqual([])
  })
})
