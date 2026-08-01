const INTERNAL_AGENTS_ERROR_MESSAGE = 'Internal operation failed.'

// Marks messages that were constructed by the host.agents modules and are safe to return to the
// control-plane REPL. Unknown dependency errors are never trusted merely because they have a message.
export class AgentsSafeError extends Error {}

export const agentsPublicError = (message: string): AgentsSafeError => new AgentsSafeError(message)

export const sanitizeAgentsError = (cause: unknown): string =>
  cause instanceof AgentsSafeError ? cause.message : INTERNAL_AGENTS_ERROR_MESSAGE

export const formatAgentsError = (method: string, cause: unknown): string => {
  const message = sanitizeAgentsError(cause)
  return message.startsWith('host.agents.') ? message : `host.agents.${method}: ${message}`
}
