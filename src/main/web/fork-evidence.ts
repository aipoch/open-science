import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'

const canonicalWebTools = new Set([
  'mcp__open_science_web__web_fetch',
  'mcp__open-science-web__web_fetch',
  'mcp__open_science_web__web_search',
  'mcp__open-science-web__web_search'
])

/** A local presentation identity may change; host execution evidence and parameters may not. */
export const preserveLocalForkWebEvidence = (
  source: PersistedChatSession,
  child: PersistedChatSession,
  identities: Readonly<Record<string, string>>
): PersistedChatSession => {
  const originals = new Map<string, PersistedToolActivity>()
  for (const activity of [
    ...(source.activities ?? []),
    ...(source.conversationGraph?.activities ?? [])
  ]) {
    if (
      activity.appOwned === true &&
      activity.executionInvocationId &&
      canonicalWebTools.has(activity.providerToolName ?? '')
    ) {
      originals.set(identities[activity.id] ?? activity.id, activity)
    }
  }
  const preserve = <T extends PersistedToolActivity>(activity: T): T => {
    const original = originals.get(activity.id)
    if (!original) return activity
    const metadata = original.webInvocation
      ? { ...original.webInvocation, retryEligible: undefined }
      : undefined
    return {
      ...activity,
      executionInvocationId: original.executionInvocationId,
      rawInput: structuredClone(original.rawInput),
      rawOutput: structuredClone(original.rawOutput),
      toolContent: structuredClone(original.toolContent),
      webInvocation: metadata
    }
  }
  return {
    ...child,
    ...(child.activities ? { activities: child.activities.map(preserve) } : {}),
    ...(child.conversationGraph
      ? {
          conversationGraph: {
            ...child.conversationGraph,
            activities: child.conversationGraph.activities.map(preserve)
          }
        }
      : {})
  }
}
