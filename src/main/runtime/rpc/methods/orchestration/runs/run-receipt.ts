import type { RunRow } from '../../../../orchestration/types'

// Why: home_database and coordinator_pane_key are runtime routing state; no caller reads them.
// The coordinator's Orca session id stays off the wire until a reader needs it; publishing it is a wire change.
// Intake and principal ownership are published only by the principal verbs, behind their capability.
const INTERNAL_RUN_COLUMNS = [
  'home_database',
  'coordinator_pane_key',
  'coordinator_orca_session_id',
  'coordinator_orca_session_id_generation',
  'intake_closed',
  'coordinator_principal_id'
] as const

export type RunReceipt = Omit<RunRow, (typeof INTERNAL_RUN_COLUMNS)[number]>

export function exposeRun(run: RunRow): RunReceipt {
  const exposed: Partial<RunRow> = { ...run }
  for (const column of INTERNAL_RUN_COLUMNS) {
    delete exposed[column]
  }
  return exposed as RunReceipt
}
