/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { deflateSync } from 'node:zlib'

// A small requested page next to a dense native plot. Repeated Form markers
// retain the same distinction between raw OPLIST and optimized render streams.
export function anonymousAuxiliaryDenseVector(count = 128) {
  const marker = '0 0 m 0.5 0 l 0.25 0.5 l h f'
  const dense = Array.from({ length: count }, (_, i) => {
    const x = 25 + (i % 250)
    const y = 25 + Math.floor(i / 250)
    return `q 1 0 0 1 ${x} ${y} cm /Mark Do Q`
  }).join('\n')
  const stream = (text) => {
    const bytes = deflateSync(Buffer.from(text))
    return Buffer.concat([
      Buffer.from(`<< /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`),
      bytes,
      Buffer.from('\nendstream')
    ])
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /R 8 0 R /T 9 0 R >> /XObject << /Rgb 10 0 R /Alpha 13 0 R >> >> /Contents 4 0 R >>',
    stream(
      '0 0 1 RG 30 30 200 200 re S BT /R 12 Tf 1 0 0 1 45 250 Tm (Native readout 7) Tj /T 20 Tf 1 0 0 1 45 205 Tm (A) Tj ET q 30 30 200 200 re W n q 25 0 0 25 100 200 cm /Rgb Do Q q 25 0 0 25 145 200 cm /Alpha Do Q Q'
    ),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Mark 7 0 R >> >> /Contents 6 0 R >>',
    stream(dense),
    `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << >> /Length ${marker.length} >>\nstream\n${marker}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 12 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n80>\nendstream',
    stream('1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f'),
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 11 0 R /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00ff00>\nendstream'
  ]
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets = []
  let size = parts[0].length
  for (const [index, value] of objects.entries()) {
    offsets.push(size)
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      Buffer.isBuffer(value) ? value : Buffer.from(value),
      Buffer.from('\nendobj\n')
    ])
    parts.push(part)
    size += part.length
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`
    )
  )
  return Buffer.concat(parts)
}
