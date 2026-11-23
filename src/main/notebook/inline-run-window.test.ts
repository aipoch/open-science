import { mkdtemp, writeFile, stat, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { indexInlineRuns, readInlineRunBatch } from './inline-run-window'

let root: string
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

it('reads validated UTF-8 slots and rejects a replaced manifest or ambiguous runs array', async () => {
  root = await mkdtemp(join(tmpdir(), 'inline-runs-'))
  const path = join(root, 'run.json')
  const rows = ['a', 'b'].map((runId): NotebookRunRecord => ({
    runId,
    cellId: runId,
    source: 'user',
    kernelKind: 'bash',
    script: 'echo example',
    status: 'completed',
    startedAt: 1,
    workingFiles: [],
    text: { stderr: '', traceback: '', plain: [], stdout: '中文😀 } ], "runs": [ \\"' },
    outputs: []
  }))
  for (const spacing of [undefined, 2]) {
    const json = JSON.stringify({ before: { runs: rows }, runs: rows, other: 42 }, null, spacing)
    await writeFile(path, json)
    const indexed = indexInlineRuns(path, await stat(path), json, 2)!
    const slots = new Map(rows.map((row, index) => [row, { file: indexed, index }]))
    const batch = await readInlineRunBatch(rows, 1, slots)
    expect(rows.map((row) => batch?.get(row))).toEqual(rows)
    const replacement = path + '.new'
    await writeFile(replacement, json)
    await rename(replacement, path)
    expect(await readInlineRunBatch(rows, 1, slots)).toBeUndefined()
  }
  const duplicate = '{"runs":[{}],"runs":[{}]}'
  await writeFile(path, duplicate)
  expect(indexInlineRuns(path, await stat(path), duplicate, 1)).toBeUndefined()
})
