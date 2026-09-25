// @vitest-environment jsdom
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
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
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody>
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

const reorderedNotesDeck = (): Uint8Array =>
  zipSync(
    {
      'ppt/presentation.xml': strToU8(`
        <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst>
        </p:presentation>
      `),
      'ppt/_rels/presentation.xml.rels': strToU8(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
        </Relationships>
      `),
      'ppt/notesSlides/notesSlide1.xml': strToU8(`
        <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>Slide one note.</a:t></a:r></a:p></p:txBody></p:sp>
        </p:notes>
      `),
      'ppt/notesSlides/notesSlide2.xml': strToU8(`
        <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>Slide two note.</a:t></a:r></a:p></p:txBody></p:sp>
        </p:notes>
      `),
      'ppt/notesSlides/_rels/notesSlide1.xml.rels': strToU8(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide2.xml"/>
        </Relationships>
      `),
      'ppt/notesSlides/_rels/notesSlide2.xml.rels': strToU8(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide1.xml"/>
        </Relationships>
      `)
    },
    { level: 0 }
  )

const toStrictDeck = (bytes: Uint8Array): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(unzipSync(bytes)).map(([name, contents]) => [
        name,
        strToU8(
          strFromU8(contents)
            .replaceAll(
              'http://schemas.openxmlformats.org/presentationml/2006/main',
              'http://purl.oclc.org/ooxml/presentationml/main'
            )
            .replaceAll(
              'http://schemas.openxmlformats.org/drawingml/2006/main',
              'http://purl.oclc.org/ooxml/drawingml/main'
            )
            .replaceAll(
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
              'http://purl.oclc.org/ooxml/officeDocument/relationships'
            )
        )
      ])
    ),
    { level: 0 }
  )

const deckFormats = [
  ['Transitional', (bytes: Uint8Array) => bytes],
  ['Strict', toStrictDeck]
] as const

describe('extractPptxNotes', () => {
  it.each(deckFormats)(
    '%s: extracts body notes and maps them to the related slide',
    async (_format, prepareDeck) => {
      const notes = await extractPptxNotes(prepareDeck(notesDeck()), new AbortController().signal)

      expect(notes.get(0)).toBe('First presenter note.\nSecond paragraph.')
      expect(notes.size).toBe(1)
    }
  )

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

  it.each(deckFormats)(
    '%s: maps notes to presentation order when slide parts are reordered',
    async (_format, prepareDeck) => {
      const notes = await extractPptxNotes(
        prepareDeck(reorderedNotesDeck()),
        new AbortController().signal
      )

      expect(notes.get(0)).toBe('Slide one note.')
      expect(notes.get(1)).toBe('Slide two note.')
    }
  )

  it('fails closed when notes exceed the aggregate resource budget', async () => {
    const files: Record<string, Uint8Array> = {}
    const noteXml = strToU8(`
      <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
          <p:txBody><a:p><a:r><a:t>Note.</a:t></a:r></a:p></p:txBody></p:sp>
      </p:notes>
    `)
    for (let index = 1; index <= 520; index += 1) {
      files[`ppt/notesSlides/notesSlide${index}.xml`] = noteXml
    }

    await expect(
      extractPptxNotes(zipSync(files, { level: 0 }), new AbortController().signal)
    ).resolves.toEqual(new Map())
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extractPptxNotes(notesDeck(), controller.signal)).rejects.toThrow()
  })
})
