export type CustomProviderBaseUrlError =
  | 'Base URL must be a valid HTTP or HTTPS URL.'
  | 'Remove credentials from the Base URL and use the API key field.'

const CREDENTIAL_QUERY_PARAMETERS = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'key',
  'passphrase',
  'passwd',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'securitytoken',
  'sessiontoken',
  'token',
  'username',
  'xapikey'
])

const normalizedParameterName = (name: string): string =>
  name.toLowerCase().replaceAll(/[^a-z0-9]/g, '')

export const getCustomProviderBaseUrlError = (
  value: string
): CustomProviderBaseUrlError | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Base URL must be a valid HTTP or HTTPS URL.'
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return 'Base URL must be a valid HTTP or HTTPS URL.'
  }
  if (
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((name) =>
      CREDENTIAL_QUERY_PARAMETERS.has(normalizedParameterName(name))
    )
  ) {
    return 'Remove credentials from the Base URL and use the API key field.'
  }

  return undefined
}
