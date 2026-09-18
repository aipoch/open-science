import type { CustomServerView } from '../../../../shared/settings'

export const requiresSignInBeforeEnable = (server: CustomServerView): boolean =>
  Boolean(
    server.oauth &&
    (!server.oauth.hasTokens || server.availability === 'unauthenticated') &&
    !server.enabled
  )

export const cannotEnableCustomServer = (server: CustomServerView): boolean =>
  requiresSignInBeforeEnable(server) ||
  (!server.enabled && server.availability === 'credential_unavailable')
