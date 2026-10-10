import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { analyzeNotebookCodeRisk } from './code-risk-analysis'
import { objectLoop162 } from './code-risk-budget-fixtures'
import * as parser from './dependency-analysis-parser'
import { NotebookRuntimeService, type NotebookExecutionApproval } from './runtime-service'

configureTestRuntimeMetadata()

const savedDeletion = 'function eraseSaved(path) { require("node:fs").unlinkSync(path) }'
const ordinary = ['return 42;', 'return 6 * 7;', 'return JSON.stringify({answer:42});']
const deletions = ['require("node:fs").unlinkSync("victim.txt")', 'eraseSaved("victim.txt")']
let eviction = 0
async function evictReplay(): Promise<void> {
  for (let i = 0; i < 12; i++)
    await analyzeNotebookCodeRisk('repl', `// eviction ${eviction++}\nreturn 1;`)
}

describe('Auto object-loop history admission regression', () => {
  it.each(['legacy', 'complete', 'incomplete'] as const)(
    'retains %s history through cold, warm and evicted replay',
    async (completion) => {
      const script = `// ${completion}\n${savedDeletion}\n${objectLoop162}`
      const history =
        completion === 'legacy' ? [script] : [{ script, incomplete: completion === 'incomplete' }]
      for (const cache of ['cold', 'warm', 'evicted']) {
        if (cache === 'evicted') await evictReplay()
        const spy = vi.spyOn(parser, 'withParsedNotebookSource')
        try {
          for (const source of ordinary)
            expect(await analyzeNotebookCodeRisk('repl', source, undefined, history)).toEqual([])
          for (const source of deletions)
            expect(await analyzeNotebookCodeRisk('repl', source, undefined, history)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ operation: expect.stringContaining('fs.unlinkSync') })
              ])
            )
          expect(spy.mock.calls.some(([, source]) => source === script)).toBe(cache !== 'warm')
        } finally {
          spy.mockRestore()
        }
      }
    }
  )

  it('does not cache successful history after a genuine source limit failure', async () => {
    const history = [`// oversized\n${' '.repeat(1024 * 1024)}`]
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await analyzeNotebookCodeRisk('repl', ordinary[0], undefined, history)).toEqual([
        expect.objectContaining({ operation: 'kernel source history exceeds analysis limit' })
      ])
      expect(await analyzeNotebookCodeRisk('repl', deletions[0], undefined, history)).not.toEqual(
        []
      )
    }
  })

  it('rechecks genuinely excessive work instead of caching a successful prefix', async () => {
    // Under the source-size limit, but enough distinct statements to exceed the unchanged
    // 100,000-step budget. This tests fail-closed behavior, not the unresolved recovery goal B.
    const script = 'Math.abs(1);\n'.repeat(30_000)
    for (let attempt = 0; attempt < 2; attempt++) {
      const spy = vi.spyOn(parser, 'withParsedNotebookSource')
      try {
        expect(await analyzeNotebookCodeRisk('repl', ordinary[0], undefined, [script])).toEqual([
          expect.objectContaining({ operation: 'code analysis unavailable' })
        ])
        expect(spy.mock.calls.some(([, source]) => source === script)).toBe(true)
      } finally {
        spy.mockRestore()
      }
    }
  }, 30_000)

  it('does not turn cancelled replay into successful cached evidence', async () => {
    const script = `// cancellation\n${savedDeletion}\n${objectLoop162}`
    const controller = new AbortController()
    const pending = analyzeNotebookCodeRisk(
      'repl',
      ordinary[0],
      undefined,
      [script],
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const spy = vi.spyOn(parser, 'withParsedNotebookSource')
    try {
      expect(await analyzeNotebookCodeRisk('repl', deletions[1], undefined, [script])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: expect.stringContaining('fs.unlinkSync') })
        ])
      )
      expect(spy.mock.calls.some(([, source]) => source === script)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps one real kernel alive for three ordinary operations and one-shot deletion review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-budget-kernel-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'budget'
    })
    const request = { projectId: 'budget', sessionId: 'same-kernel', workspaceCwd: root }
    const approve = vi.fn<NotebookExecutionApproval>(async () => false)
    const kernelDeletions = deletions.map((code) =>
      code.replace('"victim.txt"', JSON.stringify(join(root, 'victim.txt')))
    )
    service.setExecutionApproval(approve)
    try {
      await writeFile(join(root, 'victim.txt'), 'retain until approved')
      const first = await service.executeControl({
        ...request,
        code: `${savedDeletion}\n${objectLoop162}`
      })
      expect(first.status).toBe('completed')
      for (const code of ordinary)
        expect((await service.executeControl({ ...request, code })).status).toBe('completed')
      expect(approve).not.toHaveBeenCalled()
      const before = await service.state(request)
      const completed = before.runs.filter((run) => run.status === 'completed')
      expect(completed).toHaveLength(4)
      expect(completed.every((run) => run.kernelDispatched === true)).toBe(true)
      expect(new Set(completed.map((run) => run.kernelEpochId)).size).toBe(1)
      expect(completed[0].kernelEpochId).toEqual(expect.any(String))
      const loopRun = completed.find((run) => run.script.includes(objectLoop162))!
      expect(loopRun).toBeDefined()
      for (const code of kernelDeletions) {
        await service.executeControl({ ...request, code })
        expect(await readFile(join(root, 'victim.txt'), 'utf8')).toBe('retain until approved')
      }
      expect(approve).toHaveBeenCalledTimes(2)
      for (const call of approve.mock.calls)
        expect(call[0]).toMatchObject({
          rawInput: {
            notebookCodeRisk: {
              risks: expect.arrayContaining([
                expect.objectContaining({ operation: expect.stringContaining('fs.unlinkSync') })
              ])
            }
          }
        })
      approve.mockResolvedValueOnce(true)
      const approvedResult = await service.executeControl({ ...request, code: kernelDeletions[1] })
      expect(approvedResult, JSON.stringify(approvedResult)).toMatchObject({ status: 'completed' })
      await expect(readFile(join(root, 'victim.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await service.executeControl({ ...request, code: kernelDeletions[1] })
      expect(approve).toHaveBeenCalledTimes(4)
      const after = await service.state(request)
      expect(after.runs.find((run) => run.runId === loopRun.runId)?.kernelEpochId).toBe(
        completed[0].kernelEpochId
      )
      expect(
        new Set(
          after.runs.filter((run) => run.status === 'completed').map((run) => run.kernelEpochId)
        ).size
      ).toBe(1)
    } finally {
      await service.shutdownAll()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
