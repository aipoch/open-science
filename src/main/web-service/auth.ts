import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TOKEN_FILE = 'web-token'
const COOKIE_NAME = 'open_science_web_token'

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const newWebToken = (): string => randomBytes(32).toString('base64url')

const loadOrCreateWebToken = async (configRoot: string): Promise<string> => {
  const tokenPath = join(configRoot, TOKEN_FILE)
  await mkdir(dirname(tokenPath), { recursive: true })

  for (;;) {
    let tokenFile: FileHandle
    try {
      tokenFile = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error

      const token = newWebToken()
      try {
        tokenFile = await open(
          tokenPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        )
      } catch (createError) {
        if (hasErrorCode(createError, 'EEXIST')) continue
        throw createError
      }
      try {
        await tokenFile.chmod(0o600)
        await tokenFile.write(`${token}\n`, 0, 'utf8')
        return token
      } finally {
        await tokenFile.close()
      }
    }

    try {
      await tokenFile.chmod(0o600)
      const identity = await tokenFile.stat()
      const existing = (await tokenFile.readFile('utf8')).trim()
      if (existing.length >= 32) return existing

      const writableTokenFile = await open(tokenPath, constants.O_WRONLY | constants.O_NOFOLLOW)
      try {
        const writableIdentity = await writableTokenFile.stat()
        if (writableIdentity.dev !== identity.dev || writableIdentity.ino !== identity.ino) {
          throw new Error('Web token file changed while it was being opened.')
        }
        const token = newWebToken()
        await writableTokenFile.chmod(0o600)
        await writableTokenFile.truncate(0)
        await writableTokenFile.write(`${token}\n`, 0, 'utf8')
        return token
      } finally {
        await writableTokenFile.close()
      }
    } finally {
      await tokenFile.close()
    }
  }
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
    if (name === COOKIE_NAME) {
      try {
        return decodeURIComponent(value.join('='))
      } catch {
        return undefined
      }
    }
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

export { authenticateRequest, loadOrCreateWebToken, persistAuthCookie, TOKEN_FILE }
