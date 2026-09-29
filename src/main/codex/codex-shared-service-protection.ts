import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProcessTableRow } from '../pty-process-table-parser'
import { runProcess } from '../../shared/child-process/run-process'

type SharedService = { kind: 'daemon' | 'updater'; executable: string }

/** Only managed services are shared; an ordinary app-server belongs to its caller. */
export function sharedCodexService(row: ProcessTableRow): SharedService | null {
  const match = /^(codex|\/.*\/codex)\s+app-server\s+(.+)$/.exec(row.command ?? '')
  if (!match || (!match[1].startsWith('/') && match[1] !== 'codex')) {
    return null
  }
  const args = match[2].split(/\s+/)
  if (args[0] === 'daemon' && args[1] === 'pid-update-loop') {
    return { kind: 'updater', executable: match[1] }
  }
  if (
    args.includes('--managed-daemon') &&
    args.some(
      (arg, index) =>
        (args[index - 1] === '--listen' && arg.startsWith('unix://')) ||
        arg.startsWith('--listen=unix://')
    )
  ) {
    return { kind: 'daemon', executable: match[1] }
  }
  return null
}

type ExecutableReader = (pids: number[]) => Promise<string>

async function readExecutables(pids: number[]): Promise<string> {
  const result = await runProcess({
    program: 'ps',
    args: ['-ww', '-p', pids.join(','), '-o', 'pid=,lstart=,comm='],
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    timeoutMs: 500,
    maxOutputBytes: 128 * 1024
  })
  return result.code === 0 && !result.timedOut ? result.stdout : ''
}

/** A command mentioning Codex is insufficient when the executable is known to be a wrapper. */
export async function sharedCodexBranches(
  rows: ProcessTableRow[],
  read: ExecutableReader = readExecutables
): Promise<Set<number>> {
  const candidates = rows.filter((row) => sharedCodexService(row) !== null)
  if (candidates.length === 0) {
    return new Set()
  }
  const output = await read(candidates.map((row) => row.pid)).catch(() => '')
  const evidence = new Map<number, { startedAt: string; executable: string } | null>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+?)\s*$/.exec(line)
    if (match) {
      const pid = Number(match[1])
      evidence.set(pid, evidence.has(pid) ? null : { startedAt: match[2], executable: match[3] })
    }
  }
  return new Set(
    candidates
      .filter((row) => {
        const live = evidence.get(row.pid)
        if (!live || live.startedAt !== row.startedAt) {
          return true
        }
        const executable = sharedCodexService(row)?.executable
        return live.executable === executable || live.executable === 'codex'
      })
      .map((row) => row.pid)
  )
}

function recordHomes(service: SharedService): string[] {
  // Package paths identify custom/account homes even when the closing shell changed CODEX_HOME.
  const packageHome = /^(.*)\/packages\/app-server-daemon\//.exec(service.executable)?.[1]
  return [
    ...new Set(
      [
        packageHome,
        process.env.CODEX_HOME,
        process.env.ORCA_CODEX_HOME,
        join(homedir(), '.codex')
      ].filter((home): home is string => Boolean(home))
    )
  ]
}

export async function sharedCodexRecordMatches(
  row: ProcessTableRow,
  readRecord: (path: string) => Promise<string> = (path) => readFile(path, 'utf8')
): Promise<boolean> {
  const service = sharedCodexService(row)
  if (!service) {
    return false
  }
  const file = service.kind === 'daemon' ? 'daemon.pid' : 'daemon-updater.pid'
  const results = await Promise.all(
    recordHomes(service).map(async (home) => {
      try {
        const record: unknown = JSON.parse(await readRecord(join(home, 'app-server-daemon', file)))
        return (
          typeof record === 'object' &&
          record !== null &&
          'pid' in record &&
          record.pid === row.pid &&
          'processStartTime' in record &&
          record.processStartTime === row.startedAt
        )
      } catch {
        return false
      }
    })
  )
  return results.some(Boolean)
}

export function preserveSharedCodexBranch(row: ProcessTableRow, branches: Set<number>): boolean {
  if (!branches.has(row.pid)) {
    return false
  }
  reportProtectedCodexService(row)
  return true
}

/** Metadata corroborates the skip; missing/stale metadata must never turn it into a kill. */
export function reportProtectedCodexService(row: ProcessTableRow): void {
  let reported = false
  const report = (recordMatched: boolean): void => {
    if (reported) {
      return
    }
    reported = true
    console.info('[PTY cleanup] preserved shared Codex branch', {
      pid: row.pid,
      kind: sharedCodexService(row)?.kind,
      identity: recordMatched ? 'record-matched' : 'unverifiable'
    })
  }
  // Record I/O is diagnostic only and cannot hold a tab close open.
  const timer = setTimeout(() => report(false), 250)
  timer.unref?.()
  void sharedCodexRecordMatches(row).then(
    (matched) => {
      clearTimeout(timer)
      report(matched)
    },
    () => {
      clearTimeout(timer)
      report(false)
    }
  )
}
