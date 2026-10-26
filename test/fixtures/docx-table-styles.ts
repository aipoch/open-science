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
    <w:style w:type="table" w:styleId="Report" ${options.defaultStyle ? 'w:default="1"' : ''}>
    ${options.extraStyles ?? ''}
    ${options.styleBandSize ? `<w:tblPr><w:tblStyleRowBandSize w:val="${options.styleBandSize}"/></w:tblPr>` : ''}
    ${conditional('firstRow', '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>' + shade('F2F4F7').replace('</w:tcPr>', '<w:tcBorders><w:bottom w:val="single" w:sz="4" w:color="FF0000"/></w:tcBorders></w:tcPr>'))}
    ${conditional('wholeTable', '<w:rPr><w:sz w:val="21"/><w:b w:val="0"/></w:rPr>')}
    ${conditional('band1Horz', shade('DDEEFF'))}
    ${conditional('band2Horz', shade('FFEEDD'))}
    </w:style><w:style w:type="table" w:styleId="Plain"><w:rPr><w:b w:val="0"/><w:sz w:val="20"/></w:rPr></w:style>
    </w:styles>`)
  const cell = (text: string, body = ''): string =>
    `<w:tc><w:tcPr/><w:p><w:r>${options.direct && text === '0-0' ? '<w:rPr><w:b w:val="0"/><w:sz w:val="32"/></w:rPr>' : ''}<w:t>${text}</w:t></w:r></w:p>${body}</w:tc>`
  const nested =
    '<w:tbl><w:tblPr><w:tblStyle w:val="Plain"/></w:tblPr><w:tr>' +
    cell('nested') +
    '</w:tr></w:tbl>'
  const table = `<w:tbl><w:tblPr>${options.implicitStyle ? '' : '<w:tblStyle w:val="Report"/>'}<w:tblLook ${options.tableLook ?? ''} w:val="0020" w:firstRow="${options.firstRow === false ? '0' : '1'}" w:noHBand="${options.banding ? '0' : '1'}" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>${[0, 1, 2].map((row) => `<w:tr>${options.rowHints?.[row] ? `<w:trPr><w:cnfStyle w:val="${options.rowHints[row]}"/></w:trPr>` : ''}${[0, 1].map((col) => cell(`${row}-${col}`, options.nested && row === 0 && col === 0 ? nested : '')).join('')}</w:tr>`).join('')}</w:tbl>`
  const document = strFromU8(parts['word/document.xml'])
  parts['word/document.xml'] = strToU8(document.replace(/<w:tbl>.*<\/w:tbl>/s, table))
  return zipSync(parts)
}
