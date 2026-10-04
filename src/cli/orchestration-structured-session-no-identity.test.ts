/**
 * A structured chat session with NO orchestration identity must refuse, not guess.
 *
 * Non-worker structured sessions get no `ORCA_TERMINAL_HANDLE`, so `orchestration check` fell
 * through to the active-terminal guess — and `check` is destructive by default, so it consumed
 * another pane's oldest unread batch and marked it read. The rightful worker never saw that mail.
 *
 * The case pinned here is ONE terminal pane in the worktree, because that is the case
 * `requireUnambiguous` misses: with a single candidate the guess still resolves, to a sibling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_STRUCTURED_SESSION_ENV } from '../shared/structured-session-marker'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const resolveCurrentWorktreeSelectorMock = vi.hoisted(() => vi.fn())

vi.mock('./format', () => ({ printResult: vi.fn() }))
vi.mock('./selectors', () => ({
  getTerminalHandle: getTerminalHandleMock,
  resolveCurrentWorktreeSelector: resolveCurrentWorktreeSelectorMock
}))

import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'

const originalMarker = process.env[ORCA_STRUCTURED_SESSION_ENV]
const originalHandle = process.env.ORCA_TERMINAL_HANDLE

function invoke(command: string, flags = new Map<string, string | boolean>()) {
  return ORCHESTRATION_HANDLERS[command]!({
    flags,
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: true
  } as never)
}

describe('a structured chat session with no orchestration identity', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    resolveCurrentWorktreeSelectorMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    process.env[ORCA_STRUCTURED_SESSION_ENV] = '1'
    // Exactly ONE terminal pane in the worktree: the single-candidate case, where
    // `requireUnambiguous` still resolves and would hand this session a sibling's handle.
    getTerminalHandleMock.mockResolvedValue('term_sibling')
    // Default: cwd resolves inside a managed worktree, so the worktree-scope guard passes through
    // to whichever behavior the test under it is actually pinning (guess, or structured refusal).
    resolveCurrentWorktreeSelectorMock.mockResolvedValue('id:worktree-1')
  })

  afterEach(() => {
    if (originalMarker === undefined) {
      delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    } else {
      process.env[ORCA_STRUCTURED_SESSION_ENV] = originalMarker
    }
    if (originalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalHandle
    }
  })

  it('refuses a bare check instead of consuming the mailbox of a sibling pane', async () => {
    await expect(invoke('orchestration check')).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('--terminal')
    })
    // Neither guessed nor sent: a destructive read must not reach the runtime at all.
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a bare send for the same reason, naming --from', async () => {
    await expect(
      invoke(
        'orchestration send',
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'hi'],
          ['body', 'hello']
        ])
      )
    ).rejects.toMatchObject({ message: expect.stringContaining('--from') })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('still accepts an explicit --terminal, which is the actionable escape', async () => {
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    await invoke('orchestration check', new Map([['terminal', 'structworker_self']]))
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ terminal: 'structworker_self' })
    )
  })

  it('refuses an ordinary shell even with one sibling in the same worktree', async () => {
    delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    await expect(invoke('orchestration check')).rejects.toMatchObject({
      code: 'no_active_sender_terminal'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(resolveCurrentWorktreeSelectorMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each(['orchestration run-create', 'orchestration run-use'])(
    'refuses %s before binding a sibling coordinator', async (command) => {
      delete process.env[ORCA_STRUCTURED_SESSION_ENV]
      await expect(invoke(command, new Map([['objective', 'test'], ['id', 'run_test']]))).rejects.toMatchObject({
        code: 'no_active_sender_terminal'
      })
      expect(getTerminalHandleMock).not.toHaveBeenCalled()
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('refuses remote UI focus as caller identity', async () => {
    delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    await expect(ORCHESTRATION_HANDLERS['orchestration check']!({
      flags: new Map(), client: { call: callMock, isRemote: true }, cwd: '/tmp/repo', json: true
    } as never)).rejects.toMatchObject({ code: 'no_active_sender_terminal' })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })
})

/**
 * Reproduces the 2026-10-04 incident baseline: a bare shell outside any Orca-managed worktree
 * (a plain checkout cwd, no `ORCA_STRUCTURED_SESSION`, no env handle) ran an orchestration command
 * with no `--from`/`--terminal`. The active-terminal guess has no scoping relationship to that cwd
 * — not "ambiguous", just plain wrong — and can name a sibling's handle (there, another project's
 * coordinator). `requireUnambiguous` does not catch this: there was exactly one active terminal.
 */
describe('an ordinary shell outside any Orca-managed worktree', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    resolveCurrentWorktreeSelectorMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    // cwd matches no registered worktree: the exact shape `resolveCurrentWorktreeSelector` throws.
    resolveCurrentWorktreeSelectorMock.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'selector_not_found' })
    )
    // A single unrelated terminal happens to be globally active — the baseline bug would still
    // hand this back as if it belonged to the caller.
    getTerminalHandleMock.mockResolvedValue('term_sibling')
  })

  afterEach(() => {
    if (originalMarker === undefined) {
      delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    } else {
      process.env[ORCA_STRUCTURED_SESSION_ENV] = originalMarker
    }
    if (originalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalHandle
    }
  })

  it('refuses a bare check instead of guessing a sibling pane from global UI focus', async () => {
    await expect(invoke('orchestration check')).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('--terminal')
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a bare send for the same reason, naming --from', async () => {
    await expect(
      invoke(
        'orchestration send',
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'hi'],
          ['body', 'hello']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('--from')
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('still accepts an explicit --terminal', async () => {
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    await invoke('orchestration check', new Map([['terminal', 'term_self']]))
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ terminal: 'term_self' })
    )
    expect(resolveCurrentWorktreeSelectorMock).not.toHaveBeenCalled()
  })

  it('still accepts an explicit --from', async () => {
    callMock.mockResolvedValue({ result: { message: { id: 'msg_1' } } })
    await invoke(
      'orchestration send',
      new Map<string, string | boolean>([
        ['from', 'term_self'],
        ['to', 'term_coord'],
        ['subject', 'hi'],
        ['body', 'hello']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.send', expect.objectContaining({ from: 'term_self' }))
    expect(resolveCurrentWorktreeSelectorMock).not.toHaveBeenCalled()
  })

  it('still trusts a live ORCA_TERMINAL_HANDLE', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_env_self'
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    await invoke('orchestration check')
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ terminal: 'term_env_self' })
    )
    expect(resolveCurrentWorktreeSelectorMock).not.toHaveBeenCalled()
  })
})
