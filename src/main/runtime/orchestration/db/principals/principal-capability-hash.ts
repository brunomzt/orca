import { createHash, timingSafeEqual } from 'node:crypto'
import { isCoordinatorPrincipalCapabilityHash } from '../../../../../shared/orchestration-principal-contract'

export function hashCoordinatorPrincipalCapability(capability: string): string {
  return createHash('sha256').update(capability).digest('hex')
}

/** Constant-time check of a presented secret against a stored hash; a missing hash never matches. */
export function capabilityMatchesHash(capability: string, hash: string | null): boolean {
  if (!hash || !isCoordinatorPrincipalCapabilityHash(hash)) {
    return false
  }
  const expected = Buffer.from(hash, 'hex')
  const observed = Buffer.from(hashCoordinatorPrincipalCapability(capability), 'hex')
  return expected.length === observed.length && timingSafeEqual(expected, observed)
}
