/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export async function anonymousTerminalNumericParentHeader(mode) {
  const text = (value, x, y, size = 6) =>
    `BT /F ${size} Tf ${x} ${400 - y} Td (${value.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const stream = [
    text('Table 1: Anonymous measurements.', 40, 100, 8),
    ...(mode === 'opening' ? [] : ['0.5 w 40 280 m 260 280 l S']),
    ...(mode === 'divider' ? [] : ['0.5 w 40 250 m 260 250 l S']),
    ...(mode === 'closing' ? [] : ['0.5 w 40 165 m 260 165 l S']),
    text('Common values (%)', 177, 129),
    ...(mode === 'extra-parent' ? [text('Other', 80, 129)] : []),
    text('Key', 46, 140),
    text('Stock', 80, 140),
    text('Kind', 116, 140),
    text('1uM', 157, 140),
    text('10uM', 196, 140),
    text(mode === 'unit-mismatch' ? '100mM' : '100uM', 235, 140),
    ...[0, 1, 2, 3].flatMap((row) => {
      const y = 166 + row * 19
      return [
        text(`A${row}`, 46, y),
        text(String(10 + row), 80, y),
        text(
          mode === 'prose' ? 'an overly long prose description' : row % 2 ? 'Type B' : 'Type A',
          116,
          y
        ),
        text(String(row + 1), 157, y),
        ...(mode === 'missing-value' && row === 2
          ? []
          : [text(mode === 'numeric-text' && row === 2 ? 'Bad' : String(row + 2), 196, y)]),
        text(String(row + 3), 235, y)
      ]
    })
  ].join('\n')
  const fixture = await captureAnonymousHeader(stream, [58, 178, 392, 355])
  const relative = (top, bottom) => [2, top - 178, 332, bottom - 178]
  fixture.table = {
    ...fixture.table,
    id: 'page-1-table-1',
    page: 1,
    sourceViewport: { width: 450, height: 600, scale: 1.5 },
    structure: {
      objects: [
        ...Array.from({ length: 6 }, (_, column) => ({
          label: 'table column',
          rect: [column * 55, 0, (column + 1) * 55, 177]
        })),
        { label: 'table column header', rect: relative(199, 225) },
        { label: 'table row', rect: relative(199, 225) },
        ...[225, 263.25, 291.75, 320.25].map((top, row) => ({
          label: 'table row',
          rect: relative(top, [263.25, 291.75, 320.25, 352.5][row])
        }))
      ]
    }
  }
  return fixture
}
