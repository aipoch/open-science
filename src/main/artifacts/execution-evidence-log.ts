import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import { readFileWithinLimit } from '@aipoch/durable-files'
import {
  expandProjection,
  jsonBytesWithinLimit,
  mapGenerations,
  type EvidenceBody,
  type PackedGeneration,
  type ViewRow
} from '../../../resources/notebook/file_evidence_codec.mjs'
import { sha256 } from './provenance-canonical'
import { assertRegularStoragePath } from './provenance-storage'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u)
const laneKey = z
  .string()
  .regex(
    /^execution-file-evidence\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/frames\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/u
  )
const rowSchema = z.tuple([
  z.string().min(1).max(4096),
  hash,
  z.number().int().nonnegative().safe()
])
const rowsSchema = z.array(rowSchema).max(10000)
const deltaSchema = z
  .object({
    base: hash,
    changed: rowsSchema,
    removed: z.array(z.string().min(1).max(4096)).max(10000)
  })
  .strict()
const viewSchema = z.union([rowsSchema, deltaSchema])
const origin = z
  .object({ manifestChecksum: hash, activityId: id, evidenceId: id, checksum: hash })
  .strict()
const common = z.object({
  version: z.literal(1),
  activityId: id,
  pre: hash,
  post: hash,
  checksum: hash,
  poolAddressed: z.literal(true).optional(),
  sources: z.array(origin).min(1).max(128).optional()
})
const diskRecord = common.extend({ projection: z.string() }).strict()
const recordSchema = common.extend({ detail: z.string() }).strict()
const laneSchema = z
  .object({
    key: laneKey,
    views: z.record(hash, viewSchema),
    records: z.array(recordSchema).min(1).max(10000)
  })
  .strict()
export const portableEvidenceSchema = z.array(laneSchema).min(1).max(10000)
export type PortableEvidence = z.infer<typeof portableEvidenceSchema>
type Lane = PortableEvidence[number]
type RecordEntry = Lane['records'][number]
const limit = 64 * 1024 ** 2
const expandedLimit = 256 * 1024 ** 2
const invalidEvidence = (): never => {
  throw new Error('Invalid portable execution evidence.')
}
const poolPrefix = (key: string): string => key.split('/').slice(0, 2).join('/')
export const evidenceLocation = (key: string): { lane: string; activity: string } | undefined => {
  const m = /^(.*)\/activity-([^/]+)\/evidence\.json$/u.exec(key)
  return m && laneKey.safeParse(m[1]).success && id.safeParse(m[2]).success
    ? { lane: m[1], activity: m[2] }
    : undefined
}
const activityPrefix = (lane: string, record: RecordEntry): string =>
  record.poolAddressed ? poolPrefix(lane) : lane + '/activity-' + record.activityId
const parseDetail = (detail: string): EvidenceBody => {
  const body = JSON.parse(detail) as EvidenceBody
  if (
    !Array.isArray(body?.relations) ||
    body.relations.length > 10000 ||
    (body.predecessorGenerations !== undefined &&
      (!Array.isArray(body.predecessorGenerations) || body.predecessorGenerations.length > 10000))
  )
    return invalidEvidence()
  return body
}
// Cache only immutable decoded views. A lane receiving a new encoding has a new view table.
const decodedViews = new WeakMap<
  Lane['views'],
  { rows: Map<string, { listing: ViewRow[]; depth: number }>; bytes: number }
>()
export function viewRows(lane: Lane, key: string, depth = 0, maxBytes = expandedLimit): ViewRow[] {
  if (depth > 64) return invalidEvidence()
  let cache = decodedViews.get(lane.views)
  if (!cache) {
    cache = { rows: new Map(), bytes: 0 }
    decodedViews.set(lane.views, cache)
  }
  const cached = cache.rows.get(key)
  if (cached) {
    if (cached.depth + depth > 64 || cache.bytes > maxBytes) return invalidEvidence()
    return cached.listing
  }
  const view = lane.views[key]
  if (!view) return invalidEvidence()
  let chain = 0
  let rows
  if (Array.isArray(view)) rows = view
  else {
    const files = new Map(
      viewRows(lane, view.base, depth + 1, maxBytes).map((row) => [row[0], row])
    )
    chain = 1 + cache.rows.get(view.base)!.depth
    for (const path of view.removed) if (!files.delete(path)) return invalidEvidence()
    for (const row of view.changed) files.set(row[0], row)
    rows = [...files.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  }
  cache.bytes += jsonBytesWithinLimit(rows, maxBytes - cache.bytes)
  const text = JSON.stringify(rows)
  if (
    cache.bytes > expandedLimit ||
    rows.length > 10000 ||
    sha256(text) !== key ||
    rows.some((r, i) => i > 0 && rows[i - 1][0] >= r[0])
  )
    return invalidEvidence()
  cache.rows.set(key, { listing: rows, depth: chain })
  return rows
}

export function compactLaneViews(lane: Lane): Lane {
  const views: Lane['views'] = Object.create(null)
  let previous: string | undefined
  let depth = 0
  for (const key of new Set(lane.records.flatMap((record) => [record.pre, record.post]))) {
    const rows = viewRows(lane, key)
    views[key] = rows
    if (previous && depth < 64) {
      const before = new Map(viewRows(lane, previous).map((row) => [row[0], row]))
      const changed = rows.filter((row) => {
        const old = before.get(row[0])
        before.delete(row[0])
        return old?.[1] !== row[1] || old[2] !== row[2]
      })
      const delta = { base: previous, changed, removed: [...before.keys()] }
      if (JSON.stringify(delta).length < JSON.stringify(rows).length) views[key] = delta
    }
    depth = Array.isArray(views[key]) ? 0 : depth + 1
    previous = key
  }
  return { ...lane, views }
}
export const projectRecord = (lane: Lane, record: RecordEntry, maxBytes?: number): Buffer => {
  const bytes = expandProjection(
    parseDetail(record.detail),
    [viewRows(lane, record.pre, 0, maxBytes), viewRows(lane, record.post, 0, maxBytes)],
    activityPrefix(lane.key, record),
    maxBytes ?? limit
  )
  if (bytes.length > limit || sha256(bytes) !== record.checksum) return invalidEvidence()
  return bytes
}
export type ProjectedRecord = { lane: Lane; record: RecordEntry; bytes: Buffer }
export const indexPortableEvidence = (lanes: PortableEvidence): Map<string, ProjectedRecord> => {
  const index = new Map<string, ProjectedRecord>()
  const seen = new Set<string>()
  let total = 0
  for (const lane of lanes) {
    if (seen.has(lane.key)) return invalidEvidence()
    seen.add(lane.key)
    const used = new Set<string>()
    for (const record of lane.records) {
      const key = lane.key + '/activity-' + record.activityId + '/evidence.json'
      if (
        index.has(key) ||
        index.size >= 10000 ||
        !lane.views[record.pre] ||
        !lane.views[record.post]
      )
        return invalidEvidence()
      const bytes = projectRecord(lane, record)
      total += bytes.length
      if (total > expandedLimit) return invalidEvidence()
      const sidecar = JSON.parse(bytes.toString())
      if (
        sidecar.activityId !== record.activityId ||
        !['notebook-run', 'compute-job'].includes(sidecar.activityKind) ||
        !id.safeParse(sidecar.evidenceId).success
      )
        return invalidEvidence()
      used.add(record.pre)
      used.add(record.post)
      index.set(key, { lane, record, bytes })
    }
    if (used.size !== Object.keys(lane.views).length) return invalidEvidence()
  }
  return index
}

// Verify the whole log without buffering it. Native writers put the activity ID first;
// an oversized unrelated record still has to pass its trailing checksum.
async function* verifiedLogRecords(
  path: string,
  activities: Set<string>,
  budget: number,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size > limit || budget < 1) return invalidEvidence()
    const chunk = Buffer.allocUnsafe(Math.max(4096, Math.min(budget, 64 * 1024)))
    let parts: Buffer[] = [],
      prefix = '',
      tail: Buffer = Buffer.alloc(0),
      length = 0
    let hash = createHash('sha256')
    for (let position = 0; position < stat.size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await fd.read(
        chunk,
        0,
        Math.min(chunk.length, stat.size - position),
        position
      )
      if (!bytesRead) return invalidEvidence()
      position += bytesRead
      const data = chunk.subarray(0, bytesRead)
      for (let start = 0; start < data.length;) {
        const end = data.indexOf(10, start)
        const piece = data.subarray(start, end < 0 ? data.length : end)
        if (length < 512) prefix += piece.subarray(0, 512 - length).toString('latin1')
        length += piece.length
        if (length <= budget) parts.push(Buffer.from(piece))
        else parts = []
        const joined = Buffer.concat([tail, piece])
        const split = Math.max(0, joined.length - 65)
        hash.update(joined.subarray(0, split))
        tail = joined.subarray(split)
        if (end < 0) break
        if (
          tail.length !== 65 ||
          tail[0] !== 9 ||
          hash.digest('hex') !== tail.toString('latin1', 1)
        )
          return invalidEvidence()
        if (length <= budget)
          yield Buffer.concat(parts, length)
            .subarray(0, length - 65)
            .toString()
        else {
          const id =
            /^\{"version":1,(?:"poolAddressed":true,)?"activityId":"([A-Za-z0-9][A-Za-z0-9._-]{0,255})"[,}]/u.exec(
              prefix
            )?.[1]
          if (!id || activities.has(id))
            throw new Error('Execution evidence exceeds the read limit.')
        }
        parts = []
        prefix = ''
        length = 0
        tail = Buffer.alloc(0)
        hash = createHash('sha256')
        start = end + 1
      }
    }
  } finally {
    await fd.close()
  }
}

// Read only explicitly requested activities. Delta ancestry stays within the supplied lane.
export async function collectLaneRecords(
  root: string,
  lane: string,
  activities: Set<string>,
  signal?: AbortSignal,
  maxBytes?: number
): Promise<Lane | undefined> {
  laneKey.parse(lane)
  const prefix = lane + '/.shadow-evidence'
  const log = prefix + '/log.jsonl'
  try {
    await assertRegularStoragePath(root, log)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const budget = Math.min(maxBytes ?? limit, limit)
  // Raw DEFLATE can slightly expand incompressible detail. Base64 uses four bytes
  // per three, and up to 128 source hops carry IDs and hashes outside the projection.
  const encodedBudget = Math.min(
    limit,
    128 * 1024 + 4 * Math.ceil((budget + Math.ceil(budget / 100) + 32) / 3)
  )
  let remainingViews = maxBytes ?? expandedLimit
  const selected: Lane = { key: lane, views: Object.create(null), records: [] }
  const diskLane: Lane = { key: lane, views: Object.create(null), records: [] }
  async function readView(key: string, depth = 0): Promise<ViewRow[]> {
    hash.parse(key)
    if (depth > 64) return invalidEvidence()
    if (!diskLane.views[key]) {
      const path = prefix + '/views/' + key
      await assertRegularStoragePath(root, path)
      const encoded = await readFileWithinLimit(join(root, path), Math.min(remainingViews, limit))
      remainingViews -= Buffer.byteLength(encoded)
      const body = JSON.parse(encoded)
      if (Array.isArray(body.rows)) diskLane.views[key] = rowsSchema.parse(body.rows)
      else {
        const delta = deltaSchema.parse(body)
        await readView(delta.base, depth + 1)
        diskLane.views[key] = delta
      }
    }
    return viewRows(diskLane, key, depth, maxBytes ?? expandedLimit)
  }
  let size = 0
  for await (const json of verifiedLogRecords(join(root, log), activities, encodedBudget, signal)) {
    const { projection, ...record } = diskRecord.parse(JSON.parse(json))
    if (!activities.has(record.activityId)) continue
    const detail = inflateRawSync(Buffer.from(projection, 'base64'), {
      maxOutputLength: Math.min(budget, (maxBytes ?? expandedLimit) - size)
    }).toString()
    size += Buffer.byteLength(detail)
    if (size > expandedLimit) return invalidEvidence()
    selected.records.push({ ...record, detail })
    for (const key of [record.pre, record.post]) selected.views[key] = await readView(key)
  }
  return selected.records.length ? selected : undefined
}

export function remapLogEvidence(
  source: PortableEvidence,
  ids: Record<string, string>,
  manifestChecksum: string,
  map: (value: unknown) => unknown,
  remapKey: (key: string) => string
): { lanes: PortableEvidence; checksums: Record<string, string> } {
  const checksums: Record<string, string> = Object.create(null)
  const lanes = source.map((lane) => {
    const target: Lane = { key: remapKey(lane.key), views: lane.views, records: [] }
    for (const record of lane.records) {
      const original = JSON.parse(projectRecord(lane, record).toString()) as EvidenceBody
      const expected = map(original) as EvidenceBody
      const prefix = poolPrefix(target.key)
      const expectedBody = mapGenerations(expected, (g) => {
        const generation = g as Record<string, unknown>
        return { ...generation, contentStorageKey: prefix + '/blobs/sha256-' + generation.checksum }
      })
      const expectedBytes = Buffer.from(JSON.stringify(expectedBody, null, 2) + '\n')
      const packed = map(parseDetail(record.detail)) as EvidenceBody
      const detail = mapGenerations(packed, (g) => {
        const [v, i, generationId, time] = g as PackedGeneration
        return [v, i, ids[generationId], time]
      })
      const next: RecordEntry = {
        ...record,
        activityId: ids[record.activityId],
        checksum: sha256(expectedBytes),
        poolAddressed: true,
        detail: JSON.stringify(detail),
        sources: [
          ...(record.sources ?? []),
          {
            manifestChecksum,
            activityId: record.activityId,
            evidenceId: String(original.evidenceId),
            checksum: record.checksum
          }
        ]
      }
      recordSchema.parse(next)
      if (!projectRecord(target, next).equals(expectedBytes)) return invalidEvidence()
      checksums[record.checksum] = next.checksum
      target.records.push(next)
    }
    return target
  })
  return { lanes, checksums }
}
export async function installLaneLogs(root: string, lanes: PortableEvidence): Promise<void> {
  for (const lane of lanes) {
    const dir = join(root, lane.key, '.shadow-evidence')
    await mkdir(join(dir, 'views'), { recursive: true })
    for (const [hash, rows] of Object.entries(lane.views))
      await writeFile(
        join(dir, 'views', hash),
        JSON.stringify(Array.isArray(rows) ? { rows } : rows),
        { flag: 'wx' }
      )
    const lines = lane.records
      .map(({ detail, ...record }) => {
        const json = JSON.stringify({
          ...record,
          projection: deflateRawSync(detail).toString('base64')
        })
        return json + '\t' + sha256(json) + '\n'
      })
      .join('')
    if (Buffer.byteLength(lines) > limit) return invalidEvidence()
    await writeFile(join(dir, 'log.jsonl'), lines, { flag: 'wx' })
  }
}

export async function readNativeEvidence(
  root: string,
  key: string,
  expectedChecksum: string,
  maxBytes: number
): Promise<Buffer> {
  try {
    await assertRegularStoragePath(root, key)
    const bytes = Buffer.from(await readFileWithinLimit(join(root, key), maxBytes))
    if (sha256(bytes) !== expectedChecksum)
      throw new Error('Execution file evidence checksum mismatch.')
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return readLoggedEvidence(root, key, expectedChecksum, maxBytes)
}

export async function readLoggedEvidence(
  root: string,
  key: string,
  expectedChecksum: string,
  maxBytes: number
): Promise<Buffer> {
  const loc = evidenceLocation(key)
  if (!loc) return invalidEvidence()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return invalidEvidence()
  const lane = await collectLaneRecords(
    root,
    loc.lane,
    new Set([loc.activity]),
    undefined,
    maxBytes
  )
  if (!lane || lane.records.length !== 1 || lane.records[0].checksum !== expectedChecksum)
    return invalidEvidence()
  return projectRecord(lane, lane.records[0], Math.min(maxBytes, limit))
}
