import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-venn-package.fixture.json'
const context = {
  staticStrings: [],
  staticCollections: [],
  localFileWrappers: [],
  verifiedSerializedValues: [
    { path: 'sets.rds', format: 'rds' as const, valueType: 'r-value' as const }
  ]
}
it.each([1, 2, 4, 6, 7, 8, 10, 11])('captures reported package cell %s', async (index) => {
  const { facts } = await analyzeRNotebookSource(cells[index], context)
  expect(
    await analyzeNotebookSourceFileAccess('r', cells[index], context),
    JSON.stringify(facts)
  ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
})

it.each([
  'venn::venn(list(A=1:3,B=2:4))',
  'library(venn);sets<-list(A=1:3,B=2:4);png("out.png");venn(sets);dev.off()',
  'v<-ggVennDiagram::Venn(list(A=1:3,B=2:4));d<-ggVennDiagram::process_data(v);write.csv(d$regionData[c("id","count")],"regions.csv")',
  'v<-ggVennDiagram::Venn(list(A=1:3,B=2:4));print(methods::slotNames(v))',
  'print(base::formals(venn::venn))'
])('recognizes bounded package operations: %s', async (script) => {
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})
it.each([
  'other::venn(list(A=1:3))',
  'venn<-custom;venn(list(A=1:3))',
  'venn::venn(unknown)',
  'venn::venn(list(A=1:3),ggplot=TRUE)',
  'venn::venn(list(A=1:3),trajectory=custom())',
  'venn::venn(list(A=1:3),par=FALSE)',
  'venn::venn(quote(system("command")))',
  'x<-expression(system("command"));venn::venn(x)',
  'ggVennDiagram::process_data(unknown)',
  'ggVennDiagram::process_data(ggVennDiagram::Venn(list(A=1:3)),shape_id=custom())',
  'other::process_data(list(A=1:3))',
  'formals<-custom;formals(ggVennDiagram::ggVennDiagram)',
  'formals(ggVennDiagram::ggVennDiagram, envir=custom())',
  'formals(other::ggVennDiagram)',
  'methods::slotNames(unknown)',
  'slotNames<-custom;slotNames(list(A=1:3))'
])('keeps unknown dispatch or evaluation blocked: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})

it.each([
  ['venn', 'venn', 'list(A=1:3,B=2:4)'],
  [
    'ggplot2',
    'ggsave',
    '"out.png",plot=ggplot2::ggplot(data.frame(x=1),ggplot2::aes(x,x))+ggplot2::geom_point()'
  ],
  ['dplyr', 'filter', 'data.frame(x=1:3),x>1']
])('skips ordinary data in %s function lookup', async (pkg, name, args) => {
  const script = `library(${pkg});${name}<-list(value=1);${name}(${args})`
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.safeCallNames).toContain(`${pkg}::${name}`)
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})
it.each([
  'library(venn);venn<-function(x) unknown(x);venn(list(A=1:3))',
  'library(venn);venn<-unknown;venn(list(A=1:3))',
  'venn<-list(A=1);venn(list(A=1:3))'
])('does not skip unknown functions or infer missing package loads: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})
it('resolves a prior ordinary data binding without requiring that data cell', async () => {
  const { facts } = await analyzeRNotebookSource(cells[11], {
    ...context,
    resolvedKernelNames: ['venn'],
    rCopyOnModifyNames: ['venn']
  })
  expect(facts.safeCallNames).toContain('venn::venn')
  expect(facts.priorUsedNames).not.toContain('venn')
})

const inspectionPrefix =
  'fns<-ls("package:ggVennDiagram");for(fn in fns){obj<-get(fn,envir=asNamespace("ggVennDiagram"));'
it.each([
  'print(formals(obj))}',
  'if(is.function(obj)){args<-tryCatch(formals(obj),error=function(e)NULL);print(names(args))}}'
])('captures read-only package inspection %s', async (body) => {
  expect(await analyzeNotebookSourceFileAccess('r', inspectionPrefix + body)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})
it.each([
  'obj()}',
  'eval(obj)}',
  'print(unknown(obj))}',
  'tryCatch(formals(obj),error=function(e)writeLines("x","hidden.txt"))}',
  'cat<-obj;cat("hidden")}',
  'formals<-obj;formals(obj)}',
  'assign("hidden",obj,envir=globalenv())}',
  'cat(names(formals(obj)),file="hidden.txt")}'
])('does not certify execution disguised as metadata inspection %s', async (body) => {
  expect((await analyzeNotebookSourceFileAccess('r', inspectionPrefix + body)).externalState).toBe(
    'partial'
  )
})
it('does not certify objects from another namespace', async () => {
  expect(
    (
      await analyzeNotebookSourceFileAccess(
        'r',
        inspectionPrefix.replace('asNamespace("ggVennDiagram")', 'asNamespace("other")') +
          'print(formals(obj))}'
      )
    ).externalState
  ).toBe('partial')
})
