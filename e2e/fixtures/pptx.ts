import { strToU8, zipSync } from 'fflate'

// Source-generated fixture: real OOXML with distinct slides and speaker notes, no binary asset.
export const createPreviewPptx = (): Buffer => {
  const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main'
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const namespaces = `xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${relationship}"`
  const relationships = (body: string): string =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="${relationship}/${type}" Target="${target}"/>`
  const group =
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
  const files: Record<string, string> = {
    '_rels/.rels': relationships(rel('rId1', 'officeDocument', 'ppt/presentation.xml')),
    'ppt/presentation.xml': `<p:presentation ${namespaces}><p:sldIdLst>${[1, 2, 3].map((n) => `<p:sldId id="${255 + n}" r:id="rId${n}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="5143500" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships(
      [1, 2, 3].map((n) => rel(`rId${n}`, 'slide', `slides/slide${n}.xml`)).join('')
    )
  }
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  ]
  for (const n of [1, 2, 3]) {
    const shape = (text: string, notes = false): string =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr>${notes ? '<p:ph type="body"/>' : ''}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200"><a:solidFill><a:srgbClr val="222222"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
    files[`ppt/slides/slide${n}.xml`] =
      `<p:sld ${namespaces}><p:cSld><p:spTree>${group}${shape(`Preview slide ${n}`)}</p:spTree></p:cSld></p:sld>`
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships(
      rel('rId1', 'notesSlide', `../notesSlides/notesSlide${n}.xml`)
    )
    files[`ppt/notesSlides/notesSlide${n}.xml`] =
      `<p:notes ${namespaces}><p:cSld><p:spTree>${group}${shape(`Speaker notes for slide ${n}.`, true)}</p:spTree></p:cSld></p:notes>`
    files[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = relationships(
      rel('rId1', 'slide', `../slides/slide${n}.xml`)
    )
    overrides.push(
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
    )
  }
  files['[Content_Types].xml'] =
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])))
  )
}
