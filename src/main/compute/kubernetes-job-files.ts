import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import {
  assertSafeInputDestination,
  createKubernetesBackendAdapter,
  RetryableHarvestError,
  validateRelativeTransferPath,
  type ComputeConnectionLease,
  type KubernetesWorkspace
} from '@aipoch/compute/node'
import { resolveKubernetesJobTarget, type KubernetesJobTarget } from './kubernetes-kubeconfig'

type FrozenInput = Readonly<{
  frozenPath: string
  dstFilename: string
  checksum: string
  sizeBytes: number
}>

async function execArgs(
  target: KubernetesJobTarget,
  pod: string,
  signal?: AbortSignal
): Promise<string[]> {
  const current = await resolveKubernetesJobTarget(
    target.context,
    target.namespace,
    target.image,
    signal
  )
  if (current.endpoint !== target.endpoint)
    throw new Error('Kubernetes context endpoint changed after approval.')
  return [
    '--context=' + target.context,
    '--namespace=' + target.namespace,
    '--server=' + target.endpoint,
    'exec',
    '-c',
    'transfer',
    pod
  ]
}

function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([deadline, signal]) : deadline
}

async function streamFile(
  args: string[],
  mode: 'upload' | 'archive',
  localPath: string,
  limit: number,
  signal?: AbortSignal
): Promise<{ bytes: number; exceeded: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error('Invalid Kubernetes file size limit.')
  const abort = new AbortController()
  const signals = AbortSignal.any([withDeadline(signal, 600_000), abort.signal])
  signals.throwIfAborted()
  const destination = mode === 'archive' ? await open(localPath, 'wx', 0o600) : undefined
  let complete = false
  let bytes = 0
  let exceeded = false
  try {
    const child = spawn('kubectl', args, {
      windowsHide: true,
      signal: signals,
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('Kubernetes file transfer failed.'))
      )
    })
    async function* bounded(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        if (chunk.length > limit - bytes) {
          exceeded = true
          throw new Error('Kubernetes file exceeds its byte budget.')
        }
        bytes += chunk.length
        yield chunk
      }
    }
    if (destination) child.stdin.end()
    else child.stdout.resume()
    const copy = destination
      ? pipeline(child.stdout, bounded, destination.createWriteStream(), { signal: signals })
      : pipeline(createReadStream(localPath), bounded, child.stdin, { signal: signals })
    // Settle both streams before removing an incomplete local destination (including on Windows).
    try {
      await Promise.all([copy, exited])
    } finally {
      abort.abort()
      await Promise.allSettled([copy, exited])
    }
    complete = true
  } catch (error) {
    if (!exceeded || mode === 'upload') throw error
  } finally {
    if (destination) {
      await destination.close()
      if (!complete) await unlink(localPath)
    }
  }
  return { bytes, exceeded }
}

const uploadScript = [
  'set -eu',
  'cd /workspace',
  'partial=$(mktemp .upload.XXXXXXXX)',
  'trap \'rm -f -- "$partial"\' EXIT',
  'cat > "$partial"',
  'test "$(wc -c < "$partial")" -eq "$2"',
  'hash=$(sha256sum < "$partial")',
  'test "${hash%% *}" = "$3"',
  'mv -fT -- "$partial" "$1"'
].join('\n')

/** Publish frozen input generations before the workload mounts its private volume. */
export async function uploadKubernetesJobInputs(
  target: KubernetesJobTarget,
  workspace: KubernetesWorkspace,
  transferImage: string,
  inputs: readonly FrozenInput[],
  signal?: AbortSignal
): Promise<void> {
  const names = new Set<string>()
  for (const input of inputs) {
    const name = input.dstFilename
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      validateRelativeTransferPath(name) ||
      names.has(name) ||
      !/^[a-f0-9]{64}$/.test(input.checksum) ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0
    )
      throw new Error('Invalid frozen Kubernetes input.')
    assertSafeInputDestination(name)
    names.add(name)
  }
  if (!inputs.length) return
  await createKubernetesBackendAdapter(target).withWorkspaceFiles(
    workspace,
    'upload',
    transferImage,
    async (pod) => {
      for (const input of inputs) {
        const args = await execArgs(target, pod, signal)
        await streamFile(
          [
            ...args,
            '-i',
            '--',
            'sh',
            '-c',
            uploadScript,
            'upload',
            input.dstFilename,
            String(input.sizeBytes),
            input.checksum
          ],
          'upload',
          input.frozenPath,
          input.sizeBytes,
          signal
        )
      }
    },
    signal
  )
}

const readScript = 'set -eu; test "$(realpath -e -- "$1")" = "$1"; test -f "$1"; exec cat -- "$1"'

// A nonzero kubectl exec can mean a rejected file or a vanished transfer Pod. Only the
// latter needs a fresh lease. Check the Pod on failure without exposing kubectl stderr.
async function checkArchivePod(
  target: KubernetesJobTarget,
  workspace: KubernetesWorkspace,
  pod: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  try {
    const path =
      '/api/v1/namespaces/' +
      encodeURIComponent(target.namespace) +
      '/pods/' +
      encodeURIComponent(pod)
    const response = await target.fetch!(target.endpoint + path, {
      signal: withDeadline(signal, 10_000)
    })
    if (response.ok) {
      const current = await response.json()
      if (
        !current.metadata?.deletionTimestamp &&
        current.metadata?.ownerReferences?.some(
          (owner: { uid?: string }) => owner.uid === workspace.uid
        ) &&
        current.status?.conditions?.some(
          (condition: { type?: string; status?: string }) =>
            condition.type === 'Ready' && condition.status === 'True'
        )
      )
        return
    } else {
      await response.body?.cancel()
    }
  } catch {
    signal?.throwIfAborted()
  }
  throw new RetryableHarvestError('Kubernetes archive Pod is unavailable.')
}

/** The harvest engine enumerates and reads a terminal job through a read-only PVC mount. */
export async function withKubernetesArchiveConnection<T>(
  target: KubernetesJobTarget,
  workspace: KubernetesWorkspace,
  transferImage: string,
  archive: (lease: ComputeConnectionLease) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return createKubernetesBackendAdapter(target).withWorkspaceFiles(
    workspace,
    'archive',
    transferImage,
    async (pod) =>
      archive({
        async run(command, options) {
          const signals = [signal, options.signal].filter(
            (item): item is AbortSignal => item !== undefined
          )
          const deadline = withDeadline(AbortSignal.any(signals), options.timeoutMs)
          const args = await execArgs(target, pod, deadline)
          const result = await new Promise<Awaited<ReturnType<ComputeConnectionLease['run']>>>(
            (resolve, reject) =>
              execFile(
                'kubectl',
                [...args, '--', 'sh', '-c', command],
                {
                  windowsHide: true,
                  encoding: 'utf8',
                  signal: deadline,
                  killSignal: 'SIGKILL',
                  maxBuffer: options.maxOutputBytes ?? 65_536
                },
                (error, stdout) => {
                  if (deadline.aborted) return reject(deadline.reason)
                  if (error && typeof error.code !== 'number')
                    return reject(new Error('Kubernetes archive command failed.'))
                  resolve({
                    stdout,
                    stderr: '',
                    truncated: false,
                    timedOut: false,
                    exitCode: error ? Number(error.code) : 0
                  })
                }
              )
          )
          if (result.exitCode !== 0) await checkArchivePod(target, workspace, pod, signal)
          return result
        },
        async download(remotePath, localPath, maxBytes) {
          const path = remotePath.slice('/workspace/'.length)
          if (
            !remotePath.startsWith('/workspace/') ||
            validateRelativeTransferPath(path) ||
            path.split('/').some((part) => !part || part === '.')
          )
            throw new Error('Invalid Kubernetes output path.')
          const args = await execArgs(target, pod, signal)
          const { bytes, exceeded } = await streamFile(
            [...args, '--', 'sh', '-c', readScript, 'archive', remotePath],
            'archive',
            localPath,
            maxBytes,
            signal
          ).catch(async (error: unknown) => {
            await checkArchivePod(target, workspace, pod, signal)
            throw error
          })
          return {
            exitCode: exceeded ? 1 : 0,
            stderr: '',
            timedOut: false,
            bytesWritten: bytes,
            exceeded
          }
        },
        async upload() {
          throw new Error('Kubernetes archive mount is read-only.')
        }
      }),
    signal
  )
}
