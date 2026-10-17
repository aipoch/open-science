import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DATASET_LIMITS, inspectDataset } from './dataset-inspection'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open) }
})

const directories: string[] = []
async function fixture(content: string | Buffer, name = 'table.csv'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dataset-inspection-'))
  directories.push(root)
  await writeFile(join(root, name), content)
  return root
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bounded read-only dataset inspection', () => {
  it('recognizes signed and fractional numeric text without normalizing IDs', async () => {
    const root = await fixture('value\n+1\n.5\n1.\n1e3\n-2.5E-2\n')
    expect(
      await inspectDataset({ path: 'table.csv', columns: ['value'], idColumn: 'value' }, [root])
    ).toMatchObject({
      columns: [
        {
          type: 'number',
          numericCount: 5,
          numericRange: { min: -0.025, max: 1000 },
          duplicateIdCount: 0
        }
      ]
    })
  })

  it('rejects roots and intermediate storage directories replaced by symlinks', async () => {
    const storage = await fixture('id\n1')
    const outside = await fixture('secret\n2')
    await symlink(outside, join(storage, 'root'))
    await expect(
      inspectDataset({ path: 'table.csv' }, [join(storage, 'root')], undefined, storage)
    ).rejects.toThrow('trusted storage')
    await mkdir(join(outside, 'data'))
    await writeFile(join(outside, 'data', 'table.csv'), 'secret\n3')
    await expect(
      inspectDataset({ path: 'table.csv' }, [join(storage, 'root', 'data')], undefined, storage)
    ).rejects.toThrow('trusted storage')
    await expect(
      inspectDataset({ path: 'table.csv' }, [outside], undefined, storage)
    ).rejects.toThrow('outside trusted storage')
  })

  it('observes cancellation during a read and closes the file handle', async () => {
    const fs = await import('node:fs/promises')
    const root = await fixture('id\n1')
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const controller = new AbortController()
    let close: ReturnType<typeof vi.spyOn> | undefined
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      close = vi.spyOn(handle, 'close')
      vi.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof handle.read>) => {
        controller.abort(new Error('inspection cancelled'))
        return read(...readArgs)
      })
      return handle
    })
    try {
      await expect(
        inspectDataset({ path: 'table.csv' }, [root], controller.signal)
      ).rejects.toThrow('inspection cancelled')
      expect(close).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
  it('rejects Parquet and accepts explicit CSV format for extensionless staged files', async () => {
    const root = await fixture('id,value\na,1\n', 'table.parquet')
    await expect(inspectDataset({ path: 'table.parquet' }, [root])).rejects.toThrow(
      'select CSV or TSV'
    )
    await expect(
      inspectDataset({ path: 'table.parquet', format: 'parquet' } as never, [root])
    ).rejects.toThrow()
    await writeFile(join(root, 'content'), 'id,value\na,1\n')
    expect(await inspectDataset({ path: 'content', format: 'csv' }, [root])).toMatchObject({
      format: 'csv',
      dimensions: { rows: 1, columns: 2 },
      inspection: { scope: 'complete' }
    })
  })

  it('reports dimensions, types, requested statistics and exact ID duplicates without writing', async () => {
    const source = 'id,value,group\n001,1,a\n1,3,a\n001,,b\n,NA,c\n'
    const root = await fixture(source)
    const result = await inspectDataset(
      { path: 'table.csv', columns: ['value'], idColumn: 'id', missingValues: ['', 'NA'] },
      [root]
    )
    expect(result).toMatchObject({
      format: 'csv',
      dimensions: { rows: 4, columns: 3 },
      inspection: { scope: 'complete', rowsInspected: 4, stopReason: 'eof' },
      columns: [
        { name: 'id', missingCount: 1, duplicateIdCount: 1 },
        { name: 'value', type: 'integer', missingCount: 2, numericRange: { min: 1, max: 3 } },
        { name: 'group', type: 'string' }
      ],
      preview: {
        rows: [
          ['001', '1', 'a'],
          ['1', '3', 'a'],
          ['001', '', 'b'],
          ['', 'NA', 'c']
        ]
      }
    })
    expect((result.columns as object[])[2]).not.toHaveProperty('missingCount')
    expect(await readFile(join(root, 'table.csv'), 'utf8')).toBe(source)
  })

  it('handles BOM, CRLF, quoted separators, escaped quotes and multiline logical records', async () => {
    const root = await fixture('\uFEFFid\tnote\r\n1\t"a\tb\r\nc"\r\n2\t"say ""hi"""', 'table.tsv')
    expect(await inspectDataset({ path: 'table.tsv' }, [root])).toMatchObject({
      dimensions: { rows: 2, columns: 2 },
      preview: {
        rows: [
          ['1', 'a\tb\r\nc'],
          ['2', 'say "hi"']
        ]
      }
    })
  })

  it('does not present prefix statistics or dimensions as complete-file evidence', async () => {
    const root = await fixture('id,value\na,1\nb,2\na,999\n')
    expect(
      await inspectDataset({ path: 'table.csv', maxRows: 2, columns: ['value'], idColumn: 'id' }, [
        root
      ])
    ).toMatchObject({
      dimensions: { rows: null, columns: 2 },
      inspection: {
        scope: 'sample',
        sampling: 'prefix',
        rowsInspected: 2,
        stopReason: 'row_limit'
      },
      columns: [{ duplicateIdCount: 0 }, { numericRange: { min: 1, max: 2 } }]
    })
  })

  it.each(['id\n1\n2\n', 'id\n1\n2'])(
    'recognizes EOF exactly at the row limit (%j)',
    async (source) => {
      const root = await fixture(source)
      expect(await inspectDataset({ path: 'table.csv', maxRows: 2 }, [root])).toMatchObject({
        dimensions: { rows: 2 },
        inspection: { scope: 'complete', stopReason: 'eof' }
      })
    }
  )

  it('stops at a byte limit and discards an incomplete final logical record', async () => {
    const root = await fixture(
      `id,value\n${'x,' + 'a'.repeat(1000) + '\n'}`.repeat(1) +
        `y,${'b'.repeat(1000)}\n`.repeat(9000)
    )
    const result = await inspectDataset({ path: 'table.csv', maxRows: 10000 }, [root])
    expect(result).toMatchObject({
      bytesRead: DATASET_LIMITS.bytes,
      dimensions: { rows: null },
      inspection: { scope: 'sample', stopReason: 'byte_limit' }
    })
  })

  it('bounds retained cells independently of rows and clips only displayed previews', async () => {
    const names = Array.from({ length: 128 }, (_, i) => `c${i}`)
    const root = await fixture(
      `${names.join(',')}\n${('x'.repeat(140) + ',' + Array(127).fill('1').join(',') + '\n').repeat(1600)}`
    )
    const result = await inspectDataset({ path: 'table.csv', maxRows: 10000 }, [root])
    expect(result).toMatchObject({
      inspection: { scope: 'sample', rowsInspected: 1562, stopReason: 'cell_limit' },
      preview: { truncatedCells: 5 }
    })
  })

  it.each([
    ['', 'header'],
    ['id,id\n1,2', 'Duplicate column'],
    ['id,\n1,2', 'nonempty'],
    ['id,value\n1', 'fields'],
    ['id\n"unterminated', 'Unterminated'],
    ['id\n"a"b', 'Malformed'],
    ['id\nab"c', 'Malformed'],
    [`id\n${'a'.repeat(DATASET_LIMITS.fieldChars + 1)}`, 'field exceeds'],
    [`${Array.from({ length: 129 }, (_, i) => `c${i}`).join(',')}\n`, '128-column']
  ])('rejects malformed or oversized tables (%s)', async (source, error) => {
    const root = await fixture(source)
    await expect(inspectDataset({ path: 'table.csv' }, [root])).rejects.toThrow(error)
  })

  it('preserves header-only dimensions and refuses unknown columns and invalid UTF-8', async () => {
    const root = await fixture('id,value\n')
    expect(await inspectDataset({ path: 'table.csv' }, [root])).toMatchObject({
      dimensions: { rows: 0, columns: 2 }
    })
    await expect(
      inspectDataset({ path: 'table.csv', columns: ['absent'] }, [root])
    ).rejects.toThrow('Unknown')
    await writeFile(join(root, 'table.csv'), Buffer.from([0xff, 0xfe]))
    await expect(inspectDataset({ path: 'table.csv' }, [root])).rejects.toThrow()
  })

  it('retains explicit missing-value semantics and avoids rounding large numeric-looking IDs', async () => {
    const root = await fixture(
      'id,value\n9007199254740993,NA\n9007199254740992,NaN\n001,Infinity\n'
    )
    expect(
      await inspectDataset({ path: 'table.csv', idColumn: 'id', columns: ['value'] }, [root])
    ).toMatchObject({
      columns: [
        { type: 'string', duplicateIdCount: 0, numericRange: null },
        { type: 'string', missingCount: 0, numericRange: null }
      ]
    })
  })

  it('excludes nonzero underflow without changing previews or exact ID duplicates', async () => {
    const root = await fixture('value\n1e-400\n-1e-400\n1e-400\n0\n')
    expect(
      await inspectDataset({ path: 'table.csv', columns: ['value'], idColumn: 'value' }, [root])
    ).toMatchObject({
      inspection: { scope: 'complete', rowsInspected: 4 },
      columns: [
        { type: 'mixed', numericCount: 1, numericRange: { min: 0, max: 0 }, duplicateIdCount: 1 }
      ],
      preview: { rows: [['1e-400'], ['-1e-400'], ['1e-400'], ['0']] }
    })
    await writeFile(join(root, 'table.csv'), 'value\n1e-400\n-1e-400\n')
    expect(await inspectDataset({ path: 'table.csv', columns: ['value'] }, [root])).toMatchObject({
      columns: [{ type: 'string', numericCount: 0, numericRange: null }]
    })
  })

  it('keeps true zeros and representable tiny values in numeric statistics', async () => {
    const root = await fixture('value\n0e-999\n-0.0e-999\n5e-324\n-5e-324\n1e-308\n1e3\n')
    expect(await inspectDataset({ path: 'table.csv', columns: ['value'] }, [root])).toMatchObject({
      columns: [{ type: 'number', numericCount: 6, numericRange: { min: -5e-324, max: 1000 } }]
    })
  })

  it('rejects traversal, symlink escape, directories, missing files and untrusted roots', async () => {
    const root = await fixture('id\n1')
    const outside = await fixture('secret\n2')
    await symlink(join(outside, 'table.csv'), join(root, 'link.csv'))
    for (const path of [
      join(outside, 'table.csv'),
      join(root, '..', outside.split('/').at(-1)!, 'table.csv'),
      'link.csv'
    ]) {
      await expect(inspectDataset({ path }, [root])).rejects.toThrow('outside')
    }
    await expect(inspectDataset({ path: root }, [root])).rejects.toThrow('regular file')
    await expect(inspectDataset({ path: 'missing.csv' }, [root])).rejects.toThrow('not found')
    await expect(inspectDataset({ path: join(root, 'table.csv') }, [])).rejects.toThrow('outside')
  })

  it('validates request limits and observes cancellation before reading', async () => {
    const root = await fixture('id\n1')
    for (const maxRows of [0, 10001, 1.5]) {
      await expect(inspectDataset({ path: 'table.csv', maxRows }, [root])).rejects.toThrow()
    }
    await expect(
      inspectDataset({ path: 'table.csv' }, [root], AbortSignal.abort())
    ).rejects.toThrow()
  })
})
