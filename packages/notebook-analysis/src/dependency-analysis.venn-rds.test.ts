import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-venn-rds.fixture.json'
import type { NotebookSerializedValue } from './dependency-analysis-types'

const context = {
  staticStrings: [],
  staticCollections: [],
  localFileWrappers: [],
  verifiedSerializedValues: [
    { path: 'sets.rds', format: 'rds' as const, valueType: 'r-value' as const }
  ]
}
it.each([0, 1, 3, 5, 6, 7])('captures reported Venn RDS cell %s', async (index) => {
  const files = await analyzeNotebookSourceFileAccess(
    index === 0 ? 'python' : 'r',
    cells[index],
    context
  )
  expect(
    files,
    JSON.stringify({
      files,
      facts: index === 0 ? undefined : (await analyzeRNotebookSource(cells[index], context)).facts
    })
  ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
})
it('records ordinary serialized sets at the producer', async () => {
  const { facts } = await analyzeRNotebookSource(cells[1])
  expect(facts.serializedValueWrites).toEqual([
    { path: 'sets.rds', format: 'rds', valueType: 'r-value' },
    { path: 'all_elements.rds', format: 'rds', valueType: 'r-value' }
  ])
})
it.each([
  'unlink("plot.png")',
  'out <- "plot.png"; base::unlink(out, recursive=FALSE)',
  'unlink(c("first.png","second.png"), force=TRUE)'
])('captures exact deletions: %s', async (script) => {
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: []
  })
})
it.each([
  'unlink("*.png")',
  'unlink("plots",recursive=TRUE)',
  'unlink(path)',
  'unlink(custom())',
  'unlink<-custom;unlink("x.png")',
  'other::unlink("x.png")',
  'result<-unlink("x.png")',
  'if(unlink("x.png")==0) print("removed")',
  'unlink("x.png",recursive=flag)',
  'unlink("x.png",recu=FALSE)',
  'unlink("../x.png")',
  'unlink(".")',
  'unlink("dir/")'
])('does not certify unbounded or observed deletions: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})
it('preserves unrelated RDS proof but revokes deleted generations', async () => {
  const analyze = async (script: string): Promise<NotebookSerializedValue[]> =>
    (await analyzeRNotebookSource(script, context)).facts.serializedValueWrites ?? []
  expect(await analyze('unlink("plot.png"); x<-readRDS("sets.rds");saveRDS(x,"next.rds")')).toEqual(
    [{ path: 'next.rds', format: 'rds', valueType: 'r-value' }]
  )
  expect(
    await analyze('unlink("./sets.rds"); x<-readRDS("sets.rds");saveRDS(x,"next.rds")')
  ).toEqual([])
})
it('does not turn deletion into proof of a generated input', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'writeLines("a","x.txt");unlink("x.txt");readLines("x.txt")'
    )
  ).toMatchObject({ reads: ['x.txt'] })
})
it('keeps missing intermediate generation evidence blocked', async () => {
  expect((await analyzeNotebookSourceFileAccess('r', cells[7])).externalState).toBe('partial')
})
