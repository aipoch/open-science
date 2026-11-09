import { spawn } from 'node:child_process'
import { access, readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { runtimeMetadata } from '../runtime-metadata'
import {
  AccountAuthError,
  type AccountChallenge,
  type ComputeAccountAdapter,
  type HfMaterial
} from './compute-account-adapter'

const credential = z
  .string()
  .regex(/^[!-~]+$/)
  .max(32768)
export const hfMaterialSchema = z.strictObject({
  accessToken: credential,
  refreshToken: credential.optional(),
  expiresAt: z.number().int().positive().optional()
})

async function interpreter(): Promise<string> {
  const override = process.env.OPEN_SCIENCE_HF_PYTHON
  if (override) {
    if (!isAbsolute(override)) throw new AccountAuthError('dependency')
    return override
  }
  const win = process.platform === 'win32'
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const hf = join(dir, win ? 'hf.exe' : 'hf')
    try {
      await access(hf)
      const target = await readlink(hf).catch(() => hf)
      const python = join(dirname(resolve(dir, target)), win ? 'python.exe' : 'python')
      await access(python)
      return python
    } catch {
      /* Try the next installed CLI or the host interpreter. */
    }
  }
  return win ? 'python' : 'python3'
}

async function hfHelper(
  request: { action: 'authorize' | 'local' } | { action: 'refresh'; refreshToken: string },
  signal: AbortSignal,
  challenge?: AccountChallenge
): Promise<HfMaterial> {
  const python = await interpreter()
  signal.throwIfAborted()
  const root = runtimeMetadata().applicationPath
  const script = join(
    basename(root) === 'app.asar' ? root + '.unpacked' : root,
    'resources',
    'compute-hf-auth.py'
  )
  return new Promise((accept, reject) => {
    const child = spawn(python, ['-I', script], {
      signal,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
    let bytes = 0
    let buffer = ''
    let result: HfMaterial | undefined
    let opened: Promise<void> | undefined
    const fail = (error: unknown): void => {
      child.kill('SIGKILL')
      reject(error instanceof AccountAuthError ? error : new AccountAuthError('network'))
    }
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(
        new AccountAuthError(
          e.code === 'ENOENT' ? 'dependency' : signal.aborted ? 'cancelled' : 'network'
        )
      )
    )
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      try {
        bytes += Buffer.byteLength(chunk)
        buffer += chunk
        if (bytes > 128 * 1024) throw new AccountAuthError('authorization')
        let pos: number
        while ((pos = buffer.indexOf('\n')) !== -1) {
          const msg = JSON.parse(buffer.slice(0, pos))
          buffer = buffer.slice(pos + 1)
          if (['missing', 'dependency', 'authorization', 'network', 'timeout'].includes(msg.error))
            throw new AccountAuthError(msg.error)
          if (msg.url) {
            const url = new URL(msg.url)
            if (
              !challenge ||
              opened ||
              result ||
              !['https://hf.co', 'https://huggingface.co'].includes(url.origin) ||
              url.username ||
              url.password ||
              url.pathname !== '/oauth/device' ||
              typeof msg.userCode !== 'string' ||
              !Number.isSafeInteger(msg.expiresAt)
            )
              throw new AccountAuthError('authorization')
            opened = challenge(url.href, msg.userCode, msg.expiresAt)
            void opened.catch(fail)
          } else {
            if (result) throw new AccountAuthError('authorization')
            result = hfMaterialSchema.parse(msg.material)
          }
        }
      } catch (e) {
        fail(e)
      }
    })
    child.on('close', (code) => {
      if (code !== 0 || !result || buffer.trim() || (request.action === 'authorize' && !opened)) {
        reject(new AccountAuthError('network'))
        return
      }
      const value = result
      void Promise.resolve(opened).then(() => accept(value), fail)
    })
  })
}

export async function readLocalHfToken(signal: AbortSignal): Promise<string> {
  if (
    /^(1|on|yes|true)$/i.test(process.env.HUGGINGFACE_CO_STAGING ?? '') ||
    (process.env.HF_ENDPOINT &&
      process.env.HF_ENDPOINT.replace(/\/$/, '') !== 'https://huggingface.co')
  )
    throw new AccountAuthError('authorization')
  const fromEnv = process.env.HF_TOKEN?.trim()
  if (fromEnv) {
    if (!credential.safeParse(fromEnv).success) throw new AccountAuthError('authorization')
    return fromEnv
  }
  const cache =
    process.env.HF_HOME ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'huggingface')
  const file = (process.env.HF_TOKEN_PATH || join(cache, 'token')).replace(/^~(?=[/\\])/, homedir())
  let token: string
  try {
    token = (await readFile(file, { encoding: 'utf8', signal })).trim()
  } catch (e) {
    throw new AccountAuthError(
      (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'storage'
    )
  }
  if (!credential.safeParse(token).success) throw new AccountAuthError('authorization')
  // OAuth cache entries carry refresh metadata owned by the CLI. Let the SDK rotate them in place.
  if (
    await access(join(dirname(file), 'stored_tokens')).then(
      () => true,
      () => false
    )
  ) {
    signal.throwIfAborted()
    try {
      // The SDK may wait for its 30s file lock, rotate a token and replace the CLI cache.
      // Let it finish writing even when the job that requested the token stops.
      token = (await hfHelper({ action: 'local' }, AbortSignal.timeout(60_000))).accessToken
    } catch (e) {
      if (!(e instanceof AccountAuthError && e.reason === 'dependency')) throw e
    }
  }
  signal.throwIfAborted()
  return token
}
export async function refreshHf(material: HfMaterial, signal: AbortSignal): Promise<HfMaterial> {
  if (!material.refreshToken) throw new AccountAuthError('authorization')
  const next = await hfHelper({ action: 'refresh', refreshToken: material.refreshToken }, signal)
  return { ...next, refreshToken: next.refreshToken ?? material.refreshToken }
}
export const hfAccountAdapter: ComputeAccountAdapter = {
  authorize: (challenge, signal) => hfHelper({ action: 'authorize' }, signal, challenge),
  async probe(material, signal) {
    const token = material
      ? hfMaterialSchema.parse(material).accessToken
      : await readLocalHfToken(signal)
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new AccountAuthError([401, 403].includes(res.status) ? 'authorization' : 'network')
    }
    return z.object({ name: z.string().min(1).max(256) }).parse(await res.json()).name
  }
}
