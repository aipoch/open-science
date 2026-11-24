// @vitest-environment jsdom
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'

import { convertDocxBytesToMarkdown, convertMarkdownToDocxBytes } from './docx-codec'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const buildSyntheticDocx = async (options: {
  bodyXml: string
  stylesXml?: string
  commentsXml?: string
  relationshipsXml?: string
  media?: Record<string, Uint8Array>
}): Promise<Uint8Array> => {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="emf" ContentType="image/x-emf"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  ${options.commentsXml ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.file(
    'word/_rels/document.xml.rels',
    options.relationshipsXml ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${options.commentsXml ? '<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : ''}
</Relationships>`
  )
  zip.file(
    'word/styles.xml',
    options.stylesXml ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/></w:style>
  <w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/></w:style>
</w:styles>`
  )
  if (options.commentsXml) {
    zip.file('word/comments.xml', options.commentsXml)
  }
  if (options.media) {
    for (const [name, content] of Object.entries(options.media)) {
      zip.file(`word/media/${name}`, content)
    }
  }
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${options.bodyXml}
  </w:body>
</w:document>`
  )
  return await zip.generateAsync({ type: 'uint8array' })
}

describe('docx-codec', () => {
  it('round-trips rich Markdown constructs through DOCX and back into rich-mode Markdown', async () => {
    const original = [
      '# Quarterly Research Report',
      '',
      '## Executive Summary',
      '',
      'Paragraph with **bold**, *italic*, ~~strikethrough~~, `inline code`, [Open Science](https://example.com/docs), and [team@example.com](mailto:team@example.com).',
      '',
      '> Quoted observation line one.',
      '>',
      '> Quoted observation line two.',
      '',
      '- Primary item',
      '  - Nested item',
      '- Secondary item',
      '',
      '1. First step',
      '2. Second step',
      '',
      '- [ ] Pending validation',
      '- [x] Completed calibration',
      '',
      '```',
      'const alpha = 1',
      'const beta = alpha + 2',
      '```',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| Accuracy | 98.4% |',
      '| Latency | 12 ms |',
      '',
      '---',
      '',
      `![Calibration plot](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`
    ].join('\n')

    const docxBytes = await convertMarkdownToDocxBytes(original)
    expect(docxBytes.byteLength).toBeGreaterThan(1000)

    const zip = await JSZip.loadAsync(docxBytes)
    expect(zip.file('word/document.xml')).not.toBeNull()

    const convertedMarkdown = await convertDocxBytesToMarkdown(docxBytes)
    const reparsed = parseMarkdownDocument(convertedMarkdown)
    expect(reparsed.mode).toBe('rich')
    expect(reparsed.diagnostics).toEqual([])

    expect(convertedMarkdown).toContain('# Quarterly Research Report')
    expect(convertedMarkdown).toContain('## Executive Summary')
    expect(convertedMarkdown).toContain('**bold**')
    expect(convertedMarkdown).toMatch(/(?:\*italic\*|_italic_)/u)
    expect(convertedMarkdown).toContain('~~strikethrough~~')
    expect(convertedMarkdown).toContain('`inline code`')
    expect(convertedMarkdown).toContain('[Open Science](https://example.com/docs)')
    expect(convertedMarkdown).toContain('[team@example.com](mailto:team@example.com)')
    expect(convertedMarkdown).toContain('> Quoted observation line one.')
    expect(convertedMarkdown).toContain('> Quoted observation line two.')
    expect(convertedMarkdown).toContain('- [ ] Pending validation')
    expect(convertedMarkdown).toContain('- [x] Completed calibration')
    expect(convertedMarkdown).toContain('```\nconst alpha = 1\nconst beta = alpha + 2\n```')
    expect(convertedMarkdown).toContain('| Metric   | Value |')
    expect(convertedMarkdown).toContain('| Accuracy | 98.4% |')
    expect(convertedMarkdown).toMatch(/(?:^|\n)(?:---|\*\*\*|___)(?:\n|$)/u)
    expect(convertedMarkdown).toContain(
      `![Calibration plot](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`
    )

    // Simulate editing the imported Markdown in Plate and saving back to DOCX again
    const editedValue = [
      ...reparsed.value,
      {
        type: 'p',
        children: [{ text: 'Updated conclusion added in rich editor.' }]
      }
    ]
    const editedMarkdown = serializeMarkdownDocument(editedValue)
    const savedDocxBytes = await convertMarkdownToDocxBytes(editedMarkdown)
    const reloadedMarkdown = await convertDocxBytesToMarkdown(savedDocxBytes)
    expect(reloadedMarkdown).toContain('Updated conclusion added in rich editor.')
    expect(parseMarkdownDocument(reloadedMarkdown).mode).toBe('rich')
  })

  it('imports agent-authored Word styles (Title, Subtitle, Quote, Code, Verbatim Char), strips comments, and normalizes multi-paragraph table cells', async () => {
    const docxBytes = await buildSyntheticDocx({
      commentsXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>Please verify</w:t></w:r></w:p></w:comment>
</w:comments>`,
      bodyXml: `
        <w:p>
          <w:pPr><w:pStyle w:val="Title"/></w:pPr>
          <w:r><w:t>Agent Generated Specification</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>
          <w:r><w:t>System Overview</w:t></w:r>
        </w:p>
        <w:p>
          <w:commentRangeStart w:id="0"/>
          <w:r><w:t>Use placeholder &lt;token&gt; with </w:t></w:r>
          <w:r>
            <w:rPr><w:rStyle w:val="VerbatimChar"/></w:rPr>
            <w:t>--strict</w:t>
          </w:r>
          <w:commentRangeEnd w:id="0"/>
          <w:r><w:commentReference w:id="0"/></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:pStyle w:val="Quote"/></w:pPr>
          <w:r><w:t>Key finding from trial run.</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:pStyle w:val="Code"/></w:pPr>
          <w:r><w:t>uv run experiment.py</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:pStyle w:val="Code"/></w:pPr>
          <w:r><w:t>uv run evaluate.py</w:t></w:r>
        </w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Parameter</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>Notes</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>Batch size</w:t></w:r></w:p></w:tc>
            <w:tc>
              <w:p><w:r><w:t>Line A</w:t></w:r></w:p>
              <w:p><w:r><w:t>Line B</w:t></w:r></w:p>
            </w:tc>
          </w:tr>
        </w:tbl>
      `
    })

    const markdown = await convertDocxBytesToMarkdown(docxBytes)
    const parsed = parseMarkdownDocument(markdown)
    expect(parsed.mode).toBe('rich')
    expect(parsed.diagnostics).toEqual([])
    expect(markdown).not.toContain('DOCX_COMMENT_REF')
    expect(markdown).toContain('# Agent Generated Specification')
    expect(markdown).toContain('## System Overview')
    expect(markdown).toContain('`<token>`'.replace(/`/g, '') ? '\\<token>' : '<token>')
    expect(markdown).toContain('`--strict`')
    expect(markdown).toContain('> Key finding from trial run.')
    expect(markdown).toContain('uv run experiment.py\nuv run evaluate.py')
    expect(markdown).toContain('| Batch size | Line A Line B |')
  })

  it('handles empty documents and leading horizontal rules without triggering YAML frontmatter fallback', async () => {
    const emptyDocx = await convertMarkdownToDocxBytes('')
    const emptyMarkdown = await convertDocxBytesToMarkdown(emptyDocx)
    expect(emptyMarkdown).toBe('')
    expect(parseMarkdownDocument(emptyMarkdown).mode).toBe('rich')

    const leadingHrMarkdown = '***\n\nSection after divider\n\n***\n\nFinal section'
    const hrDocx = await convertMarkdownToDocxBytes(leadingHrMarkdown)
    const roundTripped = await convertDocxBytesToMarkdown(hrDocx)
    expect(parseMarkdownDocument(roundTripped).mode).toBe('rich')
    expect(roundTripped).toContain('Section after divider')
    expect(roundTripped).toContain('Final section')
  })

  it('preserves partial heading emphasis in Word docs, exports remote image links and dropdown blocks, and drops unsafe links and unsupported EMF media', async () => {
    const richSource = [
      '# Plain Heading Without Redundant Bold',
      '',
      '![Remote diagram](https://example.com/diagram.png)',
      '',
      '```openscience-dropdown',
      '{"options":["Option A","Option B"],"selected":"Option B"}',
      '```'
    ].join('\n')

    const exportedDocx = await convertMarkdownToDocxBytes(richSource)
    const reimported = await convertDocxBytesToMarkdown(exportedDocx)
    expect(parseMarkdownDocument(reimported).mode).toBe('rich')
    expect(reimported).toContain('# Plain Heading Without Redundant Bold')
    expect(reimported).not.toContain('**Plain Heading Without Redundant Bold**')
    expect(reimported).toContain('[Remote diagram](https://example.com/diagram.png)')
    expect(reimported).toContain('Option B')

    const agentDocx = await buildSyntheticDocx({
      relationshipsXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdBadLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
  <Relationship Id="rIdEmf" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/vector.emf"/>
</Relationships>`,
      media: {
        'vector.emf': new Uint8Array([1, 2, 3, 4])
      },
      bodyXml: `
        <w:p>
          <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
          <w:r><w:t xml:space="preserve">Title with </w:t></w:r>
          <w:r><w:rPr><w:b/></w:rPr><w:t>emphasis</w:t></w:r>
          <w:r><w:t xml:space="preserve"> inside</w:t></w:r>
        </w:p>
        <w:p>
          <w:hyperlink r:id="rIdBadLink">
            <w:r><w:t>Click me safely</w:t></w:r>
          </w:hyperlink>
        </w:p>
        <w:p>
          <w:r>
            <w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                       xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <wp:inline>
                <wp:docPr id="1" name="Vector" descr="Legacy EMF"/>
                <a:graphic>
                  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:pic>
                      <pic:blipFill><a:blip r:embed="rIdEmf"/></pic:blipFill>
                    </pic:pic>
                  </a:graphicData>
                </a:graphic>
              </wp:inline>
            </w:drawing>
          </w:r>
        </w:p>
      `
    })

    const sanitizedMarkdown = await convertDocxBytesToMarkdown(agentDocx)
    expect(parseMarkdownDocument(sanitizedMarkdown).mode).toBe('rich')
    expect(sanitizedMarkdown).toContain('# Title with **emphasis** inside')
    expect(sanitizedMarkdown).toContain('Click me safely')
    expect(sanitizedMarkdown).not.toContain('javascript:')
    expect(sanitizedMarkdown).not.toContain('image/x-emf')
  })

  it('exports and imports embedded PNG images without Buffer.from base64 decoding and with strict DOMParser mimeType enforcement', async () => {
    const bufferFromSpy = vi.spyOn(Buffer, 'from')
    const originalParseFromString = DOMParser.prototype.parseFromString
    DOMParser.prototype.parseFromString = function strictParseFromString(
      source: string,
      mimeType: DOMParserSupportedType
    ): Document {
      if (typeof mimeType !== 'string' || mimeType.length === 0) {
        throw new TypeError(
          `DOMParser.parseFromString: the provided mimeType "${String(mimeType)}" is not valid.`
        )
      }
      return originalParseFromString.call(this, source, mimeType)
    }

    try {
      const source = [
        '# Browser Runtime Verification',
        '',
        'Paragraph with **bold** and `code`.',
        '',
        `![Figure 1](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`
      ].join('\n')

      const docxBytes = await convertMarkdownToDocxBytes(source)
      expect(
        bufferFromSpy.mock.calls.some((call: readonly unknown[]) => call[1] === 'base64')
      ).toBe(false)

      const roundTripped = await convertDocxBytesToMarkdown(docxBytes)
      expect(roundTripped).toContain('# Browser Runtime Verification')
      expect(roundTripped).toContain('**bold**')
      expect(roundTripped).toContain(`![Figure 1](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})`)
    } finally {
      DOMParser.prototype.parseFromString = originalParseFromString
      bufferFromSpy.mockRestore()
    }
  })

  it('rejects corrupt or empty byte buffers cleanly', async () => {
    await expect(convertDocxBytesToMarkdown(new Uint8Array())).rejects.toThrow()
    await expect(convertDocxBytesToMarkdown(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
  })
})
