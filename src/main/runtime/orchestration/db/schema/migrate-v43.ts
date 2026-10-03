import type { OrchestrationDb } from '../orchestration-db'

const RUN_PRINCIPAL_COLUMNS = [
  ['intake_closed', 'INTEGER NOT NULL DEFAULT 0'],
  ['coordinator_principal_id', 'TEXT']
] as const

// Why IF NOT EXISTS: a fresh database replays the whole chain after createTables, so every step reruns.
export const COORDINATOR_PRINCIPAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_principals (
  id                      TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL,
  project                 TEXT NOT NULL,
  provider                TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  manager_session_id      TEXT NOT NULL,
  child_id                TEXT NOT NULL,
  -- Canonical coordinator home path; not identity.
  root_path               TEXT NOT NULL,
  workspace_id            TEXT,
  generation              INTEGER NOT NULL CHECK(generation >= 1),
  -- sha256 of the capability secret; nulled at retirement. The secret is never stored.
  capability_hash         TEXT,
  lifecycle               TEXT NOT NULL DEFAULT 'active'
    CHECK(lifecycle IN ('active', 'recovering', 'retirement-requested', 'retired')),
  retirement_requested_at TEXT,
  recovering_reason       TEXT,
  requested_speed         TEXT NOT NULL DEFAULT 'standard' CHECK(requested_speed = 'standard'),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at              TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_principal_run
  ON coordinator_principals(run_id) WHERE lifecycle <> 'retired';
CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_principal_project
  ON coordinator_principals(project) WHERE lifecycle <> 'retired';

-- Committed loss replacements, so a replay after a lost response finds its receipt once the old
-- generation is fenced. Only reason 'loss' exists; a model update never replaces a healthy child.
CREATE TABLE IF NOT EXISTS coordinator_principal_rotations (
  principal_id             TEXT NOT NULL,
  request_id               TEXT NOT NULL,
  run_id                   TEXT NOT NULL,
  reason                   TEXT NOT NULL CHECK(reason IN ('loss')),
  from_generation          INTEGER NOT NULL,
  to_generation            INTEGER NOT NULL,
  previous_child_id        TEXT NOT NULL,
  child_id                 TEXT NOT NULL,
  previous_capability_hash TEXT NOT NULL,
  capability_hash          TEXT NOT NULL,
  receipt                  TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (principal_id, request_id),
  UNIQUE (principal_id, to_generation)
);
`

/**
 * Coordinator principals: a terminal-less coordinator owning one retained Run. Additive only;
 * existing Runs read intake_closed = 0 and no principal, so legacy and terminal Runs are unchanged.
 */
export function migrateV43(this: OrchestrationDb, current: number): void {
  if (current >= 43) {
    return
  }
  // Guarded because createTables runs first on every open and already gives a fresh database these.
  for (const [column, type] of RUN_PRINCIPAL_COLUMNS) {
    if (!this.hasColumn('runs', column)) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`)
    }
  }
  this.db.exec(COORDINATOR_PRINCIPAL_SCHEMA_SQL)
}
