import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { runtimeMetadata } from '../runtime-metadata'
import {
  AccountAuthError,
  type AccountChallenge,
  type ComputeAccountAdapter,
  type ModalMaterial
} from './compute-account-adapter'

export function modalPythonCommand(helper: 'compute-modal.py' | 'compute-modal-auth.py'): {
  python: string
  args: string[]
} {
  const python = process.env.OPEN_SCIENCE_MODAL_PYTHON
  if (python && !isAbsolute(python)) throw new AccountAuthError('dependency')
  const { applicationPath } = runtimeMetadata()
  const root =
    basename(applicationPath) === 'app.asar' ? applicationPath + '.unpacked' : applicationPath
  return {
    python: python || (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['-I', join(root, 'resources', helper)]
  }
}

const protocol = z.union([
  z.strictObject({ url: z.url(), userCode: z.string().max(64) }),
  z.strictObject({ workspace: z.string().min(1).max(256) }),
  z.strictObject({ tokenId: z.string().min(1).max(256), tokenSecret: z.string().min(1).max(4096) }),
  z.strictObject({ error: z.enum(['missing', 'authorization', 'network', 'dependency']) })
])

async function invoke(
  material: ModalMaterial | undefined,
  signal: AbortSignal,
  challenge?: AccountChallenge
): Promise<string | ModalMaterial> {
  if (signal.aborted) throw new AccountAuthError('cancelled')
  const { python, args } = modalPythonCommand('compute-modal-auth.py')
  const timeoutMs = challenge ? 300_000 : 25_000
  const expiresAt = Date.now() + timeoutMs
  const deadline = AbortSignal.timeout(timeoutMs)
  const child = spawn(python, args, {
    signal: AbortSignal.any([signal, deadline]),
    killSignal: 'SIGKILL',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  child.stdin.on('error', () => {})
  child.stdin.end(
    JSON.stringify(challenge ? { action: 'authorize' } : { action: 'probe', material })
  )
  async function read(): Promise<string | ModalMaterial> {
    let bytes = 0
    let pending = ''
    let prompted = false
    let result: string | ModalMaterial | undefined
    child.stdout.setEncoding('utf8')
    for await (const chunk of child.stdout) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 16384) throw new AccountAuthError('network')
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const record = protocol.parse(JSON.parse(pending.slice(0, newline)))
        pending = pending.slice(newline + 1)
        if ('error' in record) throw new AccountAuthError(record.error)
        if (result !== undefined) throw new AccountAuthError('network')
        if ('url' in record && challenge && !prompted) {
          const url = new URL(record.url)
          if (
            url.origin !== 'https://modal.com' ||
            !/^\/token-flow(?:\/|$)/.test(url.pathname) ||
            url.username ||
            url.password
          )
            throw new AccountAuthError('authorization')
          prompted = true
          await challenge(url.href, record.userCode || undefined, expiresAt)
        } else if ('tokenId' in record && prompted) result = record
        else if ('workspace' in record && !challenge) result = record.workspace
        else throw new AccountAuthError('network')
        newline = pending.indexOf('\n')
      }
    }
    if (pending || !result) throw new AccountAuthError('network')
    return result
  }
  try {
    const [exit, result] = await Promise.all([once(child, 'close'), read()])
    if (exit[0] !== 0) throw new AccountAuthError('network')
    return result
  } catch (error) {
    if (signal.aborted) throw new AccountAuthError('cancelled')
    if (deadline.aborted) throw new AccountAuthError('timeout')
    if (error instanceof AccountAuthError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AccountAuthError('dependency')
    throw new AccountAuthError('network')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

export const modalAccountAdapter: ComputeAccountAdapter = {
  async probe(material, signal) {
    if (material && !('tokenId' in material)) throw new AccountAuthError('authorization')
    const workspace = await invoke(material, signal)
    if (typeof workspace !== 'string') throw new AccountAuthError('network')
    return workspace
  },
  async authorize(challenge, signal) {
    const material = await invoke(undefined, signal, challenge)
    if (typeof material === 'string') throw new AccountAuthError('network')
    return material
  }
}
