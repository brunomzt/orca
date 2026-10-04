import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'

const PANE = 'tab:11111111-1111-4111-8111-111111111111'

function schemaShape(db: Database): unknown {
  const columns = (table: string) =>
    db
      .prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`)
      .all()
      .map((column) => JSON.stringify(column))
      .sort()
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name IN ('coordinator_principals', 'coordinator_principal_rotations')
       ORDER BY name`
    )
    .all()
  return {
    runs: columns('runs'),
    principals: columns('coordinator_principals'),
    rotations: columns('coordinator_principal_rotations'),
    indexes
  }
}

describe('migrateV43 coordinator principal schema', () => {
  const directories: string[] = []
  const connections: OrchestrationDb[] = []
  afterEach(() => {
    for (const db of connections.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  function databasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'orca-migrate-v43-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }
  function open(path: string): OrchestrationDb {
    const db = new OrchestrationDb(path)
    connections.push(db)
    return db
  }
  function closeLast(): void {
    connections.pop()?.close()
  }
  function shapeOf(path: string): unknown {
    const raw = new Database(path)
    try {
      return schemaShape(raw)
    } finally {
      raw.close()
    }
  }

  /** Rewinds a database to the pre-v43 shape: no principal tables and no Run principal columns. */
  function rewindToV42(path: string): void {
    const raw = new Database(path)
    raw.exec(`
      DROP TABLE IF EXISTS coordinator_principal_rotations;
      DROP TABLE IF EXISTS coordinator_principals;
      ALTER TABLE runs DROP COLUMN coordinator_principal_id;
      ALTER TABLE runs DROP COLUMN intake_closed;
    `)
    raw.pragma('user_version = 42')
    raw.close()
  }

  it('gives fresh and migrated databases the same principal schema', () => {
    const freshPath = databasePath()
    open(freshPath)
    closeLast()
    const migratedPath = databasePath()
    open(migratedPath)
    closeLast()
    rewindToV42(migratedPath)
    const migrated = open(migratedPath)
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    closeLast()
    expect(SCHEMA_VERSION).toBe(43)
    expect(shapeOf(migratedPath)).toEqual(shapeOf(freshPath))
  })

  it('is idempotent across reopen and a v42 stamp whose columns already exist', () => {
    const path = databasePath()
    open(path)
    closeLast()
    const before = shapeOf(path)
    open(path)
    closeLast()
    const raw = new Database(path)
    raw.pragma('user_version = 42')
    raw.close()
    open(path)
    closeLast()
    expect(shapeOf(path)).toEqual(before)
  })

  it('leaves legacy and terminal Runs untouched and readable as open, unowned Runs', () => {
    const path = databasePath()
    const original = open(path)
    const run = original.createRun({
      objective: 'terminal run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PANE
    })
    const task = original.createTask({ spec: 'existing', runId: run.id })
    closeLast()
    const rewound = new Database(path)
    const before = rewound
      .prepare(
        `SELECT id, objective, coordinator_handle, coordinator_pane_key, consumer_generation, legacy
         FROM runs ORDER BY id`
      )
      .all()
    rewound.close()
    rewindToV42(path)
    const db = open(path)
    expect(
      db.db
        .prepare(
          `SELECT id, objective, coordinator_handle, coordinator_pane_key, consumer_generation, legacy
           FROM runs ORDER BY id`
        )
        .all()
    ).toEqual(before)
    expect(db.getRunRaw(run.id)).toMatchObject({ intake_closed: 0, coordinator_principal_id: null })
    expect(db.getTask(task.id)?.status).toBe(task.status)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM coordinator_principals').get()).toEqual({
      count: 0
    })
  })

  it('replays v43 when a newer stamp is missing the principal tables', () => {
    const path = databasePath()
    open(path)
    closeLast()
    const raw = new Database(path)
    raw.exec('DROP TABLE coordinator_principal_rotations; DROP TABLE coordinator_principals;')
    raw.close()
    const db = open(path)
    expect(db.hasColumn('coordinator_principals', 'retirement_requested_at')).toBe(true)
    expect(db.hasColumn('coordinator_principal_rotations', 'previous_capability_hash')).toBe(true)
  })
})
