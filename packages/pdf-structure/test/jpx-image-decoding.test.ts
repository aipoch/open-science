import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { resolve } from './paths'

it('renders a native JPX image instead of silently leaving its background', async () => {
  // Lossless 8-by-8 four-colour image; no external document or identifying data.
  const image = Buffer.from(
    '/0//UQAvAAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEAAwQEAAH/XAANQEBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAAC0AAH/k8fUBAR/z7QIBz/PtAgFh8/ACn4AV+wGBysHKwR3f9+YEASTx9oFPwAp+YEAB18Bywcnz8AafgDR+AMABLw5QQYPBO8Er3uABQ16E9t/z8AUCUCzOufH2gs/AFh9oKALTM4mFwfNPEb2B72CE7nPwB5+APH4AYAXvPzJQqLDDxdKLSVCJxaxj8faBgAXK7zPwBp+ANB9QGAZ5QqMa78V/Euyc4MWApf/2Q==',
    'base64'
  )
  const content = Buffer.from('q 0.9 g 0 0 100 100 re f Q q 80 0 0 80 10 10 cm /Im Do Q')
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>'
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream')
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${image.length} >>\nstream\n`
      ),
      image,
      Buffer.from('\nendstream')
    ])
  ]
  let pdf = Buffer.from('%PDF-1.5\n')
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf = Buffer.concat([pdf, Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    return offset
  })
  const xref = pdf.length
  pdf = Buffer.concat([
    pdf,
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    )
  ])
  const root = await mkdtemp(join(tmpdir(), 'pdf-jpx-'))
  try {
    const input = join(root, 'input.pdf'),
      output = join(root, 'geometry')
    await writeFile(input, pdf)
    const result = spawnSync(
      process.execPath,
      [resolve('resources/literature-pdf-structure.mjs'), input, output, '1'],
      { encoding: 'utf8', timeout: 15000 }
    )
    expect(result.status, result.stderr).toBe(0)
    const { data, info } = await sharp(await readFile(join(output, 'page-1.png')))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    for (const [x, y, rgb] of [
      [45, 45, [255, 0, 0]],
      [105, 45, [0, 255, 0]],
      [45, 105, [0, 0, 255]],
      [105, 105, [255, 255, 0]]
    ] as const) {
      const start = (y * info.width + x) * info.channels
      expect([...data.subarray(start, start + 3)]).toEqual([...rgb])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
