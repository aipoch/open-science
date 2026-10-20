import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as citationApi from '@aipoch/literature-citations'
import * as styleApi from '@aipoch/literature-citations/styles'
import { LiteratureCitationFormatter } from '@aipoch/literature-citations'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'
import { LiteratureLatexBundle } from '@aipoch/literature-citations/documents'
assert.equal('citationKey' in citationApi, false)
assert.deepEqual(Object.keys(styleApi), ['LiteratureCitationStyleLibrary'])
// An unrelated cwd must not be needed to discover styles, locales or WASM.
process.chdir(tmpdir())
const item = bibliographicRecordSchema.parse({
  itemType: 'journalArticle',
  title: 'Independent package acceptance',
  issuedYear: 2025,
  creators: [
    { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' }
  ]
})
const formatter = new LiteratureCitationFormatter()
const formatted = await formatter.formatReferences([{ id: 'paper', item }], 'apa', 'en-US')
assert.match(formatted[0].reference, /Independent package acceptance/)
const bibtex = await formatter.exportReferences([{ id: 'paper', item }], 'bibtex')
assert.equal((await formatter.parseReferences(bibtex)).items[0].title, item.title)
const bundle = await new LiteratureLatexBundle({
  getMany: async () => [{ id: 'paper', metadataRevision: 1, item }]
}).prepare({
  sourceName: 'main.tex',
  content:
    '\\usepackage{biblatex}\n\\addbibresource{references.bib}\n{{cite:paper}}\n{{bibliography}}'
})
assert.equal(bundle.citationCount, 1)
assert.ok(bundle.content.byteLength > 0)

const stylesDirectory = await mkdtemp(join(tmpdir(), 'packed-styles-'))
try {
  const service = new LiteratureCitationFormatter(
    new styleApi.LiteratureCitationStyleLibrary(stylesDirectory)
  )
  await service.formatStyleExample('apa')
  const imported = await service.citationStyles({
    kind: 'import',
    content: `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text"><info><title>External style</title><id>https://example.test/style</id></info><citation><layout><text variable="title"/></layout></citation><bibliography><layout><text variable="title"/></layout></bibliography></style>`
  })
  const styleId = imported.changedStyleId
  assert.ok(styleId)
  assert.equal(
    (await service.citationStyles({ kind: 'preview', styleId })).preview.reference,
    'Genome Editing in Human Cells'
  )
  await service.citationStyles({ kind: 'delete', styleId })
  await assert.rejects(service.formatStyleExample(styleId))
} finally {
  await rm(stylesDirectory, { recursive: true, force: true })
}
