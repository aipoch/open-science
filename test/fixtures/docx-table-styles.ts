import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createDocxTableFixture } from './docx-table-borders'

// Independent OOXML examples: intentionally put firstRow before wholeTable to catch XML-order bugs.
export const createDocxStyleFixture = (
  options: {
    defaultStyle?: boolean
    implicitStyle?: boolean
    firstRow?: boolean
    nested?: boolean
    banding?: boolean
    direct?: boolean
    rowHints?: string[]
    styledContent?: boolean
    rowBandSize?: number
    colBandSize?: number
    verticalBanding?: boolean
    styleColBandSize?: number
    styleBandSize?: number
    extraStyles?: string
    tableLook?: string
  } = {}
): Uint8Array => {
  const parts = unzipSync(createDocxTableFixture({ name: 'styles', properties: '', expected: [] }))
  const conditional = (type: string, xml: string): string =>
    `<w:tblStylePr w:type="${type}">${xml}</w:tblStylePr>`
  const shade = (color: string): string => `<w:tcPr><w:shd w:fill="${color}"/></w:tcPr>`
  parts['word/styles.xml'] =
    strToU8(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    ${
      options.styledContent
        ? `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="32"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="character" w:styleId="Code"><w:rPr><w:rFonts w:ascii="Courier New"/><w:sz w:val="18"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading"><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:sz w:val="44"/><w:rFonts w:ascii="Georgia"/></w:rPr></w:style>`
        : ''
    }
    <w:style w:type="table" w:styleId="Report" ${options.defaultStyle ? 'w:default="1"' : ''}>
    ${options.extraStyles ?? ''}
    <w:tblPr>${options.styleBandSize !== undefined ? `<w:tblStyleRowBandSize w:val="${options.styleBandSize}"/>` : ''}${options.styleColBandSize !== undefined ? `<w:tblStyleColBandSize w:val="${options.styleColBandSize}"/>` : ''}</w:tblPr>
    ${conditional('firstRow', '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>' + shade('F2F4F7').replace('</w:tcPr>', '<w:tcBorders><w:bottom w:val="single" w:sz="4" w:color="FF0000"/></w:tcBorders></w:tcPr>'))}
    ${conditional('wholeTable', '<w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="21"/><w:b w:val="0"/></w:rPr>')}
    ${conditional('band1Horz', shade('DDEEFF'))}
    ${conditional('band2Horz', shade('FFEEDD'))}
    ${conditional('band1Vert', shade('AABBCC'))}
    ${conditional('band2Vert', shade('CCBBAA'))}
    </w:style><w:style w:type="table" w:styleId="Plain"><w:rPr><w:b w:val="0"/><w:sz w:val="20"/></w:rPr></w:style>
    </w:styles>`)
  const cell = (text: string, body = ''): string =>
    `<w:tc><w:tcPr/><w:p><w:r>${options.direct && text === '0-0' ? '<w:rPr><w:b w:val="0"/><w:sz w:val="32"/></w:rPr>' : ''}<w:t>${text}</w:t></w:r></w:p>${options.styledContent && text === '0-0' ? '<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>Cell heading</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Code"/></w:rPr><w:t>heading_code</w:t></w:r></w:p><w:p><w:r><w:rPr><w:rStyle w:val="Code"/></w:rPr><w:t>inline_code</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Code"/><w:rFonts w:ascii="Verdana"/><w:sz w:val="32"/></w:rPr><w:t>direct_code</w:t></w:r></w:p>' : ''}${body}</w:tc>`
  const nested =
    '<w:tbl><w:tblPr><w:tblStyle w:val="Plain"/></w:tblPr><w:tr>' +
    cell('nested') +
    '</w:tr></w:tbl>'
  const table = `<w:tbl><w:tblPr>${options.implicitStyle ? '' : '<w:tblStyle w:val="Report"/>'}${options.rowBandSize !== undefined ? `<w:tblStyleRowBandSize w:val="${options.rowBandSize}"/>` : ''}${options.colBandSize !== undefined ? `<w:tblStyleColBandSize w:val="${options.colBandSize}"/>` : ''}<w:tblLook ${options.tableLook ?? ''} w:val="0020" w:firstRow="${options.firstRow === false ? '0' : '1'}" w:noHBand="${options.banding ? '0' : '1'}" w:noVBand="${options.verticalBanding ? '0' : '1'}"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>${[0, 1, 2].map((row) => `<w:tr>${options.rowHints?.[row] ? `<w:trPr><w:cnfStyle w:val="${options.rowHints[row]}"/></w:trPr>` : ''}${[0, 1].map((col) => cell(`${row}-${col}`, options.nested && row === 0 && col === 0 ? nested : '')).join('')}</w:tr>`).join('')}</w:tbl>`
  const document = strFromU8(parts['word/document.xml'])
  parts['word/document.xml'] = strToU8(document.replace(/<w:tbl>.*<\/w:tbl>/s, table))
  return zipSync(parts)
}
