import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  computePythonRuntime,
  computeHelperPath,
  type ComputePythonBinding
} from './compute-python-runtime'
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

type HfMaterialRequest =
  { action: 'authorize' | 'local' } | { action: 'refresh'; refreshToken: string }
type HfProbeRequest = { action: 'probe'; accessToken: string }
function hfHelper(
  request: HfMaterialRequest,
  signal: AbortSignal,
  challenge?: AccountChallenge,
  binding?: ComputePythonBinding
): Promise<HfMaterial>
function hfHelper(
  request: HfProbeRequest,
  signal: AbortSignal,
  challenge: undefined,
  binding?: ComputePythonBinding
): Promise<string>
async function hfHelper(
  request: HfMaterialRequest | HfProbeRequest,
  signal: AbortSignal,
  challenge?: AccountChallenge,
  binding?: ComputePythonBinding
): Promise<HfMaterial | string> {
  const runtime = computePythonRuntime('hugging-face')
  const target = binding ?? (await runtime.binding(signal))
  return runtime.run(
    target,
    async () => {
      signal.throwIfAborted()
      let closed!: Promise<void>
      let child: ReturnType<typeof spawn> | undefined
      const result = new Promise<HfMaterial | string>((accept, reject) => {
        const spawned = spawn(
          target.python,
          ['-I', '-B', computeHelperPath('compute-hf-auth.py')],
          {
            signal,
            killSignal: 'SIGKILL',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore']
          }
        )
        child = spawned
        closed = new Promise<void>((resolve) => spawned.once('close', () => resolve()))
        spawned.stdin.on('error', () => {})
        spawned.stdin.end(JSON.stringify(request))
        let bytes = 0
        let buffer = ''
        let result: HfMaterial | string | undefined
        let opened: Promise<void> | undefined
        const fail = (error: unknown): void => {
          spawned.kill('SIGKILL')
          reject(error instanceof AccountAuthError ? error : new AccountAuthError('network'))
        }
        spawned.on('error', (e: NodeJS.ErrnoException) =>
          fail(
            new AccountAuthError(
              e.code === 'ENOENT' ? 'dependency' : signal.aborted ? 'cancelled' : 'network'
            )
          )
        )
        spawned.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          try {
            bytes += Buffer.byteLength(chunk)
            buffer += chunk
            if (bytes > 128 * 1024) throw new AccountAuthError('authorization')
            let pos: number
            while ((pos = buffer.indexOf('\n')) !== -1) {
              const msg = JSON.parse(buffer.slice(0, pos))
              buffer = buffer.slice(pos + 1)
              if (
                ['missing', 'dependency', 'authorization', 'network', 'timeout'].includes(msg.error)
              )
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
                result =
                  request.action === 'probe'
                    ? z.string().min(1).max(256).parse(msg.identity)
                    : hfMaterialSchema.parse(msg.material)
              }
            }
          } catch (e) {
            fail(e)
          }
        })
        spawned.on('close', (code) => {
          if (
            code !== 0 ||
            !result ||
            buffer.trim() ||
            (request.action === 'authorize' && !opened)
          ) {
            reject(new AccountAuthError('network'))
            return
          }
          const value = result
          void Promise.resolve(opened).then(() => accept(value), fail)
        })
      })
      try {
        return await result
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed
      }
    },
    signal
  )
}

export async function readLocalHfToken(
  signal: AbortSignal,
  binding?: ComputePythonBinding
): Promise<string> {
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
      token = (await hfHelper({ action: 'local' }, AbortSignal.timeout(60_000), undefined, binding))
        .accessToken
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
export function boundHfAccountAdapter(binding?: ComputePythonBinding): ComputeAccountAdapter {
  return {
    authorize: (challenge, signal) => hfHelper({ action: 'authorize' }, signal, challenge, binding),
    async probe(material, signal) {
      const token = material
        ? hfMaterialSchema.parse(material).accessToken
        : await readLocalHfToken(signal, binding)
      // Verification must use the same proxy-aware SDK path as device authorization.
      // Its deadline is independent of the minutes allowed for the browser interaction.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      try {
        return await hfHelper({ action: 'probe', accessToken: token }, deadline, undefined, binding)
      } catch (error) {
        if (signal.aborted) throw new AccountAuthError('cancelled')
        if (deadline.aborted) throw new AccountAuthError('timeout')
        throw error
      }
    }
  }
}
export const hfAccountAdapter: ComputeAccountAdapter = boundHfAccountAdapter()
