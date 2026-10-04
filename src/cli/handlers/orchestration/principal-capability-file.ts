import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  linkSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  writeDurableSecureJsonFile,
  bestEffortFsyncDirectorySync
} from '../../../shared/secure-file'
import { restrictWindowsPathSync } from '../../../shared/secure-path-windows-acl'

const CapabilityFile = z
  .object({
    schema: z.literal('orca.coordinator-principal-capability.v1'),
    runtimeId: z.string().min(1),
    principalId: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    generation: z.number().int().positive().nullable(),
    capability: z.string().regex(/^ccap_[A-Za-z0-9_-]{43}$/),
    requestId: z.string().min(1),
    state: z.enum(['pending', 'committed'])
  })
  .strict()

export type PrincipalCapabilityFile = z.infer<typeof CapabilityFile>

export class PrincipalCapabilityFileError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function insecure(): never {
  throw new PrincipalCapabilityFileError('capability_file_insecure')
}

function requirePrivateParent(path: string): void {
  if (!isAbsolute(path)) {
    insecure()
  }
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    insecure()
  }
  if (process.platform === 'win32') {
    if (!restrictWindowsPathSync(dirname(path), true)) {
      insecure()
    }
  } else if ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    insecure()
  }
}

export function readPrincipalCapabilityFile(
  path: string,
  runtimeId: string
): PrincipalCapabilityFile {
  try {
    requirePrivateParent(path)
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      insecure()
    }
    if (process.platform === 'win32' && !restrictWindowsPathSync(path, false)) {
      insecure()
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const file = fstatSync(fd)
      if (!file.isFile() || file.nlink !== 1 || file.ino !== entry.ino || file.dev !== entry.dev) {
        insecure()
      }
      if (
        process.platform !== 'win32' &&
        ((file.mode & 0o077) !== 0 || file.uid !== process.getuid?.())
      ) {
        insecure()
      }
      if (file.size > 8192) {
        insecure()
      }
      const parsed = CapabilityFile.safeParse(JSON.parse(readFileSync(fd, 'utf8')))
      if (!parsed.success) {
        insecure()
      }
      const value = parsed.data
      if (value.runtimeId !== runtimeId) {
        throw new PrincipalCapabilityFileError('principal_runtime_mismatch')
      }
      if (
        value.state === 'committed' &&
        (value.principalId === null || value.runId === null || value.generation === null)
      ) {
        insecure()
      }
      return value
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (error instanceof PrincipalCapabilityFileError) {
      throw error
    }
    // Parser and filesystem errors must never echo file contents.
    throw new PrincipalCapabilityFileError('capability_file_insecure')
  }
}

export function principalCapabilityHash(value: PrincipalCapabilityFile): string {
  return createHash('sha256').update(value.capability).digest('hex')
}

export function newPendingPrincipalCapability(
  runtimeId: string,
  requestId: string
): PrincipalCapabilityFile {
  return {
    schema: 'orca.coordinator-principal-capability.v1',
    runtimeId,
    requestId,
    principalId: null,
    runId: null,
    generation: null,
    state: 'pending',
    capability: `ccap_${randomBytes(32).toString('base64url')}`
  }
}

export function writePrincipalCapabilityFile(path: string, value: PrincipalCapabilityFile): void {
  try {
    requirePrivateParent(path)
    if (!CapabilityFile.safeParse(value).success) {
      insecure()
    }
    if (!writeDurableSecureJsonFile(path, value)) {
      insecure()
    }
    readPrincipalCapabilityFile(path, value.runtimeId)
  } catch (error) {
    if (error instanceof PrincipalCapabilityFileError) {
      throw error
    }
    throw new PrincipalCapabilityFileError('capability_file_insecure')
  }
}

export function createPrincipalCapabilityFile(path: string, value: PrincipalCapabilityFile): void {
  const staged = `${path}.${randomBytes(16).toString('hex')}.pending`
  try {
    writePrincipalCapabilityFile(staged, value)
    // Linking publishes only when the destination does not already exist.
    linkSync(staged, path)
  } catch (error) {
    if (error instanceof PrincipalCapabilityFileError) {
      throw error
    }
    throw new PrincipalCapabilityFileError('capability_file_insecure')
  } finally {
    try {
      unlinkSync(staged)
    } catch {
      /* A failed staging write may leave no file. */
    }
  }
  bestEffortFsyncDirectorySync(dirname(path))
  readPrincipalCapabilityFile(path, value.runtimeId)
}

export function committedPrincipalCapability(
  pending: PrincipalCapabilityFile,
  principal: { id: string; runId: string; generation: number }
): PrincipalCapabilityFile {
  const parsed = CapabilityFile.safeParse({
    ...pending,
    state: 'committed',
    principalId: principal.id,
    runId: principal.runId,
    generation: principal.generation
  })
  if (!parsed.success) {
    insecure()
  }
  return parsed.data
}

export function assertDistinctRotationPath(oldPath: string, newPath: string): void {
  try {
    const normalize = (path: string) => {
      requirePrivateParent(path)
      const canonical = join(realpathSync(dirname(path)), basename(path))
      return process.platform === 'win32' || process.platform === 'darwin'
        ? canonical.toLowerCase()
        : canonical
    }
    if (normalize(oldPath) === normalize(newPath)) {
      insecure()
    }
  } catch {
    throw new PrincipalCapabilityFileError('capability_file_insecure')
  }
}
