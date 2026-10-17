// Match ACP authentication failures, including the application's session-resume wrapper.
export const isAgentAuthenticationRequired = (message: string | null | undefined): boolean =>
  /^(?:(?:ApplicationCommandError|RequestError|Error|Agent session resume failed):\s*)*Authentication required\.?$/i.test(
    message?.trim() ?? ''
  )
