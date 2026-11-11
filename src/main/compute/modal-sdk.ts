import { join, isAbsolute } from 'node:path'
import { z } from 'zod'
import { computeAccounts } from './compute-account-service'
import {
  computePythonRuntime,
  computeHelperPath,
  runComputePython,
  type ComputePythonBinding
} from './compute-python-runtime'
import type { ModalMaterial } from './compute-account-adapter'

type App = { environmentName: string; appName: string }
type Binding = App & { appId: string; nonce: string; volumeName: string }
export type ModalOutputScope = Binding & { volumeId: string; runId: string }
type Sandbox = ModalOutputScope & { sandboxId: string }
type Input = { path: string; localPath: string; bytes: number; sha256: string }
type ArchiveFile = { path: string; localPath: string; bytes: number; sha256: string }

const observation = z.object({
  status: z.enum(['running', 'succeeded', 'failed', 'timeout', 'cancelled']),
  exitCode: z.number().int().nullable(),
  stdoutTail: z.string().max(32768).optional(),
  stderrTail: z.string().max(32768).optional()
})
export class ModalCreateRejectedError extends Error {}

export type ModalExecution = (
  action: string,
  request: object,
  signal?: AbortSignal
) => Promise<unknown>
export async function withModalExecution<T>(
  operation: (execute: ModalExecution) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  // Account identity must precede the environment lease (the account queue itself probes Python).
  const identity = await computeAccounts.modalIdentity(signal)
  const runtime = computePythonRuntime('modal')
  const binding = await runtime.binding(signal)
  return runtime.run(
    binding,
    () =>
      operation((action, request, signal) =>
        invokeBound(binding, identity, action, request, signal)
      ),
    signal
  )
}
async function invoke(action: string, request: object, signal?: AbortSignal): Promise<unknown> {
  return withModalExecution((execute) => execute(action, request, signal), signal)
}
async function invokeBound(
  binding: ComputePythonBinding,
  managedIdentity: ModalMaterial | undefined,
  action: string,
  request: object,
  signal?: AbortSignal
): Promise<unknown> {
  const data = JSON.stringify({ request, managedIdentity })
  if (Buffer.byteLength(data) > 2 * 1024 * 1024)
    throw new Error('Modal request exceeds its byte limit.')
  let stdout: string
  try {
    stdout = await runComputePython(
      binding.python,
      ['-I', '-B', computeHelperPath('compute-modal.py'), action],
      data,
      signal,
      ['stage', 'launch', 'download'].includes(action) ? 600000 : 45000,
      4 * 1024 * 1024
    )
  } catch {
    if (signal?.aborted) throw signal.reason
    throw new Error(
      'Modal SDK process unavailable or interrupted. Review the Python environment in Connect Modal.'
    )
  }
  const envelope = z.union([
    z.strictObject({ result: z.json() }),
    z.strictObject({ error: z.string() })
  ])
  let response: z.infer<typeof envelope>
  try {
    response = envelope.parse(JSON.parse(stdout))
  } catch {
    throw new Error('Invalid response from the Modal SDK process.')
  }
  if ('result' in response) return response.result
  if (
    (action === 'launch' && response.error === 'sandbox-not-started') ||
    (action === 'create-volume' &&
      ['InvalidError', 'InvalidUsageError', 'PermissionDeniedError', 'AuthError'].includes(
        response.error
      ))
  )
    throw new ModalCreateRejectedError('Modal rejected resource creation.')
  throw new Error(
    'Modal SDK operation failed. Review the Python environment, local identity, App and environment.'
  )
}

export async function resolveModalApp(
  target: App,
  signal?: AbortSignal
): Promise<{ appId: string }> {
  return z
    .object({ appId: z.string().min(1) })
    .parse(
      await invoke(
        'target',
        { environmentName: target.environmentName, appName: target.appName },
        signal
      )
    )
}
export { resolveModalApp as inspectModalTarget }
export async function createModalVolume(
  binding: Binding,
  signal?: AbortSignal,
  execute: ModalExecution = invoke
): Promise<{ volumeId: string }> {
  return z
    .object({ volumeId: z.string().regex(/^vo-[\w-]+$/) })
    .parse(await execute('create-volume', binding, signal))
}
const portable = (name: string): boolean =>
  name.length > 0 &&
  name !== '.' &&
  name !== '..' &&
  Buffer.byteLength(name) <= 255 &&
  !/[\\/:*?"<>|]/u.test(name) &&
  !Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
export async function stageModalInputs(
  request: ModalOutputScope & { files: Input[]; maxBytes: number },
  signal?: AbortSignal
): Promise<void> {
  const seen = new Set<string>()
  let remaining = request.maxBytes
  for (const file of request.files) {
    const key = file.path.normalize('NFC').toLowerCase()
    if (
      seen.has(key) ||
      !portable(file.path) ||
      !isAbsolute(file.localPath) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > remaining ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid frozen Modal input.')
    remaining -= file.bytes
    seen.add(key)
  }
  await invoke('stage', request, signal)
}
export async function createModalSandbox(
  request: ModalOutputScope & {
    image: string
    command: string
    cpus: number
    memoryMiB: number
    gpu?: string
    timeoutSeconds: number
  },
  signal?: AbortSignal,
  execute: ModalExecution = invoke
): Promise<{ sandboxId: string }> {
  return z
    .object({ sandboxId: z.string().regex(/^sb-[\w-]+$/) })
    .parse(await execute('launch', request, signal))
}
export async function inspectModalSandbox(
  request: Sandbox,
  signal?: AbortSignal
): Promise<z.infer<typeof observation>> {
  return observation.parse(await invoke('inspect', request, signal))
}
export async function terminateModalSandbox(request: Sandbox, signal?: AbortSignal): Promise<void> {
  await invoke('terminate', request, signal)
}
export async function cleanupModalVolume(
  request: ModalOutputScope,
  signal?: AbortSignal
): Promise<void> {
  await invoke('cleanup', request, signal)
}
const outputPath = z
  .string()
  .max(1024)
  .refine((path) => path.split('/').every(portable))
export async function listModalJobOutputs(
  scope: ModalOutputScope,
  signal?: AbortSignal
): Promise<Array<{ path: string; size_bytes: number }>> {
  return z
    .array(z.object({ path: outputPath, size_bytes: z.number().int().nonnegative() }))
    .max(10000)
    .parse(await invoke('list', scope, signal))
}
export async function stageModalJobOutputs(request: {
  scope: ModalOutputScope
  files: { path: string; bytes: number }[]
  stagingDirectory: string
  maxBytes: number
  signal?: AbortSignal
}): Promise<ArchiveFile[]> {
  const { scope, signal, ...archive } = request
  const result = z
    .array(
      z.object({
        path: outputPath,
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/)
      })
    )
    .parse(await invoke('download', { ...scope, ...archive }, signal))
  if (result.length !== request.files.length) throw new Error('Incomplete Modal archive.')
  return result.map((file, index) => {
    if (file.path !== request.files[index].path || file.bytes !== request.files[index].bytes)
      throw new Error('Modal archive receipt mismatch.')
    return { ...file, localPath: join(request.stagingDirectory, String(index)) }
  })
}
