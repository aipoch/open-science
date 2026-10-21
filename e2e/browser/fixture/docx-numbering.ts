import '@/assets/main.css'
import '@/office-preview/office-preview.css'
import { zipSync, strToU8 } from 'fflate'
import { initI18n } from '@/i18n'
import { renderOfficeFile } from '@/pages/workspace/previews/office-renderers'

const container = document.getElementById('office-preview-root') as HTMLDivElement
const paginated = new URLSearchParams(location.search).has('pages')

// Two independent lists share a numbering template, as in the reported Word document.
const paragraph = (text: string, numId: number): string =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
const parts = {
  '[Content_Types].xml':
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
  '_rels/.rels':
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels':
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
  'word/numbering.xml':
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>',
  'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
    paragraph('Alpha', 1),
    paragraph('Bravo', 1),
    paragraph('Charlie', 1),
    paginated ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '',
    paragraph('Delta', 1),
    paragraph('Echo', 1),
    paragraph('New list', 2),
    paragraph('Next item', 2)
  ].join(
    ''
  )}<w:sectPr><w:pgSz w:w="9000" w:h="6000"/><w:pgMar w:top="400" w:right="400" w:bottom="400" w:left="400"/></w:sectPr></w:body></w:document>`
}

void (async () => {
  await initI18n('en')
  const dispose = await renderOfficeFile({
    bytes: zipSync(
      Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)]))
    ),
    extension: 'docx',
    name: 'numbering.docx',
    container,
    signal: new AbortController().signal
  })
  container.dataset.officePreviewReady = 'true'
  window.addEventListener('pagehide', () => void dispose(), { once: true })
})()
