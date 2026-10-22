import { strToU8, zipSync } from 'fflate'

const edge = (name: string, color = '000000', value = 'single'): string =>
  `<w:${name} w:val="${value}" w:sz="8" w:color="${color}"/>`
const borders = (names = ['top', 'right', 'bottom', 'left', 'insideH', 'insideV']): string =>
  `<w:tblBorders>${names.map((name) => edge(name)).join('')}</w:tblBorders>`
const distinct = `<w:tblBorders>${['top', 'right', 'bottom', 'left'].map((name) => edge(name, 'FF0000')).join('')}${edge('insideH', '0000FF')}${edge('insideV', '008000')}</w:tblBorders>`
const style = (id: string, contents: string): string =>
  `<w:style w:type="table" w:styleId="${id}"><w:name w:val="${id}"/>${contents}</w:style>`
const base = style('Base', `<w:tblPr>${borders()}</w:tblPr>`)
const middle = style('Middle', '<w:basedOn w:val="Base"/>')
const leaf = style('Leaf', '<w:basedOn w:val="Middle"/>')
const named = (id: string): string => `<w:tblStyle w:val="${id}"/>`
const black = ['black', 'black', 'black', 'black']
const none = ['none', 'none', 'none', 'none']

export type DocxTableCase = {
  name: string
  properties: string
  styles?: string
  cellProperties?: string
  merge?: 'horizontal' | 'vertical' | 'vertical-full'
  expected: string[][]
}

// Literal per-cell expectations (top/right/bottom/left). Keep these when removing
// the dependency patch after an upstream release.
export const docxTableCases: DocxTableCase[] = [
  { name: 'direct grid', properties: borders(), expected: Array(6).fill(black) },
  {
    name: 'parent first',
    properties: named('Leaf'),
    styles: base + middle + leaf,
    expected: Array(6).fill(black)
  },
  {
    name: 'child first',
    properties: named('Leaf'),
    styles: leaf + middle + base,
    expected: Array(6).fill(black)
  },
  {
    name: 'inside only',
    properties: borders(['insideH', 'insideV']),
    expected: [
      ['none', 'black', 'black', 'none'],
      ['none', 'none', 'black', 'black'],
      ['black', 'black', 'black', 'none'],
      ['black', 'none', 'black', 'black'],
      ['black', 'black', 'none', 'none'],
      ['black', 'none', 'none', 'black']
    ]
  },
  {
    name: 'outside only',
    properties: borders(['top', 'right', 'bottom', 'left']),
    expected: [
      ['black', 'none', 'none', 'black'],
      ['black', 'black', 'none', 'none'],
      ['none', 'none', 'none', 'black'],
      ['none', 'black', 'none', 'none'],
      ['none', 'none', 'black', 'black'],
      ['none', 'black', 'black', 'none']
    ]
  },
  {
    name: 'distinct edges',
    properties: distinct,
    expected: [
      ['red', 'green', 'blue', 'red'],
      ['red', 'red', 'blue', 'green'],
      ['blue', 'green', 'blue', 'red'],
      ['blue', 'red', 'blue', 'green'],
      ['blue', 'green', 'red', 'red'],
      ['blue', 'red', 'red', 'green']
    ]
  },
  {
    name: 'styled inside edges',
    properties: named('Inside'),
    styles: style('Inside', `<w:tblPr>${borders(['insideH', 'insideV'])}</w:tblPr>`),
    expected: [
      ['none', 'black', 'black', 'none'],
      ['none', 'none', 'black', 'black'],
      ['black', 'black', 'black', 'none'],
      ['black', 'none', 'black', 'black'],
      ['black', 'black', 'none', 'none'],
      ['black', 'none', 'none', 'black']
    ]
  },
  {
    name: 'inherited partial override',
    properties: named('Child'),
    styles:
      style(
        'Child',
        `<w:basedOn w:val="Base"/><w:tblPr><w:tblBorders>${edge('insideH', '0000FF')}</w:tblBorders></w:tblPr>`
      ) + base,
    expected: [
      ['black', 'black', 'blue', 'black'],
      ['black', 'black', 'blue', 'black'],
      ['blue', 'black', 'blue', 'black'],
      ['blue', 'black', 'blue', 'black'],
      ['blue', 'black', 'black', 'black'],
      ['blue', 'black', 'black', 'black']
    ]
  },
  {
    name: 'horizontal merge',
    properties: borders(['top', 'right', 'bottom', 'left']),
    merge: 'horizontal',
    expected: [
      ['black', 'black', 'none', 'black'],
      ['none', 'none', 'none', 'black'],
      ['none', 'black', 'none', 'none'],
      ['none', 'none', 'black', 'black'],
      ['none', 'black', 'black', 'none']
    ]
  },
  {
    name: 'vertical merge',
    properties: borders(['top', 'right', 'bottom', 'left']),
    merge: 'vertical',
    expected: [
      ['black', 'none', 'none', 'black'],
      ['black', 'black', 'none', 'none'],
      ['none', 'black', 'none', 'none'],
      ['none', 'none', 'black', 'black'],
      ['none', 'black', 'black', 'none']
    ]
  },
  {
    name: 'vertical merge reaches bottom',
    properties: borders(['top', 'right', 'bottom', 'left']),
    merge: 'vertical-full',
    expected: [
      ['black', 'none', 'black', 'black'],
      ['black', 'black', 'none', 'none'],
      ['none', 'black', 'none', 'none'],
      ['none', 'black', 'black', 'none']
    ]
  },
  { name: 'borderless', properties: '', expected: Array(6).fill(none) },
  {
    name: 'explicit nil',
    properties: borders(),
    cellProperties: `<w:tcBorders>${['top', 'right', 'bottom', 'left'].map((name) => edge(name, '000000', 'nil')).join('')}</w:tcBorders>`,
    expected: Array(6).fill(none)
  }
]

export const createDocxTableFixture = (scenario: DocxTableCase): Uint8Array => {
  const rows = Array.from(
    { length: 3 },
    (_, row) =>
      `<w:tr>${Array.from({ length: 2 }, (_, col) => {
        if (scenario.merge === 'horizontal' && row === 0 && col === 1) return ''
        const merge =
          scenario.merge === 'horizontal' && row === 0
            ? '<w:gridSpan w:val="2"/>'
            : col === 0 &&
                (scenario.merge === 'vertical-full' || (scenario.merge === 'vertical' && row < 2))
              ? `<w:vMerge w:val="${row === 0 ? 'restart' : 'continue'}"/>`
              : ''
        return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${merge}${scenario.cellProperties ?? ''}</w:tcPr><w:p><w:r><w:t>Cell ${row} ${col}</w:t></w:r></w:p></w:tc>`
      }).join('')}</w:tr>`
  ).join('')
  const parts = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${scenario.styles ?? ''}</w:styles>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr>${scenario.properties}<w:tblW w:w="4800" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>${rows}</w:tbl><w:sectPr><w:pgSz w:w="9000" w:h="6000"/><w:pgMar w:top="400" w:right="400" w:bottom="400" w:left="400"/></w:sectPr></w:body></w:document>`
  }
  return zipSync(
    Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)]))
  )
}

export const readTableBorderColors = (container: HTMLElement): string[][] => {
  const names: Record<string, string> = {
    'rgb(0, 0, 0)': 'black',
    'rgb(255, 0, 0)': 'red',
    'rgb(0, 128, 0)': 'green',
    'rgb(0, 0, 255)': 'blue'
  }
  return Array.from(container.querySelectorAll<HTMLTableCellElement>('td'))
    .filter((cell) => cell.style.display !== 'none')
    .map((cell) => {
      const css = getComputedStyle(cell)
      return ['top', 'right', 'bottom', 'left'].map((side) => {
        const value = css.getPropertyValue(`border-${side}-style`)
        if (
          !value ||
          value === 'none' ||
          value === 'hidden' ||
          parseFloat(css.getPropertyValue(`border-${side}-width`)) === 0
        )
          return 'none'
        const color = css.getPropertyValue(`border-${side}-color`)
        return names[color] ?? color
      })
    })
}
