// @vitest-environment jsdom
import { PptxViewer } from '@aiden0z/pptx-renderer'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { BoundedBlobUrlCache, installPptxMediaUrlCache } from './office-renderers'

describe('@aiden0z/pptx-renderer integration contract', () => {
  it('exposes the pinned media cache hook used by bounded windowing', () => {
    const container = document.createElement('div')
    const viewer = new PptxViewer(container, { pdfjs: false })
    const cache = new BoundedBlobUrlCache()

    expect(() => installPptxMediaUrlCache(viewer, cache)).not.toThrow()
    expect((viewer as unknown as { mediaUrlCache: Map<string, string> }).mediaUrlCache).toBe(cache)

    viewer.destroy()
  })

  it('searches text in an unloaded slide through the presentation model', async () => {
    const slide = (text: string): Uint8Array =>
      strToU8(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree><p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr>
          <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
        </p:sp></p:spTree></p:cSld>
      </p:sld>`)
    const bytes = zipSync(
      {
        '[Content_Types].xml': strToU8(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'
        ),
        'ppt/presentation.xml': strToU8(
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>'
        ),
        'ppt/_rels/presentation.xml.rels': strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'
        ),
        'ppt/slides/slide1.xml': slide('Introduction'),
        'ppt/slides/slide2.xml': slide('Needle in second slide')
      },
      { level: 0 }
    )
    const viewer = new PptxViewer(document.createElement('div'), { pdfjs: false, lazySlides: true })
    try {
      await viewer.open(bytes.buffer as ArrayBuffer, { renderMode: 'slide', lazySlides: true })
      expect(viewer.searchText('needle').map((match) => match.slideIndex)).toEqual([1])
    } finally {
      viewer.destroy()
    }
  })
})
