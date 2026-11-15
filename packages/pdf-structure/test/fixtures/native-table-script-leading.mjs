/* eslint-disable @typescript-eslint/explicit-function-return-type */
export function nativeTableScriptLeading(fault = '') {
  const line = (text, x, y, width, fontSize = 10) => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [],
    lines: [
      line('Table 1: Generic measurements under the same reference conditions.', 50, 100, 450),
      line('Score and error (U', 50, 114, 80),
      line('2', 130, 111, 4, 6),
      line(') compare the same methods in shared units;', 134, 114, 366),
      line(
        'all variants retain the original protocol and the complete measured record,',
        50,
        128,
        450
      ),
      line('and report the final independent measurements.', 50, 142, 220)
    ]
  }
  const rules = [
    [140, 168, 460, 168],
    [140, 195, 460, 195],
    [140, 250, 460, 250]
  ]
  if (fault === 'figure') page.lines[0].text = page.lines[0].text.replace('Table', 'Figure')
  if (fault === 'narrative') page.lines[0].text = 'Table 1 shows the same reference measurements.'
  if (fault === 'wide-gap') {
    page.lines[4].y = 150
    page.lines[5].y = 164
  }
  if (fault === 'no-dominant-metrics') {
    page.lines[1].height = 13
    page.lines[3].height = 13
  }
  if (fault === 'same-size-script') page.lines[2].fontSize = 10
  if (fault === 'intervening-rule') rules.push([50, 126, 500, 126])
  if (fault === 'ordinary') page.lines.splice(2, 1)
  return { page, rules, tables: [{ rect: [140, 168, 460, 250] }] }
}
