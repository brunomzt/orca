import type { CodexAppServerConnection } from './codex-app-server-connection-types'

const HANDSHAKE_TIMEOUT_MS = 15_000

export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection
): Promise<string | undefined> {
  const result = await connection.request(
    'initialize',
    {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        extensions: {}
      }
    },
    { timeoutMs: HANDSHAKE_TIMEOUT_MS }
  )
  connection.notify('initialized')
  if (
    result &&
    typeof result === 'object' &&
    'userAgent' in result &&
    typeof result.userAgent === 'string'
  ) {
    return /^orca_desktop\/([^\s]+)/.exec(result.userAgent)?.[1]
  }
  return undefined
}
