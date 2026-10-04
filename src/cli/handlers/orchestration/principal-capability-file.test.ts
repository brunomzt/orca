import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertDistinctRotationPath,
  committedPrincipalCapability,
  createPrincipalCapabilityFile,
  newPendingPrincipalCapability,
  PrincipalCapabilityFileError,
  principalCapabilityHash,
  readPrincipalCapabilityFile,
  writePrincipalCapabilityFile
} from './principal-capability-file'

const posixIt = process.platform === 'win32' ? it.skip : it

describe('principal capability file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-principal-cap-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a freshly created pending capability', () => {
    const path = join(dir, 'cap.json')
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    createPrincipalCapabilityFile(path, pending)

    const read = readPrincipalCapabilityFile(path, 'runtime-1')
    expect(read).toEqual(pending)
  })

  it('never overwrites an already-published capability file (crash-recovery invariant)', () => {
    const path = join(dir, 'cap.json')
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    createPrincipalCapabilityFile(path, pending)
    const before = readFileSync(path, 'utf8')

    const other = newPendingPrincipalCapability('runtime-1', 'req-2')
    expect(() => createPrincipalCapabilityFile(path, other)).toThrow(PrincipalCapabilityFileError)

    // The original pending capability must survive untouched; a crash mid-rotation must never
    // destroy the only valid prior capability (CONTRACT correction 4).
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('commits a pending capability in place after a matching principal receipt', () => {
    const path = join(dir, 'cap.json')
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    createPrincipalCapabilityFile(path, pending)

    const committed = committedPrincipalCapability(pending, {
      id: 'principal-1',
      runId: 'run-1',
      generation: 1
    })
    writePrincipalCapabilityFile(path, committed)

    const read = readPrincipalCapabilityFile(path, 'runtime-1')
    expect(read).toEqual(committed)
    expect(read.state).toBe('committed')
  })

  it('rejects a capability file belonging to a different runtime', () => {
    const path = join(dir, 'cap.json')
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    createPrincipalCapabilityFile(path, pending)

    expect(() => readPrincipalCapabilityFile(path, 'runtime-2')).toThrow(
      expect.objectContaining({ code: 'principal_runtime_mismatch' })
    )
  })

  it('refuses a committed-state file with a null identity field', () => {
    const path = join(dir, 'cap.json')
    writeFileSync(
      path,
      JSON.stringify({
        schema: 'orca.coordinator-principal-capability.v1',
        runtimeId: 'runtime-1',
        requestId: 'req-1',
        principalId: null,
        runId: 'run-1',
        generation: 1,
        state: 'committed',
        capability: `ccap_${'a'.repeat(43)}`
      }),
      { mode: 0o600 }
    )
    expect(() => readPrincipalCapabilityFile(path, 'runtime-1')).toThrow(
      expect.objectContaining({ code: 'capability_file_insecure' })
    )
  })

  posixIt('refuses a file with group/world-readable permissions', () => {
    const path = join(dir, 'cap.json')
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    createPrincipalCapabilityFile(path, pending)
    chmodSync(path, 0o644)

    expect(() => readPrincipalCapabilityFile(path, 'runtime-1')).toThrow(
      expect.objectContaining({ code: 'capability_file_insecure' })
    )
  })

  posixIt('refuses a file whose parent directory is group/world-accessible', () => {
    chmodSync(dir, 0o755)
    const path = join(dir, 'cap.json')
    expect(() => readPrincipalCapabilityFile(path, 'runtime-1')).toThrow(
      expect.objectContaining({ code: 'capability_file_insecure' })
    )
  })

  it('never echoes file contents when the JSON is corrupt', () => {
    const path = join(dir, 'cap.json')
    writeFileSync(path, 'not json {{{ secret-looking-garbage', { mode: 0o600 })
    try {
      readPrincipalCapabilityFile(path, 'runtime-1')
      expect.fail('expected readPrincipalCapabilityFile to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PrincipalCapabilityFileError)
      if (!(error instanceof PrincipalCapabilityFileError)) {
        throw error
      }
      expect(error.message).not.toContain('secret-looking-garbage')
    }
  })

  it('computes a stable hash over only the capability secret', () => {
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    expect(principalCapabilityHash(pending)).toBe(principalCapabilityHash(pending))
    const other = newPendingPrincipalCapability('runtime-1', 'req-1')
    expect(principalCapabilityHash(other)).not.toBe(principalCapabilityHash(pending))
  })

  it('treats the rotation destination as distinct from the source path', () => {
    const path = join(dir, 'cap.json')
    const pending = newPendingPrincipalCapability('runtime-1', 'req-1')
    createPrincipalCapabilityFile(path, pending)

    expect(() => assertDistinctRotationPath(path, join(dir, 'new-cap.json'))).not.toThrow()
    expect(() => assertDistinctRotationPath(path, path)).toThrow(PrincipalCapabilityFileError)
  })
})
