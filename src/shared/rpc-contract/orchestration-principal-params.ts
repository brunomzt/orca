import { z } from 'zod'

const Name = z.string().trim().min(1).max(4096)
const Generation = z.number().int().positive()
const Hash = z.string().regex(/^[0-9a-f]{64}$/)
export const PrincipalCreateParams = z.object({
  provider: z.enum(['claude', 'codex']),
  managerSessionId: Name,
  childId: Name,
  project: Name,
  rootPath: Name,
  generation: Generation.optional(),
  run: Name.optional(),
  objective: Name.optional(),
  speed: z.literal('standard'),
  capabilityHash: Hash
})
export const PrincipalTargetParams = z.object({ principal: Name, run: Name })
export const PrincipalWriteParams = PrincipalTargetParams.extend({ expectedGeneration: Generation })
export const PrincipalReconnectParams = PrincipalWriteParams.extend({
  provider: z.enum(['claude', 'codex']),
  managerSessionId: Name,
  childId: Name
})
export const PrincipalRecoveringParams = PrincipalWriteParams.extend({ reason: Name.optional() })
export const PrincipalReplaceParams = PrincipalWriteParams.extend({
  childId: Name,
  reason: z.literal('loss'),
  capabilityHash: Hash
})
export const PrincipalRetireParams = PrincipalWriteParams.extend({
  request: z.boolean().optional()
})
export const PrincipalIntakeParams = PrincipalWriteParams.extend({ closed: z.boolean() })
