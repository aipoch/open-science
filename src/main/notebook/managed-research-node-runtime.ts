import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { ManagedRuntimeDiagnosticCode } from '../../shared/managed-execution'
import type { ManagedResearchRuntime } from './managed-research-environment'

export type ManagedResearchNodeRuntimeOptions = {
  /** Main-owned overrides for tests or managed host installations, never package/API input. */
  trustedCandidates?: readonly string[]
  /** Snapshot of Main's launch PATH, optionally augmented by its existing host discovery. */
  path?: string
  probeTimeoutMs?: number
  maxExecutableBytes?: number
}
export type ManagedResearchNodeRuntimeDiscovery = {
  runtimes: Array<{ runtimeId: string; runtime: ManagedResearchRuntime }>
  unavailable: Array<{ candidate: string; reason: string; code: NodeRuntimeDiagnosticCode }>
}
type NodeRuntimeDiagnosticCode = Exclude<ManagedRuntimeDiagnosticCode, 'native_service_unsupported'>
export type ManagedResearchNodeRuntimeRegistry = {
  discover(): Promise<ManagedResearchNodeRuntimeDiscovery>
  resolve(runtimeId: string): Promise<ManagedResearchRuntime>
  verify(runtime: ManagedResearchRuntime): Promise<void>
}

const PROBE = `process.stdout.write(JSON.stringify({
  protocol: 'open-science-node-runtime-v1',
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  executable: process.execPath,
  platform: process.platform,
  arch: process.arch,
  sharedObjects: process.report.getReport().sharedObjects
}))`
const probeResult = z
  .object({
    protocol: z.literal('open-science-node-runtime-v1'),
    node: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    electron: z.null(),
    executable: z.string().min(1).max(4096),
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.string().min(1).max(64),
    sharedObjects: z.array(z.string().min(1).max(4096)).max(1024)
  })
  .strict()
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const runtimeId = (runtime: ManagedResearchRuntime): string =>
  sha(JSON.stringify([runtime.executable, runtime.sha256]))
class NodeRuntimeUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: NodeRuntimeDiagnosticCode
  ) {
    super(`Managed research Node runtime: ${message}`)
  }
}
const unavailable = (message: string, code: NodeRuntimeDiagnosticCode = 'node_unusable'): never => {
  throw new NodeRuntimeUnavailableError(message, code)
}
const fingerprint = (file: BigIntStats): string =>
  [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':')
const nativeBinary = (magic: Buffer): boolean =>
  magic.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
  [
    'feedface',
    'feedfacf',
    'cefaedfe',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca'
  ].includes(magic.subarray(0, 4).toString('hex')) ||
  magic.subarray(0, 2).equals(Buffer.from('MZ'))

const inspectBinary = async (
  executable: string,
  maxBytes: number
): Promise<{
  checksum: string
  fingerprint: string
}> => {
  const handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 4 || before.size > maxBytes)
      return unavailable('executable is not a bounded native binary.')
    await access(executable, constants.X_OK)
    const hash = createHash('sha256')
    let offset = 0
    const buffer = Buffer.alloc(64 * 1024)
    while (offset < Number(before.size)) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset
      )
      if (bytesRead === 0) return unavailable('executable ended early.')
      if (offset === 0 && !nativeBinary(buffer.subarray(0, bytesRead)))
        return unavailable('executable must be a native Node binary, not a wrapper script.')
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const extra = await handle.read(buffer, 0, 1, offset)
    if (
      extra.bytesRead ||
      fingerprint(before) !== fingerprint(await handle.stat({ bigint: true })) ||
      fingerprint(before) !== fingerprint(await lstat(executable, { bigint: true }))
    )
      return unavailable('executable changed during verification.')
    return { checksum: hash.digest('hex'), fingerprint: fingerprint(before) }
  } finally {
    await handle.close()
  }
}

const systemCandidates = (): string[] =>
  process.platform === 'win32'
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')]
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']

/** Main-owned registry. Public callers select opaque runtime IDs, never executable paths. */
export const createManagedResearchNodeRuntimeRegistry = (
  options: ManagedResearchNodeRuntimeOptions = {}
): ManagedResearchNodeRuntimeRegistry => {
  const timeout = options.probeTimeoutMs ?? 3000
  const maxBytes = options.maxExecutableBytes ?? 256 * 1024 ** 2
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 10_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 4 ||
    maxBytes > 1024 ** 3
  )
    return unavailable('invalid trusted probe limits.')
  const launchPath = options.path ?? process.env.PATH ?? ''
  if (launchPath.length > 65_536) return unavailable('host PATH exceeds the discovery limit.')
  const candidates = [
    ...new Set(
      options.trustedCandidates ?? [
        ...launchPath
          .split(delimiter)
          .filter((entry) => isAbsolute(entry))
          .map((entry) => join(entry, process.platform === 'win32' ? 'node.exe' : 'node')),
        ...systemCandidates()
      ]
    )
  ]
  if (
    candidates.length > 64 ||
    candidates.some(
      (candidate) => !isAbsolute(candidate) || candidate.length > 4096 || candidate.includes('\0')
    )
  )
    return unavailable('invalid or excessive trusted candidates.')
  const records = new Map<string, ManagedResearchRuntime>()

  const probe = async (
    executable: string,
    expectedChecksum?: string
  ): Promise<ManagedResearchRuntime> => {
    if (/electron(?:\.exe)?$/i.test(basename(executable)))
      return unavailable('Electron is not an independent Node runtime.', 'node_not_independent')
    const before = await inspectBinary(executable, maxBytes)
    if (expectedChecksum !== undefined && before.checksum !== expectedChecksum)
      return unavailable('selected runtime binary changed; discover and select it again.')
    const env: NodeJS.ProcessEnv = { PATH: dirname(executable), LANG: 'C', LC_ALL: 'C' }
    if (process.platform === 'win32' && process.env.SystemRoot)
      env.SystemRoot = process.env.SystemRoot
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        ['--no-warnings', '-e', PROBE],
        {
          cwd: dirname(executable),
          env,
          timeout,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
          windowsHide: true
        },
        (error, stdout) => {
          if (error)
            reject(
              new Error('Independent Node probe failed or exceeded its limits.', { cause: error })
            )
          else resolve(stdout)
        }
      )
    })
    const result = probeResult.parse(JSON.parse(stdout))
    if (Number(result.node.split('.')[0]) < 22)
      return unavailable('Node 22 or newer is required.', 'node_version_unsupported')
    if (result.platform !== process.platform || result.arch !== process.arch)
      return unavailable(
        'Node platform or architecture does not match this host.',
        'node_host_mismatch'
      )
    if ((await realpath(result.executable)) !== executable)
      return unavailable('probe returned another executable identity.')
    if (fingerprint(await lstat(executable, { bigint: true })) !== before.fingerprint)
      return unavailable('executable changed during its probe.')
    const roots = new Set([executable])
    for (const library of result.sharedObjects) {
      if (!isAbsolute(library)) return unavailable('probe returned a non-absolute library path.')
      try {
        const canonical = await realpath(library)
        if (!(await lstat(canonical)).isFile())
          return unavailable('a runtime library is not a regular file.')
        roots.add(canonical)
      } catch (error) {
        // macOS reports dyld shared-cache libraries whose public file paths do not exist on disk.
        if (process.platform !== 'darwin' || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
      }
    }
    if (roots.size > 32)
      return unavailable('runtime library discovery exceeds the narrow root limit.')
    return {
      kind: 'node',
      executable,
      version: result.node,
      sha256: before.checksum,
      platform: result.platform,
      arch: result.arch,
      readOnlyRoots: [...roots].sort()
    }
  }
  const discover = async (): Promise<ManagedResearchNodeRuntimeDiscovery> => {
    const result: ManagedResearchNodeRuntimeDiscovery = { runtimes: [], unavailable: [] }
    const visited = new Set<string>()
    for (const candidate of candidates) {
      try {
        const executable = await realpath(candidate)
        if (visited.has(executable)) continue
        visited.add(executable)
        const runtime = await probe(executable)
        const id = runtimeId(runtime)
        records.set(id, structuredClone(runtime))
        result.runtimes.push({ runtimeId: id, runtime })
      } catch (error) {
        result.unavailable.push({
          candidate,
          code:
            error instanceof NodeRuntimeUnavailableError
              ? error.code
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'node_not_found'
                : 'node_unusable',
          reason: String(error instanceof Error ? error.message : error).slice(0, 1000)
        })
      }
    }
    return result
  }
  const verify = async (runtime: ManagedResearchRuntime): Promise<void> => {
    const expected = structuredClone(runtime)
    let trusted = false
    for (const candidate of candidates) {
      const current = await realpath(candidate).catch(() => undefined)
      if (current === expected.executable) {
        trusted = true
        break
      }
    }
    if (!trusted) return unavailable('selected executable is no longer a trusted host candidate.')
    const current = await probe(expected.executable, expected.sha256)
    if (
      current.kind !== expected.kind ||
      current.version !== expected.version ||
      current.sha256 !== expected.sha256 ||
      current.platform !== expected.platform ||
      current.arch !== expected.arch ||
      JSON.stringify(current.readOnlyRoots) !== JSON.stringify(expected.readOnlyRoots)
    )
      return unavailable('selected runtime identity changed; discover and select it again.')
  }
  return {
    discover,
    verify,
    resolve: async (id) => {
      if (!/^[a-f0-9]{64}$/u.test(id)) return unavailable('invalid runtime identity.')
      if (!records.has(id)) await discover()
      const selected = records.get(id)
      if (!selected)
        return unavailable('selected runtime is unavailable; discover host runtimes again.')
      await verify(selected)
      return structuredClone(selected)
    }
  }
}
