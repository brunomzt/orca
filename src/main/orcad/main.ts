/** Public Node-compatible launcher; application imports belong behind Bun handoff. */
import { realpathSync } from 'node:fs'
import { handoffToBundledOrcad, OrcadBundledRuntimeError } from './orcad-bundled-runtime'

function failStartup(error: unknown): void {
  console.error('orcad: failed to start:', error)
  process.exit(error instanceof OrcadBundledRuntimeError ? 78 : 1)
}

try {
  if (!handoffToBundledOrcad()) {
    if (!process.versions.bun) {
      throw new OrcadBundledRuntimeError('orcad requires its bundled Bun runtime')
    }
    const entry = process.argv[1]
    if (!entry) {
      throw new OrcadBundledRuntimeError('The Orca launcher entry is missing')
    }
    process.argv[1] = realpathSync(entry)
    // External in the launcher build: Node must never parse the application bundle.
    void import('./orcad-app').catch((cause: unknown) => {
      failStartup(
        new OrcadBundledRuntimeError('The bundled Orca application could not load', { cause })
      )
    })
  }
} catch (error) {
  failStartup(error)
}
