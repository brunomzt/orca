/**
 * Coordinator principal: a terminal-less native coordinator bound to one retained project Run.
 * Distinct from the legacy compatibility principals (`legacy_compatibility_principals`).
 * The capability secret (`ccap_…`) never crosses the wire as a param; only its sha256 hash does.
 */

export const COORDINATOR_PRINCIPAL_ID_PREFIX = 'cpr'
export const COORDINATOR_PRINCIPAL_CAPABILITY_PREFIX = 'ccap_'
export const COORDINATOR_PRINCIPAL_CAPABILITY_FILE_SCHEMA =
  'orca.coordinator-principal-capability.v1'
/** Set by the brain adapter so a principal call with missing routing flags never falls back to a terminal guess. */
export const ORCA_COORDINATOR_ROUTING_ENV = 'ORCA_COORDINATOR_ROUTING'
export const ORCA_COORDINATOR_ROUTING_PRINCIPAL = 'principal'

export const COORDINATOR_PRINCIPAL_PROVIDERS = ['claude', 'codex'] as const
export type CoordinatorPrincipalProvider = (typeof COORDINATOR_PRINCIPAL_PROVIDERS)[number]

/** Stored lifecycle; `retirement-requested` is also kept as separate intent so recovery never drops it. */
export const COORDINATOR_PRINCIPAL_LIFECYCLES = [
  'active',
  'recovering',
  'retirement-requested',
  'retired'
] as const
export type CoordinatorPrincipalLifecycle = (typeof COORDINATOR_PRINCIPAL_LIFECYCLES)[number]

/** Reported state; `waiting` and `idle-retained` are presentations of an `active` lifecycle. */
export type CoordinatorPrincipalState =
  | 'active'
  | 'waiting'
  | 'idle-retained'
  | 'recovering'
  | 'retirement-requested'
  | 'retired'

/** Replacement exists only for proven unrecoverable loss; a model update keeps the same child. */
export const COORDINATOR_PRINCIPAL_REPLACE_REASONS = ['loss'] as const
export type CoordinatorPrincipalReplaceReason =
  (typeof COORDINATOR_PRINCIPAL_REPLACE_REASONS)[number]

export const COORDINATOR_PRINCIPAL_SPEEDS = ['standard'] as const
export type CoordinatorPrincipalSpeed = (typeof COORDINATOR_PRINCIPAL_SPEEDS)[number]

export const COORDINATOR_PRINCIPAL_RETIREMENT_BLOCKER_KINDS = [
  'unfinished_task',
  'pending_dispatch',
  'unknown_dispatch',
  'unacked_mail',
  'pending_question',
  'pending_gate',
  'reclaimable_resource'
] as const
export type CoordinatorPrincipalRetirementBlockerKind =
  (typeof COORDINATOR_PRINCIPAL_RETIREMENT_BLOCKER_KINDS)[number]

export type CoordinatorPrincipalRetirementBlocker = Readonly<{
  kind: CoordinatorPrincipalRetirementBlockerKind
  id: string
  status: string
}>

/** Envelope field; the secret rides here, never in params, argv or results. */
export type OrchestrationPrincipalEnvelope = Readonly<{
  principalId: string
  runId: string
  generation: number
  capability: string
}>

/** What the server resolved from a verified envelope; never carries the secret. */
export type OrchestrationPrincipalAuthority = Readonly<{
  principalId: string
  runId: string
  generation: number
}>

export type CoordinatorPrincipalView = {
  id: string
  provider: CoordinatorPrincipalProvider
  managerSessionId: string
  childId: string
  project: string
  rootPath: string
  workspaceId: string | null
  runId: string
  generation: number
  state: CoordinatorPrincipalState
  lifecycle: CoordinatorPrincipalLifecycle
  retirementRequested: boolean
  intakeClosed: boolean
  coordinatorHandle: null
  launch: { requested: { speed: CoordinatorPrincipalSpeed } }
  createdAt: string
  updatedAt: string
  retiredAt: string | null
}

export const ORCHESTRATION_PRINCIPAL_ERROR_CODES = {
  ambiguousRouting: 'ambiguous_coordinator_routing',
  hostBoundary: 'principal_host_boundary',
  methodUnsupported: 'principal_method_unsupported',
  notFound: 'principal_not_found',
  exists: 'principal_exists',
  retired: 'principal_retired',
  recovering: 'principal_recovering',
  notRecovering: 'principal_not_recovering',
  identityMismatch: 'principal_identity_mismatch',
  resourceMismatch: 'principal_resource_mismatch',
  placementRequired: 'principal_placement_required',
  generationUnknown: 'principal_generation_unknown',
  capabilityInvalid: 'principal_capability_invalid',
  runtimeMismatch: 'principal_runtime_mismatch',
  rootUnregistered: 'principal_root_unregistered',
  capabilityFileInsecure: 'capability_file_insecure',
  staleGeneration: 'stale_generation',
  runBoundToCoordinator: 'run_bound_to_coordinator',
  runOwnedByPrincipal: 'run_owned_by_principal',
  intakeClosed: 'intake_closed',
  retirementBlocked: 'retirement_blocked',
  retirementRequested: 'retirement_requested',
  recipientRunMismatch: 'recipient_run_mismatch',
  launchSpeedUnsupported: 'launch_speed_unsupported',
  launchSpeedUnenforceable: 'launch_speed_unenforceable',
  incompatibleRuntime: 'incompatible_runtime'
} as const

/** New principal verbs; all but `principalShow` are durable mutations. */
export const ORCHESTRATION_PRINCIPAL_VERB_METHODS = [
  'orchestration.principalCreate',
  'orchestration.principalShow',
  'orchestration.principalReconnect',
  'orchestration.principalMarkRecovering',
  'orchestration.principalReplace',
  'orchestration.principalRetire',
  'orchestration.runIntakeSet'
] as const

export const ORCHESTRATION_PRINCIPAL_MUTATION_METHODS = ORCHESTRATION_PRINCIPAL_VERB_METHODS.filter(
  (method) => method !== 'orchestration.principalShow'
)

/** Every method a principal envelope may call; anything else is `principal_method_unsupported`. */
export const ORCHESTRATION_PRINCIPAL_METHODS: ReadonlySet<string> = new Set<string>([
  ...ORCHESTRATION_PRINCIPAL_VERB_METHODS,
  'orchestration.runShow',
  'orchestration.runCurrent',
  'orchestration.check',
  'orchestration.send',
  'orchestration.reply',
  'orchestration.ask',
  'orchestration.taskCreate',
  'orchestration.taskList',
  'orchestration.taskUpdate',
  'orchestration.workerStart',
  'orchestration.workerShow',
  'orchestration.workerRead',
  'orchestration.workerList',
  'orchestration.workerStop',
  'orchestration.workerRelease',
  'orchestration.workerRetain',
  'orchestration.workerAbandon',
  'orchestration.gateCreate',
  'orchestration.gateResolve',
  'orchestration.gateList',
  'orchestration.requestShow'
])

const CAPABILITY_HASH_RE = /^[0-9a-f]{64}$/

/** A lowercase hex sha256 digest, the only form of the capability the server ever accepts. */
export function isCoordinatorPrincipalCapabilityHash(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_HASH_RE.test(value)
}
