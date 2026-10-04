import { z } from 'zod'
import type { CodexSession } from './codex-structured-session-state'

const ThreadSettings = z.object({
  threadId: z.string(),
  threadSettings: z.object({ model: z.string(), serviceTier: z.string().nullable() })
})

export function observeCodexFastMode(
  session: CodexSession,
  method: string,
  params: unknown
): boolean {
  if (method !== 'thread/settings/updated' || session.ended) {
    return false
  }
  const parsed = ThreadSettings.safeParse(params)
  if (!parsed.success || parsed.data.threadId !== session.threadId) {
    return false
  }
  const { model, serviceTier } = parsed.data.threadSettings
  session.reportedOptions.serviceTier = serviceTier
  session.reportedOptions.serviceTierKnown = true
  return (
    serviceTier !== null &&
    (serviceTier === 'fast' ||
      serviceTier === 'priority' ||
      serviceTier === session.fastModeTierByModel.get(model))
  )
}
