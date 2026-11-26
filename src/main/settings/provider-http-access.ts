import { randomUUID } from 'node:crypto'
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

// SDKs can replace error codes with generic HTTP categories. Correlate their returned request ID
// with the local bridge response before attributing a forbidden response to the allowlist.
const recentDenials = new Set<string>()
export function recordModelHttpDenial(): string {
  const requestId = randomUUID()
  recentDenials.add(requestId)
  if (recentDenials.size > 256) recentDenials.delete(recentDenials.values().next().value!)
  return requestId
}

export const isLocalModelHttpDenial = (requestId: unknown): requestId is string =>
  typeof requestId === 'string' && recentDenials.has(requestId)
