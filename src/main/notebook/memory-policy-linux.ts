import { open, statfs } from 'node:fs/promises'
import { endianness } from 'node:os'
import { posix } from 'node:path'
import {
  MemoryPolicyError,
  type MemoryCgroupConstraint,
  type MemoryPolicyAdapter,
  type MemoryPolicyFacts,
  type MemoryPolicySample
} from './memory-policy'

type CgroupMembership = {
  hierarchy: 'v1' | 'v2'
  controllers: string[]
  path: string
}

type CgroupMount = {
  hierarchy: 'v1' | 'v2'
  root: string
  mountPoint: string
  controllers: string[]
}

export type LinuxMemoryReader = {
  read(path: string, signal: AbortSignal, expectedFs?: bigint): Promise<string>
  pinInitialNamespace(signal: AbortSignal): Promise<NamespaceProof>
  pageSize(signal: AbortSignal): Promise<number>
}

type Options = {
  readFile?: (path: string, signal: AbortSignal) => Promise<string>
  reader?: LinuxMemoryReader
  procRoot?: string
  pid?: number | 'self'
  expectedBirth?: string
  // proc/mountinfo cannot prove the absence of namespace-hidden ancestors. Only the
  // trusted runtime/deployment certification owner may supply this fact.
  ancestorVisibility?: 'complete' | 'certified'
  pageSize?: number
}

const maxFileBytes = 128 * 1024
const maxAncestors = 64
const procfsMagic = 0x9fa0n
const nsfsMagic = 0x6e736673n
const cgroupV1Magic = 0x27e0ebn
const cgroupV2Magic = 0x63677270n
// Linux include/linux/proc_ns.h: PROC_CGROUP_INIT_INO. A namespace symlink string
// alone is not proof: the opened descriptor must also belong to genuine nsfs.
const initialCgroupNamespaceInode = 0xeffffffbn

function fail(detail: string): never {
  throw new MemoryPolicyError('linux-memory-unavailable', detail)
}

const boundedReadBuffer = async (
  path: string,
  signal: AbortSignal,
  expectedFs: bigint,
  procRoot: string
): Promise<Buffer> => {
  signal.throwIfAborted()
  const file = await open(path, 'r')
  try {
    const filesystem = await statfs(`${procRoot}/self/fd/${file.fd}`, { bigint: true })
    if (filesystem.type !== expectedFs)
      fail('A required memory fact is not backed by its expected kernel filesystem.')
    const buffer = Buffer.allocUnsafe(maxFileBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxFileBytes) fail('A Linux memory fact exceeds its bounded file size.')
    return buffer.subarray(0, offset)
  } finally {
    await file.close()
  }
}

type NamespaceProof = { identity: string; close(): Promise<void> }
const pinInitialNamespace = async (
  procRoot: string,
  signal: AbortSignal
): Promise<NamespaceProof> => {
  signal.throwIfAborted()
  const proc = await statfs(procRoot, { bigint: true })
  if (proc.type !== procfsMagic) fail('The memory reader has no authenticated procfs.')
  const handle = await open(`${procRoot}/self/ns/cgroup`, 'r')
  try {
    const [identity, filesystem] = await Promise.all([
      handle.stat({ bigint: true }),
      statfs(`${procRoot}/self/fd/${handle.fd}`, { bigint: true })
    ])
    if (filesystem.type !== nsfsMagic || identity.ino !== initialCgroupNamespaceInode) {
      fail(
        'The reader cgroup namespace may hide limiting ancestors; this deployment requires certification.'
      )
    }
    return { identity: `${identity.dev}:${identity.ino}`, close: () => handle.close() }
  } catch (error) {
    await handle.close()
    throw error
  }
}

const readPageSize = async (procRoot: string, signal: AbortSignal): Promise<number> => {
  if (!['arm64', 'x64'].includes(process.arch))
    fail('The Linux auxiliary-vector ABI is unsupported.')
  const buffer = await boundedReadBuffer(`${procRoot}/self/auxv`, signal, procfsMagic, procRoot)
  if (buffer.length % 16 !== 0) fail('The Linux auxiliary-vector page size cannot be verified.')
  const read = (offset: number): bigint =>
    endianness() === 'LE' ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)
  for (let offset = 0; offset < buffer.length; offset += 16) {
    const type = read(offset)
    if (type === 0n) break
    if (type === 6n) {
      const value = Number(read(offset + 8))
      if (!Number.isSafeInteger(value) || value <= 0 || (value & (value - 1)) !== 0) break
      return value
    }
  }
  return fail('The kernel page size is unavailable for cgroup v1 limit parsing.')
}

const safeInteger = (value: string): number => {
  if (!/^\d+$/.test(value)) fail('A Linux memory counter is malformed.')
  const result = Number(value)
  if (!Number.isSafeInteger(result))
    fail('A Linux memory counter exceeds the supported integer range.')
  return result
}

const decodePath = (value: string): string => {
  const decoded = value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
  if (
    !decoded.startsWith('/') ||
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.split('/').some((part) => part === '.' || part === '..')
  ) {
    fail('The Linux cgroup path cannot be resolved safely.')
  }
  return posix.normalize(decoded)
}

export const parseLinuxMemoryInfo = (contents: string): MemoryPolicyFacts => {
  const counters = new Map<string, number>()
  for (const line of contents.trim().split('\n')) {
    const match = /^(MemTotal|MemAvailable|CommitLimit|Committed_AS):\s*(\d+)\s+kB\s*$/.exec(line)
    if (!match) continue
    if (counters.has(match[1])) fail('A Linux memory counter is duplicated.')
    const value = safeInteger(match[2]) * 1024
    if (!Number.isSafeInteger(value))
      fail('A Linux memory counter exceeds the supported integer range.')
    counters.set(match[1], value)
  }
  const totalBytes = counters.get('MemTotal')
  const availableBytes = counters.get('MemAvailable')
  if (!totalBytes || availableBytes === undefined || availableBytes > totalBytes) {
    fail('Linux MemAvailable/MemTotal support is missing or invalid; repair the runtime or kernel.')
  }
  return {
    totalBytes,
    availableBytes,
    ...(counters.has('CommitLimit') ? { commitLimitBytes: counters.get('CommitLimit') } : {}),
    ...(counters.has('Committed_AS') ? { committedBytes: counters.get('Committed_AS') } : {})
  }
}

export const parseLinuxOvercommitMode = (contents: string): 0 | 1 | 2 => {
  const value = contents.trim()
  if (value !== '0' && value !== '1' && value !== '2')
    fail('Linux overcommit applicability is unknown.')
  return Number(value) as 0 | 1 | 2
}

export const parseLinuxCgroupMembership = (contents: string): CgroupMembership[] => {
  const result: CgroupMembership[] = []
  for (const line of contents.trim().split('\n')) {
    if (!line) continue
    const match = /^(\d+):([^:]*):(.+)$/.exec(line)
    if (!match) fail('Linux cgroup membership is malformed.')
    result.push({
      hierarchy: match[1] === '0' && match[2] === '' ? 'v2' : 'v1',
      controllers: match[2] ? match[2].split(',') : [],
      path: decodePath(match[3])
    })
  }
  return result
}

export const parseLinuxCgroupMounts = (contents: string): CgroupMount[] => {
  const result: CgroupMount[] = []
  for (const line of contents.trim().split('\n')) {
    const delimiter = line.indexOf(' - ')
    if (delimiter < 0) continue
    const fields = line.slice(0, delimiter).split(' ')
    const filesystem = line.slice(delimiter + 3).split(' ')
    if (!['cgroup', 'cgroup2'].includes(filesystem[0])) continue
    if (fields.length < 6 || filesystem.length < 3)
      fail('Linux cgroup mount information is malformed.')
    result.push({
      hierarchy: filesystem[0] === 'cgroup2' ? 'v2' : 'v1',
      root: decodePath(fields[3]),
      mountPoint: decodePath(fields[4]),
      controllers:
        filesystem[0] === 'cgroup2'
          ? []
          : filesystem[2].split(',').filter((part) => part === 'memory')
    })
  }
  return result
}

const isWithin = (path: string, root: string): boolean =>
  root === '/' || path === root || path.startsWith(`${root}/`)

const readLimit = (contents: string, version: 1 | 2, pageSize: number): number | undefined => {
  const text = contents.trim()
  if (version === 2 && text === 'max') return undefined
  if (!/^\d+$/.test(text)) fail('A Linux cgroup limit is malformed.')
  const unlimitedV1 = ((1n << 63n) - 1n) & ~(BigInt(pageSize) - 1n)
  if (version === 1 && BigInt(text) === unlimitedV1) return undefined
  return safeInteger(text)
}

const hasMemoryController = (contents: string): boolean => {
  const names = contents.trim() ? contents.trim().split(/\s+/) : []
  if (
    names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)) ||
    new Set(names).size !== names.length
  ) {
    fail('Linux cgroup controller applicability is malformed.')
  }
  return names.includes('memory')
}

export class LinuxMemoryPolicyAdapter implements MemoryPolicyAdapter {
  readonly platform = 'linux'
  private readonly procRoot: string

  constructor(private readonly options: Options = {}) {
    this.procRoot = options.procRoot ?? '/proc'
  }

  async sample(signal: AbortSignal, requestedScope?: string): Promise<MemoryPolicySample> {
    const target = requestedScope?.match(/^linux:pid:(\d+)$/)
    if (requestedScope && !target) fail('The requested Linux execution domain cannot be verified.')
    const pid = target ? safeInteger(target[1]) : (this.options.pid ?? 'self')
    if (pid !== 'self' && (!Number.isSafeInteger(pid) || pid <= 0))
      fail('The target execution process is invalid.')
    const processRoot = `${this.procRoot}/${pid}`
    let proof: NamespaceProof | undefined
    let visibility = this.options.ancestorVisibility
    if (!visibility) {
      try {
        proof = await this.pinNamespace(signal)
        visibility = 'complete'
      } catch (error) {
        if (signal.aborted || error instanceof MemoryPolicyError) throw error
        return fail(
          'The reader cgroup namespace could not be authenticated; repair the runtime or certify this deployment.'
        )
      }
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted()
        const birth = pid === 'self' ? undefined : await this.readBirth(processRoot, signal)
        const [meminfo, overcommit, membership, mountinfo] = await Promise.all([
          this.read(`${this.procRoot}/meminfo`, signal),
          this.read(`${this.procRoot}/sys/vm/overcommit_memory`, signal),
          this.read(`${processRoot}/cgroup`, signal),
          this.read(`${processRoot}/mountinfo`, signal)
        ])
        const mode = parseLinuxOvercommitMode(overcommit)
        const host = parseLinuxMemoryInfo(meminfo)
        if (mode !== 2) {
          delete host.commitLimitBytes
          delete host.committedBytes
        } else if (!host.commitLimitBytes || host.committedBytes === undefined) {
          fail('Linux strict overcommit counters are unavailable.')
        }
        const memberships = parseLinuxCgroupMembership(membership)
        const mounts = parseLinuxCgroupMounts(mountinfo)
        const memoryV1 = memberships.filter(
          (group) => group.hierarchy === 'v1' && group.controllers.includes('memory')
        )
        const unified = memberships.filter((group) => group.hierarchy === 'v2')
        if (memoryV1.length > 1 || unified.length > 1)
          fail('The target memory cgroup membership is ambiguous.')
        const group = memoryV1[0] ?? unified[0]
        if (!group) {
          // A mount without matching membership is an incomplete observation, never an unlimited domain.
          if (mounts.length > 0) fail('The target memory cgroup membership is unknown.')
          const [afterMembership, afterMountinfo] = await Promise.all([
            this.read(`${processRoot}/cgroup`, signal),
            this.read(`${processRoot}/mountinfo`, signal)
          ])
          if (membership !== afterMembership || mountinfo !== afterMountinfo) continue
          if (birth !== undefined && birth !== (await this.readBirth(processRoot, signal))) continue
          await this.verifyNamespace(proof, signal)
          return {
            platform: this.platform,
            source: 'linux-proc',
            executionScope: 'linux:host',
            facts: { ...host, overcommitMode: mode }
          }
        }
        const matching = mounts.filter(
          (mount) =>
            mount.hierarchy === group.hierarchy &&
            (mount.hierarchy === 'v2' || mount.controllers.includes('memory')) &&
            isWithin(group.path, mount.root)
        )
        if (matching.length !== 1) fail('The target memory cgroup mount is missing or ambiguous.')
        const mount = matching[0]
        if (mount.root !== '/' && visibility !== 'certified') {
          fail(
            'Cgroup ancestor visibility is not certified; expose all limiting ancestors or repair the runtime.'
          )
        }
        const relative = posix.relative(mount.root, group.path)
        const leaf = posix.join(mount.mountPoint, relative)
        // Resolve a target process's mounts through its root rather than assuming the backend
        // and interpreter share a mount namespace. The default/self path stays directly readable.
        const mountPrefix = pid === 'self' ? '' : `${processRoot}/root`
        const version = group.hierarchy === 'v2' ? 2 : 1
        const pageSize =
          version === 1
            ? (this.options.pageSize ??
              (await (this.options.reader
                ? this.options.reader.pageSize(signal)
                : readPageSize(this.procRoot, signal))))
            : 1
        if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || (pageSize & (pageSize - 1)) !== 0)
          fail('The kernel page size is invalid.')
        const constraints: MemoryCgroupConstraint[] = []
        const limits: Array<[string, string]> = []
        const availability = new Map<string, { memory: boolean; delegated: boolean }>()
        let currentPath = leaf
        for (let depth = 0; depth < maxAncestors; depth++) {
          // A proved hierarchy root has no memory.{current,max,high} in cgroup v2.
          // A namespace root needs certification and is never silently treated this way.
          const path = `${mountPrefix}${currentPath}`
          if (version === 2) {
            const [controllers, subtree] = await Promise.all([
              this.read(`${path}/cgroup.controllers`, signal, cgroupV2Magic),
              this.read(`${path}/cgroup.subtree_control`, signal, cgroupV2Magic)
            ])
            limits.push(
              [`${path}/cgroup.controllers`, controllers],
              [`${path}/cgroup.subtree_control`, subtree]
            )
            const memory = hasMemoryController(controllers)
            availability.set(currentPath, { memory, delegated: hasMemoryController(subtree) })
            // Only non-root cgroups with the memory controller have memory.* files.
            // Missing memory support here does not erase a limiting ancestor.
            if (currentPath === mount.mountPoint && mount.root === '/' && visibility === 'complete')
              break
            if (!memory) {
              if (currentPath === mount.mountPoint) break
              currentPath = posix.dirname(currentPath)
              if (depth === maxAncestors - 1)
                fail('The memory cgroup hierarchy exceeds its bounded depth.')
              continue
            }
          }
          const currentFile = `${path}/${version === 2 ? 'memory.current' : 'memory.usage_in_bytes'}`
          const limitFile = `${path}/${version === 2 ? 'memory.max' : 'memory.limit_in_bytes'}`
          const [current, maximum, high, hierarchy] = await Promise.all([
            this.read(currentFile, signal, version === 2 ? cgroupV2Magic : cgroupV1Magic),
            this.read(limitFile, signal, version === 2 ? cgroupV2Magic : cgroupV1Magic),
            version === 2
              ? this.read(`${path}/memory.high`, signal, cgroupV2Magic)
              : Promise.resolve(undefined),
            version === 1
              ? this.read(`${path}/memory.use_hierarchy`, signal, cgroupV1Magic)
              : Promise.resolve(undefined)
          ])
          if (version === 1 && hierarchy?.trim() !== '1')
            fail('Non-hierarchical cgroup v1 memory limits are unsupported.')
          constraints.push({
            path: currentPath,
            currentBytes: safeInteger(current.trim()),
            maxBytes: readLimit(maximum, version, pageSize),
            ...(high === undefined ? {} : { highBytes: readLimit(high, version, pageSize) })
          })
          limits.push([limitFile, maximum])
          if (high !== undefined) limits.push([`${path}/memory.high`, high])
          if (hierarchy !== undefined) limits.push([`${path}/memory.use_hierarchy`, hierarchy])
          if (currentPath === mount.mountPoint) break
          currentPath = posix.dirname(currentPath)
          if (depth === maxAncestors - 1)
            fail('The memory cgroup hierarchy exceeds its bounded depth.')
        }
        const [afterMembership, afterMountinfo, afterLimits] = await Promise.all([
          this.read(`${processRoot}/cgroup`, signal),
          this.read(`${processRoot}/mountinfo`, signal),
          Promise.all(
            limits.map(([path]) =>
              this.read(path, signal, version === 2 ? cgroupV2Magic : cgroupV1Magic)
            )
          )
        ])
        if (
          membership !== afterMembership ||
          mountinfo !== afterMountinfo ||
          limits.some(([, value], index) => value !== afterLimits[index])
        ) {
          continue
        }
        if (
          [...availability].some(([path, controller]) => {
            const parent = availability.get(posix.dirname(path))
            return path !== mount.mountPoint && parent && controller.memory !== parent.delegated
          })
        )
          continue
        if (birth !== undefined && birth !== (await this.readBirth(processRoot, signal))) continue
        await this.verifyNamespace(proof, signal)
        return {
          platform: this.platform,
          source: version === 2 ? 'linux-proc-cgroup-v2' : 'linux-proc-cgroup-v1',
          executionScope: `linux:cgroup-v${version}:${leaf}`,
          facts: {
            ...host,
            overcommitMode: mode,
            cgroup: { version, constraints, ancestors: visibility }
          }
        }
      }
      return fail('The execution cgroup or its limits changed during both sampling attempts.')
    } finally {
      await proof?.close()
    }
  }

  private async verifyNamespace(
    proof: NamespaceProof | undefined,
    signal: AbortSignal
  ): Promise<void> {
    if (!proof) return
    const after = await this.pinNamespace(signal)
    try {
      if (proof.identity !== after.identity)
        fail('The reader cgroup namespace changed while memory was sampled.')
    } finally {
      await after.close()
    }
  }

  private pinNamespace(signal: AbortSignal): Promise<NamespaceProof> {
    return this.options.reader
      ? this.options.reader.pinInitialNamespace(signal)
      : pinInitialNamespace(this.procRoot, signal)
  }

  private async readBirth(processRoot: string, signal: AbortSignal): Promise<string> {
    const stat = await this.read(`${processRoot}/stat`, signal)
    const closing = stat.lastIndexOf(') ')
    const startTime =
      closing < 0
        ? undefined
        : stat
            .slice(closing + 2)
            .trim()
            .split(/\s+/)[19]
    if (!startTime || !/^\d+$/.test(startTime))
      fail('The target execution process birth cannot be verified.')
    if (this.options.expectedBirth !== undefined && startTime !== this.options.expectedBirth)
      fail('The target execution process no longer belongs to the original owner.')
    return startTime
  }

  private async read(path: string, signal: AbortSignal, expectedFs = procfsMagic): Promise<string> {
    signal.throwIfAborted()
    try {
      const result = this.options.reader
        ? await this.options.reader.read(path, signal, expectedFs)
        : this.options.readFile
          ? await this.options.readFile(path, signal)
          : (await boundedReadBuffer(path, signal, expectedFs, this.procRoot)).toString('utf8')
      signal.throwIfAborted()
      if (Buffer.byteLength(result) > maxFileBytes)
        fail('A Linux memory fact exceeds its bounded file size.')
      return result
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof MemoryPolicyError) throw error
      return fail(
        'Required Linux memory facts could not be read; repair execution-domain permissions or the runtime.'
      )
    }
  }
}
