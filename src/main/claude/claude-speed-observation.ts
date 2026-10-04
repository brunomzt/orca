import { z } from 'zod'
import type { ClaudeSession } from './claude-structured-session-state'

const Usage = z.object({ speed: z.enum(['standard', 'fast']) })
const AppliedSpeed = z.union([
  z.object({ type: z.literal('assistant'), message: z.object({ usage: Usage }) }),
  z.object({ type: z.literal('result'), usage: Usage })
])

export function observeClaudeAppliedSpeed(session: ClaudeSession, message: unknown): void {
  if (session.observedAppliedSpeed === 'fast') {
    return
  }
  const parsed = AppliedSpeed.safeParse(message)
  if (!parsed.success) {
    return
  }
  session.observedAppliedSpeed =
    parsed.data.type === 'assistant' ? parsed.data.message.usage.speed : parsed.data.usage.speed
}
