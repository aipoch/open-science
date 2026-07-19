import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TOKEN_FILE = 'web-token'
const COOKIE_NAME = 'open_science_web_token'

const loadOrCreateWebToken = async (configRoot: string): Promise<string> => {
  const tokenPath = join(configRoot, TOKEN_FILE)
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim()
    if (existing.length >= 32) return existing
  } catch {
    // Create the token below.
  }

  const token = randomBytes(32).toString('base64url')
  await mkdir(dirname(tokenPath), { recursive: true })
  await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

const safeEqual = (left: string | undefined, right: string): boolean => {
  if (!left) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const cookieToken = (request: IncomingMessage): string | undefined => {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split('=')
    if (name === COOKIE_NAME) return decodeURIComponent(value.join('='))
  }
  return undefined
}

const requestToken = (request: IncomingMessage, url: URL): string | undefined => {
  const auth = request.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  return url.searchParams.get('token') ?? cookieToken(request)
}

const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

const isAllowedOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHost(parsed.host) &&
      parsed.host === request.headers.host
    )
  } catch {
    return false
  }
}

const authenticateRequest = (
  request: IncomingMessage,
  url: URL,
  token: string
): { ok: boolean; queryToken: boolean } => ({
  ok:
    isLoopbackHost(request.headers.host) &&
    isAllowedOrigin(request) &&
    safeEqual(requestToken(request, url), token),
  queryToken: safeEqual(url.searchParams.get('token') ?? undefined, token)
})

const persistAuthCookie = (response: ServerResponse, token: string): void => {
  response.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`
  )
}

export { authenticateRequest, loadOrCreateWebToken, persistAuthCookie }
