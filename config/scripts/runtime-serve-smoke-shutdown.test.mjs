import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { stopServer, SHUTDOWN_TIMEOUT_MS } from './runtime-serve-smoke-shutdown.mjs'

const probe = vi.fn()
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function launcher() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => true)
  child.stdout = { destroy: vi.fn() }
  child.stderr = { destroy: vi.fn() }
  return child
}

it('waits for the actual Windows server after launcher loss without requiring descendant pipe closure', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  probe.mockReturnValue('live')
  const child = launcher()
  let done = false
  const stopped = stopServer(child, undefined, true, 123, probe).then(() => {
    done = true
  })
  child.signalCode = 'SIGTERM'
  child.emit('close', null, 'SIGTERM')
  await vi.advanceTimersByTimeAsync(100)
  expect(done).toBe(false)
  probe.mockReturnValue('exited')
  await vi.advanceTimersByTimeAsync(50)
  await stopped
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  expect(vi.getTimerCount()).toBe(0)
})

it('does not accept unverifiable server liveness as successful shutdown', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  probe.mockReturnValue('unverifiable')
  const child = launcher()
  const stopped = expect(stopServer(child, undefined, true, 123, probe)).rejects.toThrow(
    'did not exit'
  )
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
  await stopped
  expect(vi.getTimerCount()).toBe(0)
})

it('retains normal nonzero-exit rejection without Windows owner loss', async () => {
  const child = launcher()
  const stopped = expect(stopServer(child)).rejects.toThrow('shutdown failed: 7')
  child.emit('close', 7, null)
  await stopped
})

it('accepts clean macOS exit only after the serving PID exits, despite open helper pipes', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  probe.mockReturnValue('live')
  const child = launcher()
  const stopped = stopServer(child, undefined, false, 123, probe)
  child.exitCode = 0
  child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(50)
  expect(child.stdout.destroy).not.toHaveBeenCalled()
  probe.mockReturnValue('exited')
  await vi.advanceTimersByTimeAsync(50)
  await stopped
  expect(child.stdout.destroy).toHaveBeenCalledOnce()
  expect(child.stderr.destroy).toHaveBeenCalledOnce()
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not accept a dead server while its launcher is still running', async () => {
  vi.useFakeTimers()
  probe.mockReturnValue('exited')
  const child = launcher()
  const stopped = expect(stopServer(child, undefined, false, 123, probe)).rejects.toThrow(
    'did not exit'
  )
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
  await stopped
  expect(child.stdout.destroy).not.toHaveBeenCalled()
})
