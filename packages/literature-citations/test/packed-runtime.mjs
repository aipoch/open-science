import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { LiteratureCitationFormatter } from '@aipoch/literature-citations'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'
import { LiteratureLatexBundle } from '@aipoch/literature-citations/documents'
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
