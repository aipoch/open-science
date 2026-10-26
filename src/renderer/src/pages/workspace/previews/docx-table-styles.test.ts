// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { renderAsync } from 'docx-preview'
import { createDocxStyleFixture } from '../../../../../../test/fixtures/docx-table-styles'

afterEach(() => document.body.replaceChildren())

let renderIndex = 0
const render = async (
  options: Parameters<typeof createDocxStyleFixture>[0],
  commonjs = false
): Promise<{
  container: HTMLDivElement
  span: (text: string) => Element
  css: (text: string) => CSSStyleDeclaration
  cell: (text: string) => CSSStyleDeclaration
}> => {
  const container = document.createElement('div')
  document.body.append(container)
  const renderDocx = commonjs
    ? createRequire(import.meta.url)('docx-preview').renderAsync
    : renderAsync
  await renderDocx(createDocxStyleFixture(options), container, container, {
    className: `probe-${renderIndex++}`
  })
  const spans = Array.from(container.querySelectorAll('td > p > span'))
  const span = (text: string): Element => spans.find((node) => node.textContent === text)!
  return {
    container,
    span,
    css: (text: string) => getComputedStyle(span(text)),
    cell: (text: string) => getComputedStyle(span(text).closest('td')!)
  }
}

describe('DOCX table conditional formatting', () => {
  it.each([false, true])(
    'limits default header formatting to its own row (CommonJS=%s)',
    async (commonjs) => {
      const { css, cell } = await render({ defaultStyle: true }, commonjs)
      expect(cell('0-0').backgroundColor).toBe('rgb(242, 244, 247)')
      expect(cell('0-0').borderBottomStyle).toBe('solid')
      expect(cell('0-0').borderBottomColor).toBe('rgb(255, 0, 0)')
      expect(cell('1-0').backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect(css('0-0').fontWeight).toBe('bold')
      expect(css('1-0').fontWeight).toBe('normal')
      expect(css('0-0').fontSize).toBe('12pt')
      expect(css('1-0').fontSize).toBe('10.5pt')
    }
  )
  it('applies default styles to tables without an explicit style reference', async () => {
    const { css } = await render({ defaultStyle: true, implicitStyle: true })
    expect(css('0-0').fontWeight).toBe('bold')
    expect(css('1-0').fontSize).toBe('10.5pt')
  })
  it('lets explicit tblLook=false override legacy flags and disables header styling', async () => {
    const { css, cell } = await render({ firstRow: false })
    expect(css('0-0').fontWeight).toBe('normal')
    expect(cell('0-0').backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })
  it('starts row banding after the header and keeps the header override', async () => {
    const { cell } = await render({ banding: true })
    expect(cell('0-0').backgroundColor).toBe('rgb(242, 244, 247)')
    expect(cell('1-0').backgroundColor).toBe('rgb(221, 238, 255)')
    expect(cell('2-0').backgroundColor).toBe('rgb(255, 238, 221)')
  })
  it('preserves direct run formatting and isolates nested table styles', async () => {
    const { css, cell } = await render({ defaultStyle: true, nested: true, direct: true })
    expect(css('0-0').fontWeight).toBe('normal')
    expect(css('0-0').fontSize).toBe('16pt')
    expect(css('nested').fontWeight).toBe('normal')
    expect(css('nested').fontSize).toBe('10pt')
    expect(cell('nested').backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })
  it('preserves explicit row region hints instead of overwriting them with geometry', async () => {
    const { cell } = await render({
      banding: true,
      firstRow: false,
      rowHints: ['000000100000', '000000100000', '000000010000']
    })
    expect(cell('0-0').backgroundColor).toBe('rgb(221, 238, 255)')
    expect(cell('1-0').backgroundColor).toBe('rgb(221, 238, 255)')
    expect(cell('2-0').backgroundColor).toBe('rgb(255, 238, 221)')
  })
  it('uses table-style band size when redundant row hints are absent', async () => {
    const { cell } = await render({ banding: true, firstRow: false, styleBandSize: 2 })
    expect(cell('0-0').backgroundColor).toBe('rgb(221, 238, 255)')
    expect(cell('1-0').backgroundColor).toBe('rgb(221, 238, 255)')
    expect(cell('2-0').backgroundColor).toBe('rgb(255, 238, 221)')
  })

  it('applies corner formatting after column and row formatting regardless of XML order', async () => {
    const { cell } = await render({
      tableLook: 'w:firstColumn="1"',
      extraStyles:
        '<w:tblStylePr w:type="nwCell"><w:tcPr><w:shd w:fill="00FF00"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="firstCol"><w:tcPr><w:shd w:fill="0000FF"/></w:tcPr></w:tblStylePr>'
    })
    expect(cell('0-0').backgroundColor).toBe('rgb(0, 255, 0)')
    expect(cell('1-0').backgroundColor).toBe('rgb(0, 0, 255)')
    expect(cell('0-1').backgroundColor).toBe('rgb(242, 244, 247)')
  })
})
