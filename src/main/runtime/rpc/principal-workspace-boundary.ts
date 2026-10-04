import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'

export function assertPrincipalLocalWorkspace(
  scope: Pick<TerminalWorkspaceLaunchScope, 'path' | 'connectionId' | 'repo'> &
    Partial<Pick<TerminalWorkspaceLaunchScope, 'folderWorkspace'>>
): void {
  if (
    scope.connectionId ||
    isWslUncPath(scope.path) ||
    (scope.repo && getRepoExecutionHostId(scope.repo) !== LOCAL_EXECUTION_HOST_ID) ||
    (scope.folderWorkspace &&
      getRepoExecutionHostId(scope.folderWorkspace) !== LOCAL_EXECUTION_HOST_ID)
  ) {
    throw new OrchestrationError(
      'principal_host_boundary',
      'Principal workspaces require the owning local host.',
      { effectsApplied: false }
    )
  }
}

export function assertPrincipalWorkerPlacement(params: { worktree?: string; repo?: string }): void {
  const exactId = (selector: string | undefined): boolean =>
    selector?.startsWith('id:') === true && selector.length > 3
  if (params.worktree === 'new-top-level' ? !exactId(params.repo) : !exactId(params.worktree)) {
    throw new OrchestrationError(
      'principal_placement_required',
      'Use an exact id: task workspace, or new-top-level with an exact id: repository.',
      { effectsApplied: false }
    )
  }
}
