import { createHash } from 'node:crypto'

export const KOKORO_DURATION_OUTPUT = '/encoder/Gather_output_0'
const MODEL_SHA256 = 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'
const DURATION_SHA256 = '38f8a2ddcb607f28fafc809d859e9003a56191cff3bf785e014ed69b09eb0a6f'

type Field = { tag: number; start: number; end: number; data: Buffer }

// Read field boundaries only; tensor payloads remain byte-for-byte unchanged.
function fields(bytes: Buffer): Field[] {
  const result: Field[] = []
  let position = 0
  const varint = (): number => {
    let value = 0
    for (let shift = 0; shift < 35 && position < bytes.length; shift += 7) {
      const byte = bytes[position++]
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128) && value <= 0xffffffff) return value
    }
    throw new Error('Invalid ONNX field length')
  }
  while (position < bytes.length) {
    const start = position,
      key = varint(),
      tag = Math.floor(key / 8),
      wire = key % 8
    if (!tag) throw new Error('Invalid ONNX field tag')
    let dataStart = position
    if (wire === 2) {
      const length = varint()
      dataStart = position
      position += length
    } else if (wire === 1) position += 8
    else if (wire === 5) position += 4
    else if (wire === 0) {
      let count = 0
      do {
        if (position >= bytes.length || ++count > 10) throw new Error('Invalid ONNX integer')
      } while (bytes[position++] & 128)
    } else throw new Error('Unsupported ONNX wire type')
    if (position > bytes.length) throw new Error('Truncated ONNX field')
    result.push({ tag, start, end: position, data: bytes.subarray(dataStart, position) })
  }
  return result
}

function message(tag: number, data: Buffer): Buffer {
  const encode = (value: number): Buffer => {
    const bytes: number[] = []
    do {
      const byte = value % 128
      value = Math.floor(value / 128)
      bytes.push(byte + (value ? 128 : 0))
    } while (value)
    return Buffer.from(bytes)
  }
  return Buffer.concat([encode(tag * 8 + 2), encode(data.length), data])
}

/** Extract a flat graph's dependency closure; nested graphs require a separate implementation. */
export function extractOnnxOutput(model: Buffer, output: string): Buffer {
  const graphs = fields(model).filter((field) => field.tag === 7)
  if (graphs.length !== 1) throw new Error('Expected one ONNX graph')
  const graph = graphs[0],
    parts = fields(graph.data)
  const nodes = parts
    .filter((field) => field.tag === 1)
    .map((field) => {
      const entries = fields(field.data)
      return {
        field,
        entries,
        inputs: entries.filter((entry) => entry.tag === 1).map((entry) => entry.data.toString()),
        outputs: entries.filter((entry) => entry.tag === 2).map((entry) => entry.data.toString())
      }
    })
  const producers = new Map<string, (typeof nodes)[number]>()
  for (const node of nodes)
    for (const name of node.outputs) {
      if (!name) continue
      if (producers.has(name)) throw new Error('Duplicate ONNX output')
      producers.set(name, node)
    }
  const needed = new Set<string>(),
    retained = new Set<Field>(),
    pending = [output]
  while (pending.length) {
    const name = pending.pop()!
    if (!name || needed.has(name)) continue
    needed.add(name)
    const node = producers.get(name)
    if (!node) continue
    if (
      node.entries.some(
        (entry) =>
          entry.tag === 5 && fields(entry.data).some((attribute) => [6, 11].includes(attribute.tag))
      )
    )
      throw new Error('Nested ONNX graphs are not supported')
    retained.add(node.field)
    pending.push(...node.inputs)
  }
  const nameOf = (field: Field): string | undefined =>
    fields(field.data)
      .find((entry) => entry.tag === (field.tag === 5 ? 8 : 1))
      ?.data.toString()
  const info = parts.find((field) => [12, 13].includes(field.tag) && nameOf(field) === output)
  if (!info || !producers.has(output)) throw new Error('Missing ONNX output definition')
  const kept = parts.filter((field) =>
    field.tag === 1
      ? retained.has(field)
      : [5, 11, 13].includes(field.tag)
        ? needed.has(nameOf(field) ?? '')
        : field.tag !== 12
  )
  const declared = new Set(kept.filter((field) => [5, 11].includes(field.tag)).map(nameOf))
  for (const node of nodes)
    if (retained.has(node.field)) node.outputs.forEach((name) => declared.add(name))
  for (const name of needed) if (!declared.has(name)) throw new Error('Missing ONNX dependency')
  const payload = Buffer.concat([
    ...kept.map((field) => graph.data.subarray(field.start, field.end)),
    message(12, info.data)
  ])
  return Buffer.concat([
    model.subarray(0, graph.start),
    message(7, payload),
    model.subarray(graph.end)
  ])
}

/** Unknown revisions retain full synthesis; only the validated graph uses 600 samples per frame. */
export function createKokoroDurationModel(model: Buffer): Buffer | undefined {
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  if (digest(model) !== MODEL_SHA256) return undefined
  const duration = extractOnnxOutput(model, KOKORO_DURATION_OUTPUT)
  if (digest(duration) !== DURATION_SHA256) throw new Error('Kokoro duration graph checksum failed')
  return duration
}
