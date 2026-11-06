import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { resourceFacts } from '../resource-diagnostics/facts'
import { RESOURCE_LOG_LIMIT } from '../resource-diagnostics/store'

const SEGMENT = /^(incident|live)-\d{8}\.jsonl$/
const SEGMENT_LIMIT = 4 * 1024 * 1024
const RECORD_LIMIT = 64 * 1024
type Segment = {
  name: string
  sizeBytes: number
  status: 'pending' | 'exported' | 'partial' | 'failed'
  reason?: string
  retainedRecords: number
  omittedRecords: number
  omittedBytes: number
  outputBytes: number
}

// Do not follow directory links, including the root. Paths are main-owned and names fixed.
async function journalDirectory(configRoot: string): Promise<string> {
  for (const path of [configRoot, join(configRoot, 'logs'), join(configRoot, 'logs/resources')]) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid journal directory')
  }
  return join(configRoot, 'logs/resources')
}

async function discover(configRoot: string): Promise<{ names: string[]; limited: boolean }> {
  const directory = await opendir(await journalDirectory(configRoot))
  const names: string[] = []
  let visited = 0
  let limited = false
  for await (const entry of directory) {
    if (++visited > 4096) {
      limited = true
      break
    }
    if (SEGMENT.test(entry.name)) names.push(entry.name)
  }
  // Prioritize retained fault evidence, independent of renderer selection order.
  names.sort()
  return { names: names.slice(0, 64), limited: limited || names.length > 64 }
}

export async function inspectResourceJournal(
  configRoot: string
): Promise<{ available: boolean; sizeBytes?: number; reason?: string }> {
  try {
    const { names } = await discover(configRoot)
    let sizeBytes = 0
    let found = false
    for (const name of names) {
      const stat = await lstat(join(configRoot, 'logs/resources', name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SEGMENT_LIMIT) continue
      found = true
      sizeBytes += stat.size
    }
    return found
      ? { available: true, sizeBytes: Math.min(sizeBytes, RESOURCE_LOG_LIMIT) }
      : { available: false, reason: 'No resource journal segments available' }
  } catch {
    return { available: false, reason: 'Resource journal unavailable' }
  }
}

/** Keep the recorder's structural allowlist; never export arbitrary data from a local file. */
function projectRecord(line: string): string | undefined {
  try {
    const value = JSON.parse(line)
    if (
      !value ||
      value.schema !== 1 ||
      typeof value.runId !== 'string' ||
      !/^[\w.:-]{1,160}$/.test(value.runId) ||
      typeof value.event !== 'string' ||
      !/^[\w.-]{1,160}$/.test(value.event) ||
      !Number.isFinite(value.time) ||
      !value.data ||
      typeof value.data !== 'object' ||
      Array.isArray(value.data)
    )
      return undefined
    if (value.event === 'segment-checkpoint') {
      if (!Number.isSafeInteger(value.throughSequence) || value.throughSequence < 0)
        return undefined
      const data = resourceFacts(value.data) as Record<string, unknown>
      // Checkpoints combine individually bounded identities; do not apply the per-observer
      // array cap to their complete retained identity list (the whole line is already bounded).
      for (const key of ['processes', 'snapshots']) {
        if (Array.isArray(value.data[key]))
          data[key] = value.data[key].map((item: unknown) => resourceFacts(item))
      }
      return (
        JSON.stringify({
          schema: 1,
          runId: value.runId,
          event: value.event,
          time: value.time,
          throughSequence: value.throughSequence,
          data
        }) + '\n'
      )
    }
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !Number.isFinite(value.elapsedMs)
    )
      return undefined
    return (
      JSON.stringify({
        schema: 1,
        runId: value.runId,
        sequence: value.sequence,
        time: value.time,
        elapsedMs: value.elapsedMs,
        event: value.event,
        data: resourceFacts(value.data)
      }) + '\n'
    )
  } catch {
    return undefined
  }
}

/** Read-only worker snapshot. Open handles survive ordinary rename/unlink rotation. */
export async function exportResourceJournal(
  configRoot: string,
  content: string
): Promise<{
  files: string[]
  partial: boolean
  metadata: {
    limitBytes: number
    readBytes: number
    outputBytes: number
    limited: boolean
    segments: Segment[]
  }
}> {
  const { names, limited } = await discover(configRoot)
  const files: string[] = []
  const segments: Segment[] = []
  const pinned: { segment: Segment; handle: FileHandle; ino: bigint; dev: bigint }[] = []
  let readBytes = 0
  let outputBytes = 0
  let reservedBytes = 0
  try {
    for (const name of names) {
      const segment: Segment = {
        name,
        sizeBytes: 0,
        status: 'pending',
        retainedRecords: 0,
        omittedRecords: 0,
        omittedBytes: 0,
        outputBytes: 0
      }
      segments.push(segment)
      let handle: FileHandle | undefined
      try {
        const path = join(await journalDirectory(configRoot), name)
        const info = await lstat(path, { bigint: true })
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not a regular segment')
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stat = await handle.stat({ bigint: true })
        segment.sizeBytes = Number(stat.size)
        if (
          !stat.isFile() ||
          stat.ino !== info.ino ||
          stat.dev !== info.dev ||
          stat.size > BigInt(SEGMENT_LIMIT) ||
          reservedBytes + segment.sizeBytes > RESOURCE_LOG_LIMIT
        ) {
          segment.reason = 'Invalid segment or resource read budget exceeded'
          throw new Error('Invalid segment')
        }
        reservedBytes += segment.sizeBytes
        pinned.push({ segment, handle, ino: stat.ino, dev: stat.dev })
        handle = undefined
      } catch {
        segment.status = 'failed'
        segment.reason ??= 'Segment unavailable or replaced before snapshot'
      } finally {
        await handle?.close()
      }
    }
    await mkdir(join(content, 'logs/resources'), { recursive: true, mode: 0o700 })
    for (const { segment, handle, ino, dev } of pinned) {
      const output = `logs/resources/${segment.name}`
      let destination: FileHandle | undefined
      try {
        const buffer = Buffer.alloc(segment.sizeBytes)
        let offset = 0
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset)
          if (!read.bytesRead) break
          offset += read.bytesRead
        }
        readBytes += offset
        destination = await open(join(content, output), 'wx', 0o600)
        files.push(output)
        segment.status = 'exported'
        let start = 0
        let batch = ''
        let batchBytes = 0
        for (
          let end = buffer.indexOf(10);
          end >= 0 && end < offset;
          end = buffer.indexOf(10, start)
        ) {
          const length = end + 1 - start
          const projected =
            length <= RECORD_LIMIT
              ? projectRecord(buffer.subarray(start, end).toString('utf8'))
              : undefined
          const bytes = projected ? Buffer.byteLength(projected) : 0
          if (!projected || outputBytes + bytes > RESOURCE_LOG_LIMIT) {
            segment.omittedRecords++
            segment.omittedBytes += length
          } else {
            batch += projected
            batchBytes += bytes
            segment.retainedRecords++
            segment.outputBytes += bytes
            outputBytes += bytes
            if (batchBytes >= RECORD_LIMIT) {
              await destination.writeFile(batch)
              batch = ''
              batchBytes = 0
            }
          }
          start = end + 1
        }
        if (batch) await destination.writeFile(batch)
        segment.omittedBytes += segment.sizeBytes - start
        const after = await handle.stat({ bigint: true })
        const current = await lstat(join(configRoot, 'logs/resources', segment.name), {
          bigint: true
        }).catch(() => undefined)
        if (
          segment.omittedBytes ||
          after.size < BigInt(segment.sizeBytes) ||
          !current ||
          current.ino !== ino ||
          current.dev !== dev
        ) {
          segment.status = 'partial'
          segment.reason =
            'Snapshot includes available complete records; invalid, incomplete or rotated bytes accounted for'
        }
      } catch {
        segment.status = 'failed'
        segment.reason = 'Resource segment read or export write failed'
      } finally {
        await destination?.close()
      }
    }
  } finally {
    await Promise.all(pinned.map(({ handle }) => handle.close()))
  }
  return {
    files,
    partial:
      limited || !segments.length || segments.some((segment) => segment.status !== 'exported'),
    metadata: { limitBytes: RESOURCE_LOG_LIMIT, readBytes, outputBytes, limited, segments }
  }
}
