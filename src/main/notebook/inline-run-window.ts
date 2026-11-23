import { open } from 'node:fs/promises'
import type { NotebookRunRecord } from '../../shared/notebook'

type FileIdentity = { size: number; ino: number; mtimeMs: number; ctimeMs: number }
export type InlineRunSlot = { file: InlineRunFile; index: number }
type InlineRunFile = { path: string; identity: FileIdentity; offsets: Uint32Array }

// Called only on a successfully decoded JSON document. Skip strings (including escaped
// quotes) before looking at delimiters so source code and output cannot create false slots.
export function indexInlineRuns(
  path: string,
  identity: FileIdentity,
  json: string,
  count: number
): InlineRunFile | undefined {
  if (
    !count ||
    json.includes('\uFFFD') ||
    identity.size > 0xffffffff ||
    Buffer.byteLength(json) !== identity.size
  )
    return
  // Walk V8's string directly. Converting a large manifest to a Buffer would make a
  // second full-size copy just to translate character positions to UTF-8 byte offsets.
  const code = (at: number): number => json.charCodeAt(at)
  let pos = 0
  let measured = 0
  let offset = 0
  function byteOffset(): number {
    offset += Buffer.byteLength(json.slice(measured, pos))
    measured = pos
    return offset
  }
  const space = (byte: number): boolean => byte === 32 || byte === 9 || byte === 10 || byte === 13
  function whitespace(): void {
    while (space(code(pos))) pos++
  }
  function skipString(): void {
    for (;;) {
      const end = json.indexOf('"', pos + 1)
      if (end < 0) throw new Error('Unterminated JSON string')
      let start = end
      while (code(start - 1) === 92) start--
      pos = end
      if ((end - start) % 2 === 0) {
        pos++
        return
      }
    }
  }
  function skipValue(): void {
    whitespace()
    if (code(pos) === 34) return skipString()
    if (code(pos) === 123 || code(pos) === 91) {
      let depth = 1
      pos++
      while (depth && pos < json.length) {
        const byte = code(pos)
        if (byte === 34) skipString()
        else {
          if (byte === 123 || byte === 91) depth++
          if (byte === 125 || byte === 93) depth--
          pos++
        }
      }
    } else {
      while (pos < json.length && !space(code(pos)) && ![44, 125, 93].includes(code(pos))) pos++
    }
  }
  whitespace()
  if (code(pos++) !== 123) return
  let offsets: Uint32Array | undefined
  do {
    whitespace()
    if (code(pos) !== 34) return
    const start = pos
    skipString()
    const key = JSON.parse(json.slice(start, pos))
    whitespace()
    pos++ // colon in validated input
    whitespace()
    if (key === 'runs') {
      if (offsets || code(pos++) !== 91) return
      offsets = new Uint32Array(count * 2)
      for (let i = 0; i < count; i++) {
        whitespace()
        if (code(pos) !== 123) return
        offsets[2 * i] = byteOffset()
        skipValue()
        offsets[2 * i + 1] = byteOffset()
        whitespace()
        if (code(pos++) !== (i + 1 === count ? 93 : 44)) return
      }
    } else skipValue()
    whitespace()
  } while (code(pos++) === 44)
  return offsets ? { path, identity, offsets } : undefined
}

// Read neighboring missing outputs in display order, with at most one file open and a
// bounded buffer per batch. A short read or concurrent replacement falls back to recovery.
export async function readInlineRunBatch(
  rows: NotebookRunRecord[],
  last: number,
  slots: Map<NotebookRunRecord, InlineRunSlot | undefined>
): Promise<Map<NotebookRunRecord, NotebookRunRecord> | undefined> {
  const selected = slots.get(rows[last])
  if (!selected) return
  const { file, index } = selected
  const { identity, offsets } = file
  let lo = offsets[index * 2]
  let hi = offsets[index * 2 + 1]
  let first = last
  const maxBytes = 8 * 1024 * 1024
  if (hi - lo > maxBytes) return
  while (first > 0) {
    const slot = slots.get(rows[first - 1])
    if (slot?.file !== file) break
    const start = offsets[slot.index * 2]
    const end = offsets[slot.index * 2 + 1]
    if (Math.min(Math.abs(end - lo), Math.abs(start - hi)) > 64) break
    const lower = Math.min(lo, start)
    const upper = Math.max(hi, end)
    if (upper - lower > maxBytes) break
    lo = lower
    hi = upper
    first--
  }
  const matches = (stat: FileIdentity): boolean =>
    stat.ino === identity.ino &&
    stat.size === identity.size &&
    stat.mtimeMs === identity.mtimeMs &&
    stat.ctimeMs === identity.ctimeMs
  const handle = await open(file.path, 'r')
  try {
    if (!matches(await handle.stat())) return
    const buffer = Buffer.allocUnsafe(hi - lo)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, lo + used)
      if (!bytesRead) return
      used += bytesRead
    }
    if (!matches(await handle.stat())) return
    const output = new Map<NotebookRunRecord, NotebookRunRecord>()
    for (let i = first; i <= last; i++) {
      const slot = slots.get(rows[i])!
      const raw = JSON.parse(
        buffer.toString('utf8', offsets[slot.index * 2] - lo, offsets[slot.index * 2 + 1] - lo)
      )
      if (raw.runId !== rows[i].runId || raw.storage === 'file') return
      output.set(rows[i], raw)
    }
    return output
  } finally {
    await handle.close()
  }
}
