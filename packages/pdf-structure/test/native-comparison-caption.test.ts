import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
function fixture(scale = 1): ReturnType<typeof JSON.parse> {
  const line = (
    text: string,
    y: number
  ): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
    text,
    x: 50 * scale,
    y: y * scale,
    width: 400 * scale,
    height: 10 * scale,
    fontSize: 10 * scale
  })
  return {
    pageNumber: 1,
    width: 500 * scale,
    height: 700 * scale,
    invalidGraphicsBounds: 0,
    graphicsBounds: [],
    lines: [
      line('The measured errors can be assessed by comparing the values of', 100),
      line('Figure 8 with those of Figure 3. The two methods agree.', 112),
      line('The agreement remains stable throughout the measured interval.', 124),
      line('Figure 8: Comparison of the two measured responses.', 350)
    ]
  }
}
const captions = (f: ReturnType<typeof fixture>, rules: number[][] = []): string[] =>
  findCaptionCandidates([f], new Map([[1, rules]])).map((c: { lines: string[] }) => c.lines[0])
it.each([1, 1.5])(
  'keeps a tightly wrapped comparison reference in its native paragraph at scale %s',
  (scale) => {
    expect(captions(fixture(scale))).toEqual([
      'Figure 8: Comparison of the two measured responses.'
    ])
  }
)
it.each([
  'missing-predecessor',
  'other-column',
  'different-font',
  'wide-gap',
  'closed-sentence',
  'duplicate-predecessor',
  'separator',
  'graphic',
  'unknown-paint'
])('preserves the candidate without continuous paragraph proof: %s', (variant) => {
  const f = fixture()
  const rules: number[][] = []
  if (variant === 'missing-predecessor') f.lines.shift()
  if (variant === 'other-column') f.lines[0].x = -380
  if (variant === 'different-font') f.lines[0].fontSize = 8
  if (variant === 'wide-gap') f.lines[0].y = 80
  if (variant === 'closed-sentence') f.lines[0].text += '.'
  if (variant === 'duplicate-predecessor') f.lines.push({ ...f.lines[0] })
  if (variant === 'separator') rules.push([40, 111, 460, 111])
  if (variant === 'graphic')
    f.graphicsBounds.push({ kind: 'image', normalizedRect: [0.1, 0.157, 0.9, 0.16] })
  if (variant === 'unknown-paint') f.invalidGraphicsBounds = 1
  expect(captions(f, rules).some((s: string) => s.startsWith('Figure 8 with'))).toBe(true)
})
it('preserves a punctuation-delimited comparison caption below preceding prose', () => {
  const f = fixture()
  f.lines[1].text = 'Figure 8: Responses with those of the alternative model.'
  expect(captions(f).some((s: string) => s.startsWith('Figure 8: Responses'))).toBe(true)
})

it.each(['Figure 8 integrates', 'Figure 8 turns this into a measured response.'])(
  'keeps an unpunctuated computational figure subject in prose: %s',
  (text) => {
    const f = fixture()
    f.lines[1].text = text
    expect(captions(f)).toEqual(['Figure 8: Comparison of the two measured responses.'])
  }
)
it.each(['Figure 8: Integrates the measurements.', 'Figure 8 Turns in the measured path.'])(
  'retains a computational title without finite-subject evidence: %s',
  (text) => expect(captionKind(text)).toBe('figure')
)
it('keeps coordinated figure references in the native paragraph introducing them', () => {
  const f = fixture()
  f.lines[0].text = 'The measured responses are represented by symbols in'
  f.lines[1].text = 'Fig. 2 and Fig. 3, where applicable, with additional markers'
  expect(captions(f)).toEqual(['Figure 8: Comparison of the two measured responses.'])
})
it.each(['missing-predecessor', 'other-column', 'closed-sentence', 'separator', 'unknown-paint'])(
  'retains coordinated candidates without native continuation proof: %s',
  (variant) => {
    const f = fixture()
    f.lines[0].text = 'The measured responses are represented by symbols in'
    f.lines[1].text = 'Fig. 2 and Fig. 3, where applicable, with additional markers'
    const rules: number[][] = []
    if (variant === 'other-column') f.lines[0].x = -380
    if (variant === 'closed-sentence') f.lines[0].text += '.'
    if (variant === 'separator') rules.push([40, 111, 460, 111])
    if (variant === 'unknown-paint') f.invalidGraphicsBounds = 1
    if (variant === 'missing-predecessor') f.lines.shift()
    expect(captions(f, rules).some((text) => text.startsWith('Fig. 2 and'))).toBe(true)
  }
)

it.each([
  'Figure 8 quantifies this difference between the measured responses.',
  'Figure 8 characterizes the distribution of measured values.',
  'Figure 8 normalizes our observations before comparison.',
  'Figure 8(a) also categorises these observations by their labels.'
])('keeps an unpunctuated finite figure subject in prose: %s', (text) => {
  const f = fixture()
  f.lines[0].text = 'The measured responses differ over the following interval.'
  f.lines[1].text = text
  expect(captions(f)).toEqual(['Figure 8: Comparison of the two measured responses.'])
})

it.each([
  'Figure 8: Quantifies this difference between measured responses.',
  'Figure 8. Characterizes the distribution of measured values.',
  'Figure 8 Quantification of the difference between responses.',
  'Figure 8 Prizes for the best responses.',
  'Figure 8 Enterprises in the sample.',
  'Figure 8 normalizes observations.'
])('preserves a title without the complete finite-subject grammar: %s', (text) => {
  const f = fixture()
  f.lines = [{ ...f.lines[3], text }]
  expect(captions(f)).toEqual([text])
})

it.each([
  'Fig. 2 (input response), Fig. 3 (output response), and Fig. 4 (residual error) show the measured values.',
  'Figure 2 (upper response) and Figure 3 (lower response) compare the measured values.',
  'Fig. 2 (first case), Fig. 3 (second case) and Fig. 4 (third case) illustrate the differences.'
])('rejects a coordinated finite figure subject with descriptive qualifiers: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})
it('rejects the same coordinated subject when the finite clause wraps onto another native row', () => {
  const f = fixture()
  f.lines = [
    { ...f.lines[0], text: 'Fig. 2 (input response), Fig. 3 (output response), and Fig. 4' },
    {
      ...f.lines[1],
      text: '(residual error) show the measured responses under the same conditions.'
    },
    { ...f.lines[2], text: 'The independent measurements remain consistent.' },
    f.lines[3]
  ]
  expect(captions(f)).toEqual(['Figure 8: Comparison of the two measured responses.'])
})
it.each([
  'Fig. 2: Input response, Fig. 3: output response, and Fig. 4: residual error.',
  'Figure 2. Input responses. Figure 3 shows the comparison.',
  'Figure 2 (input response) Measurements for all cases.',
  'Figure 2 (input response) and Figure 3 (output response): measured values.',
  'Figure 2 (input response) and Figure 3 (output response) comparison of values.'
])('retains a caption without a coordinated finite reference clause: %s', (text) => {
  expect(captionKind(text)).toBe('figure')
})

function wrappedTerminalReference(): ReturnType<typeof fixture> {
  const f = fixture()
  f.lines = [
    { ...f.lines[0], text: 'The complete measurement captures changes in the response over time' },
    { ...f.lines[1], text: 'and distinguishes the independent cases through the measured values' },
    { ...f.lines[2], text: 'Figure 2. This comparison preserves the direction of each response' },
    {
      ...f.lines[2],
      y: 136,
      text: 'and retains the original observations throughout the same interval.'
    }
  ]
  return f
}
it('keeps a sentence-final figure reference in its uninterrupted native prose paragraph', () => {
  expect(captions(wrappedTerminalReference())).toEqual([])
})

// Native superscripts make two full prose line boxes taller than their leading.
// Preserve the captured five-row topology, using unrelated anonymous prose.
function overlappingTerminalReference(): ReturnType<typeof fixture> {
  const f = wrappedTerminalReference()
  f.lines.forEach((line: ReturnType<typeof JSON.parse>, n: number) => {
    line.y = 110.9 + n * 10.9
  })
  f.lines[0].height = 11.5
  f.lines.unshift({
    ...f.lines[0],
    text: 'The preceding measurement describes all responses in the same interval',
    x: 49.7,
    y: 100,
    width: 400.3,
    height: 11.5
  })
  return f
}
it('keeps the terminal reference when the unique upstream prose font box overlaps the next row', () => {
  expect(captions(overlappingTerminalReference())).toEqual([])
})
it.each(['other-column', 'different-font', 'duplicate', 'non-adjacent', 'long-ink'])(
  'retains the caption when the overlapping upstream row is not uniquely continuous: %s',
  (kind) => {
    const f = overlappingTerminalReference()
    if (kind === 'other-column') f.lines[0].x -= 30
    if (kind === 'different-font') f.lines[0].fontSize = 8
    if (kind === 'duplicate') f.lines.push({ ...f.lines[0] })
    if (kind === 'non-adjacent') f.lines[0].y -= 2
    if (kind === 'long-ink') f.lines[0].height = 25
    if (kind === 'non-adjacent') f.lines[0].height += 2
    expect(captions(f).some((text: string) => text.startsWith('Figure 2'))).toBe(true)
  }
)
it.each([
  'missing-row',
  'closed-sentence',
  'other-column',
  'different-font',
  'wide-gap',
  'duplicate',
  'graphic',
  'unknown-paint',
  'separator',
  'colon'
])('does not infer a sentence-final reference without paragraph proof: %s', (kind) => {
  const f = wrappedTerminalReference(),
    rules: number[][] = []
  if (kind === 'missing-row') f.lines.shift()
  if (kind === 'closed-sentence') f.lines[1].text += '.'
  if (kind === 'other-column') f.lines[1].x += 420
  if (kind === 'different-font') f.lines[1].fontSize = 8
  if (kind === 'wide-gap') f.lines[1].y -= 3
  if (kind === 'duplicate') f.lines.push({ ...f.lines[1] })
  if (kind === 'graphic')
    f.graphicsBounds.push({ kind: 'image', normalizedRect: [0.1, 0.1, 0.5, 0.15] })
  if (kind === 'unknown-paint') f.invalidGraphicsBounds = 1
  if (kind === 'separator') rules.push([50, 123, 450, 123])
  if (kind === 'colon') f.lines[2].text = f.lines[2].text.replace('2.', '2:')
  expect(captions(f, rules).some((text: string) => text.startsWith('Figure 2'))).toBe(true)
})
