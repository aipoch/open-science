export const DEFAULT_LOOPBACK_OAUTH_REDIRECT_URI = 'http://127.0.0.1/oauth/callback'

export const normalizeLoopbackOAuthRedirectUri = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OAuth redirect URI must be a valid URL.')
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('OAuth redirect URI must be an http://127.0.0.1 loopback URL.')
  }
  return url.toString()
}
