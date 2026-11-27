import {
  ApplicationCommandError,
  MODEL_HTTP_DESTINATION_NOT_ALLOWED
} from '../../shared/application-command-contract'
import { providerNetworkDestination } from '../../shared/provider-network-authorization'

export const modelHttpDestinationDenied = (): ApplicationCommandError =>
  new ApplicationCommandError(
    MODEL_HTTP_DESTINATION_NOT_ALLOWED,
    'The model HTTP address is not on the allowlist.'
  )

export async function resolveProviderHttpAccess(
  target: {
    isInsecureHttpAllowed?: (url: string) => Promise<boolean>
    allowInsecureHttp?: boolean
  },
  url: string
): Promise<boolean | undefined> {
  if (!target.isInsecureHttpAllowed) return target.allowInsecureHttp
  const allowed = await target.isInsecureHttpAllowed(url)
  const endpoint = new URL(url)
  if (
    !allowed &&
    !endpoint.username &&
    !endpoint.password &&
    providerNetworkDestination(endpoint.origin)
  )
    throw modelHttpDestinationDenied()
  return allowed
}
