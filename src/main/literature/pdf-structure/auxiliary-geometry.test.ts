import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

it.each(['oversized', 'rotated'])(
  'keeps requested geometry when an auxiliary page is %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-auxiliary-'))
    try {
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${kind === 'oversized' ? '2400 2400' : '200 200'}] /Rotate ${kind === 'rotated' ? 90 : 0} /Resources << >> >>`
      ]
      let pdf = '%PDF-1.4\n'
      const offsets = objects.map((object, i) => {
        const offset = pdf.length
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
        return offset
      })
      const xref = pdf.length
      pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
      const input = join(root, 'input.pdf')
      await writeFile(input, pdf)
      const script = resolve('resources/pdf-structure/literature-pdf-structure.mjs')
      const output = join(root, 'geometry')
      const run = spawnSync(process.execPath, [script, input, output, '1', 'adjacent'], {
        encoding: 'utf8',
        timeout: 10000
      })
      expect(run.status, run.stderr).toBe(0)
      const result = JSON.parse(await readFile(join(output, 'probe.json'), 'utf8'))
      expect(result.pages.map((page: { pageNumber: number }) => page.pageNumber)).toEqual(
        kind === 'rotated' ? [1, 2] : [1]
      )
      expect(result.pages[0].graphicsBounds).toEqual([])
      const production = join(root, 'production')
      const fast = spawnSync(
        process.execPath,
        [script, input, production, '1', 'adjacent', 'production'],
        {
          encoding: 'utf8',
          timeout: 10000
        }
      )
      expect(fast.status, fast.stderr).toBe(0)
      const optimized = JSON.parse(await readFile(join(production, 'probe.json'), 'utf8'))
      expect(optimized.pages).toEqual(result.pages)
      await expect(readFile(join(production, 'page-1.png'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(readFile(join(production, 'page-1-candidates.png'))).rejects.toMatchObject({
        code: 'ENOENT'
      })

      if (kind === 'oversized') {
        const invalid = spawnSync(
          process.execPath,
          [script, input, join(root, 'requested'), '2', 'adjacent'],
          { encoding: 'utf8', timeout: 10000 }
        )
        expect(invalid.status).not.toBe(0)
        expect(invalid.stderr).toContain('pixel budget exceeded')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
