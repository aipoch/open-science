// Match ACP authentication failures, not arbitrary provider or assistant text.
export const isAgentAuthenticationRequired = (message: string | null | undefined): boolean =>
  /^(?:(?:ApplicationCommandError|RequestError|Error):\s*)*Authentication required(?:\.|$)/i.test(
    message?.trim() ?? ''
  )
