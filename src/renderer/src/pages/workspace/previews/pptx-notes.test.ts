// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { extractPptxNotes } from './pptx-notes'

const notesDeck = (): Uint8Array =>
  zipSync(
    {
      'ppt/notesSlides/notesSlide1.xml': strToU8(`
        <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>First presenter note.</a:t></a:r></a:p>
              <a:p><a:r><a:t>Second paragraph.</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:notes>
      `),
      'ppt/notesSlides/_rels/notesSlide1.xml.rels': strToU8(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide1.xml"/>
        </Relationships>
      `)
    },
    { level: 0 }
  )

describe('extractPptxNotes', () => {
  it('extracts body notes and maps them to the related slide', async () => {
    const notes = await extractPptxNotes(notesDeck(), new AbortController().signal)

    expect(notes.get(0)).toBe('First presenter note.\nSecond paragraph.')
    expect(notes.size).toBe(1)
  })

  it('ignores unrelated package parts', async () => {
    const bytes = zipSync(
      {
        'ppt/media/large.bin': new Uint8Array([1, 2, 3]),
        'ppt/notesSlides/notesSlide1.xml': strToU8('<invalid>')
      },
      { level: 0 }
    )

    await expect(extractPptxNotes(bytes, new AbortController().signal)).resolves.toEqual(new Map())
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extractPptxNotes(notesDeck(), controller.signal)).rejects.toThrow()
  })
})
