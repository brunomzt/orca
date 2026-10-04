import type {
  CoordinatorPrincipalLifecycle,
  CoordinatorPrincipalProvider,
  CoordinatorPrincipalSpeed
} from '../../../../../shared/orchestration-principal-contract'

/** Internal row; `capability_hash` never leaves the store. See orchestration-principal-contract. */
export type CoordinatorPrincipalRow = {
  id: string
  run_id: string
  project: string
  provider: CoordinatorPrincipalProvider
  manager_session_id: string
  child_id: string
  root_path: string
  workspace_id: string | null
  generation: number
  capability_hash: string | null
  lifecycle: CoordinatorPrincipalLifecycle
  /** Retirement intent, separate from lifecycle so recovery never drops it. */
  retirement_requested_at: string | null
  recovering_reason: string | null
  requested_speed: CoordinatorPrincipalSpeed
  created_at: string
  updated_at: string
  retired_at: string | null
}
