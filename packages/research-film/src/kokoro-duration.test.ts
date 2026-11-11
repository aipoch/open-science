import { describe, expect, it } from 'vitest'
import { createKokoroDurationModel, extractOnnxOutput } from './kokoro-duration.js'

const varint = (number: number): Buffer => {
  const bytes: number[] = []
  do {
    const byte = number & 127
    number >>>= 7
    bytes.push(byte | (number ? 128 : 0))
  } while (number)
  return Buffer.from(bytes)
}
const field = (tag: number, content: string | Buffer): Buffer => {
  const data = Buffer.from(content)
  return Buffer.concat([varint(tag * 8 + 2), varint(data.length), data])
}
const node = (inputs: string[], output: string, attributes: Buffer = Buffer.alloc(0)): Buffer =>
  field(1, Buffer.concat([...inputs.map((name) => field(1, name)), field(2, output), attributes]))
const name = (text: string): Buffer => field(1, text)
const fixture = (
  options: { missing?: boolean; nested?: boolean; duplicate?: boolean } = {}
): {
  model: Buffer
  expected: Buffer
} => {
  const encoder = node(['input', 'weights', ''], 'encoded')
  const predictor = node(
    [options.missing ? 'missing' : 'encoded'],
    'duration',
    options.nested ? field(5, field(6, Buffer.alloc(0))) : undefined
  )
  const weights = field(5, Buffer.concat([field(8, 'weights'), field(9, Buffer.from([1, 2, 3]))]))
  const input = field(11, name('input'))
  const info = field(13, name('duration'))
  const metadata = field(2, 'speech')
  const prefix = field(2, 'producer'),
    suffix = field(14, 'metadata')
  return {
    model: Buffer.concat([
      prefix,
      field(
        7,
        Buffer.concat([
          encoder,
          predictor,
          node(['duration'], 'waveform'),
          node(['unused'], options.duplicate ? 'duration' : 'unreachable'),
          weights,
          field(5, field(8, 'unused')),
          input,
          field(11, name('unused-input')),
          info,
          field(13, name('waveform')),
          field(12, name('waveform')),
          metadata
        ])
      ),
      suffix
    ]),
    expected: Buffer.concat([
      prefix,
      field(
        7,
        Buffer.concat([
          encoder,
          predictor,
          weights,
          input,
          info,
          metadata,
          field(12, name('duration'))
        ])
      ),
      suffix
    ])
  }
}

describe('Kokoro duration graph', () => {
  it('keeps the exact dependency closure and tensor bytes without mutating the source', () => {
    const { model, expected } = fixture()
    const original = Buffer.from(model)
    expect(extractOnnxOutput(model, 'duration')).toEqual(expected)
    expect(model).toEqual(original)
  })

  it.each([
    [{ missing: true }, 'Missing ONNX dependency'],
    [{ nested: true }, 'Nested ONNX graphs'],
    [{ duplicate: true }, 'Duplicate ONNX output']
  ] as const)('rejects an unsafe graph: %j', (options, message) => {
    expect(() => extractOnnxOutput(fixture(options).model, 'duration')).toThrow(message)
  })

  it('rejects missing output metadata and duplicate model graphs', () => {
    const { model } = fixture()
    expect(() => extractOnnxOutput(model, 'absent')).toThrow('Missing ONNX output definition')
    expect(() => extractOnnxOutput(Buffer.concat([model, model]), 'duration')).toThrow(
      'Expected one'
    )
  })

  it.each([
    [0x3a, 0x7f, 0],
    [0x80],
    [0x3a, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0],
    [0x3c],
    [0x39, 0],
    [0x38, 0x80]
  ])('rejects malformed protobuf boundaries: %j', (...bytes) => {
    expect(() => extractOnnxOutput(Buffer.from(bytes), 'duration')).toThrow()
  })

  it('leaves unknown model revisions on the full-synthesis path', () => {
    expect(createKokoroDurationModel(fixture().model)).toBeUndefined()
  })
})
