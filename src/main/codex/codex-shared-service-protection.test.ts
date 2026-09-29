import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  sharedCodexRecordMatches,
  sharedCodexService,
  sharedCodexBranches
} from './codex-shared-service-protection'
import {
  collectDescendantRows,
  killWithDescendantSweep,
  parseProcessTable,
  type ProcessTableRow
} from '../pty-descendant-termination'

const startedAt = 'Mon Jul 13 12:54:47 2026'
const capturedAtMs = Date.parse('Tue Jul 14 12:00:00 2026')
const executable = '/tmp/custom account/packages/app-server-daemon/releases/0.158.0/bin/codex'
const daemonCommand = `${executable} app-server --listen unix:// --managed-daemon`
const updaterCommand = `${executable} app-server daemon pid-update-loop`
const row = (pid: number, ppid: number, command?: string): ProcessTableRow => ({
  pid,
  ppid,
  pgid: pid,
  startedAt,
  command
})
const tree = () => [
  row(10, 1),
  row(20, 10),
  row(30, 20, daemonCommand),
  row(31, 30),
  row(32, 31),
  row(40, 20, updaterCommand),
  row(41, 40),
  row(50, 20, '/bin/sleep 100')
]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('shared Codex service classification', () => {
  it('recognizes daemon and updater in custom homes with spaces', () => {
    expect(sharedCodexService(row(30, 20, daemonCommand))?.kind).toBe('daemon')
    expect(sharedCodexService(row(40, 20, updaterCommand))?.kind).toBe('updater')
  })
  it.each([
    'codex',
    'codex resume session-id',
    'codex exec task',
    'codex app-server',
    'node codex app-server --listen unix:// --managed-daemon',
    'codex app-server --listen unix://',
    'codex app-server daemon start'
  ])('does not protect ordinary command %s', (command) => {
    expect(sharedCodexService(row(30, 20, command))).toBeNull()
  })
  it('rejects shell wrappers and unrelated executable suffixes', async () => {
    const rows = [
      row(30, 20, '/bin/sh -c /usr/bin/codex app-server --listen unix:// --managed-daemon'),
      row(40, 20, '/usr/bin/not-codex app-server --listen unix:// --managed-daemon'),
      row(50, 20, daemonCommand)
    ]
    expect(
      await sharedCodexBranches(
        rows,
        async () =>
          `30 ${startedAt} /bin/sh\n40 ${startedAt} /usr/bin/not-codex\n50 ${startedAt} ${executable}`
      )
    ).toEqual(new Set([50]))
  })
  it('preserves plausible branches when executable evidence is unavailable or stale', async () => {
    expect(
      await sharedCodexBranches([row(30, 20, daemonCommand)], async () => {
        throw new Error('unavailable')
      })
    ).toEqual(new Set([30]))
    expect(
      await sharedCodexBranches(
        [row(30, 20, daemonCommand)],
        async () => '30 Tue Jul 14 12:00:00 2026 /bin/sh'
      )
    ).toEqual(new Set([30]))
  })
  it('parses command separately from the process start time', () => {
    expect(parseProcessTable(` 30 20 30 ${startedAt} ${daemonCommand}`)).toEqual([
      row(30, 20, daemonCommand)
    ])
  })
  it('corroborates a custom home record without treating a PID alone as identity', async () => {
    const read = vi.fn(async (path: string) => {
      if (!path.startsWith('/tmp/custom account/')) {
        throw new Error('absent')
      }
      return JSON.stringify({ pid: 30, processStartTime: startedAt })
    })
    expect(await sharedCodexRecordMatches(row(30, 20, daemonCommand), read)).toBe(true)
    expect(read).toHaveBeenCalledWith('/tmp/custom account/app-server-daemon/daemon.pid')
    expect(await sharedCodexRecordMatches(row(99, 20, daemonCommand), read)).toBe(false)
    expect(
      await sharedCodexRecordMatches(
        { ...row(30, 20, daemonCommand), startedAt: 'different' },
        read
      )
    ).toBe(false)
  })
  it('tolerates corrupt and unreadable records', async () => {
    expect(await sharedCodexRecordMatches(row(30, 20, daemonCommand), async () => '{')).toBe(false)
    expect(
      await sharedCodexRecordMatches(row(30, 20, daemonCommand), async () => {
        throw new Error('EACCES')
      })
    ).toBe(false)
  })
})

describe('shared service branch pruning', () => {
  it('reproduces the old ownership error and prunes before visiting children', () => {
    expect(collectDescendantRows(10, tree(), capturedAtMs).descendants.map((r) => r.pid)).toContain(
      32
    )
    const visited: number[] = []
    const safe = collectDescendantRows(10, tree(), capturedAtMs, (r) => {
      visited.push(r.pid)
      return sharedCodexService(r) !== null
    })
    expect(safe.descendants.map((r) => r.pid)).toEqual([20, 50])
    expect(visited).toEqual([20, 30, 40, 50])
    expect(safe.reDerivedPids).toEqual(new Set([20, 50]))
  })
  it('closes the root and only escalates ordinary children despite missing metadata', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const signal = vi.fn()
    const close = vi.fn()
    await killWithDescendantSweep(10, close, {
      platform: 'darwin',
      preserveSharedCodexServices: true,
      readSharedCodexExecutables: async () => '',
      readTable: async () => ({ rows: tree(), capturedAtMs }),
      sendSignal: signal,
      graceMs: 10
    })
    expect(close).toHaveBeenCalledOnce()
    expect(signal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [50, 'SIGTERM']
    ])
    await vi.advanceTimersByTimeAsync(15)
    expect(signal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [50, 'SIGTERM'],
      [20, 'SIGKILL'],
      [50, 'SIGKILL']
    ])
  })
  it('passes a pruned snapshot to the synchronous shutdown verifier', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const terminate = vi.fn(async (_snapshot: unknown) => {})
    const close = vi.fn()
    await killWithDescendantSweep(10, close, {
      platform: 'linux',
      preserveSharedCodexServices: true,
      readSharedCodexExecutables: async () => '',
      awaitEscalation: true,
      readTable: async () => ({ rows: tree(), capturedAtMs }),
      terminateDescendants: terminate
    })
    expect(terminate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ descendants: [tree()[1], tree()[7]] })
    )
    expect(close).toHaveBeenCalledOnce()
  })
})
