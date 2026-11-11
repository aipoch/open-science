import { expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { engine } from '../resources/pdfium.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'

type Kind = 'raised' | 'lowered' | 'derivative' | 'tensor' | 'micro-unit'

async function fixture(
  kind: Kind,
  aliased = true
): Promise<{
  data: Uint8Array
  source: string
  translation: string
}> {
  const pdf = await PDFDocument.create(),
    prose = await pdf.embedFont(StandardFonts.Helvetica),
    symbols = await pdf.embedFont(StandardFonts.Symbol),
    italic = await pdf.embedFont(StandardFonts.TimesRomanItalic),
    page = pdf.addPage([400, 500])
  const draw = (text: string, x: number, y = 400, size = 10, font = prose): void =>
    page.drawText(text, { x, y, size, font })
  const outer = aliased ? 'μ' : 'λ',
    raised = aliased ? 'μν' : 'ρσ'
  let source: string, translation: string
  if (kind === 'derivative') {
    draw('Operator', 40)
    draw(' = (', 90)
    draw('∂', 105, 400, 10, symbols)
    draw('x', 110.5, 398.5, 7, italic)
    draw(')', 114)
    // Lambda is taller than mu; keep both inside the same parenthesis envelope.
    draw(outer, 117.5, aliased ? 404 : 403, 7, symbols)
    draw(' is stable.', 123)
    source = `Operator = (∂x)${outer} is stable.`
    translation = `算子 = (∂x)${outer} 保持稳定。`
  } else if (kind === 'tensor') {
    draw('Tensor', 40)
    draw('∇', 90, 400, 10, symbols)
    draw(outer, 97, 398.5, 7, symbols)
    draw('T', 102, 400, 10, italic)
    draw(raised, 109, 404, 7, symbols)
    draw(' is stable.', 119)
    source = `Tensor ∇${outer}T ${raised} is stable.`
    translation = `张量 ∇${outer}T ${raised} 保持稳定。`
  } else if (kind === 'micro-unit') {
    draw('Unit', 40)
    draw('μ', 90, 400, 10, symbols)
    draw('m is stable.', 97)
    source = 'Unit μm is stable.'
    translation = '单位 μm 保持稳定。'
  } else {
    draw('Vector', 40)
    draw('η', 90, 400, 10, symbols)
    draw('μ', 96.5, kind === 'raised' ? 404 : 398.5, 7, symbols)
    draw(' is stable.', 102)
    source = 'Vector ημ is stable.'
    translation = '向量 ημ 保持稳定。'
  }
  draw('Independent neighbor 17.', 40, 350)
  return { data: await pdf.save(), source, translation }
}

async function textObjects(data: Uint8Array): Promise<
  Array<{
    text: string
    size: number
    matrix: number[]
  }>
> {
  const native = await engine(),
    document = native.open(data),
    page = native.p.FPDF_LoadPage(document.doc, 0),
    at = native.alloc(24)
  try {
    return native
      .objects(page)
      .filter((o) => o.type === 1)
      .map((o) => {
        expect(native.p.FPDFTextObj_GetFontSize(o.obj, at)).toBeTruthy()
        const size = native.m.HEAPF32[at / 4]
        expect(native.p.FPDFPageObj_GetMatrix(o.obj, at)).toBeTruthy()
        return { text: o.text, size, matrix: [...native.m.HEAPF32.slice(at / 4, at / 4 + 6)] }
      })
  } finally {
    native.free(at)
    native.p.FPDF_ClosePage(page)
    document.close()
  }
}

async function translate(input: Awaited<ReturnType<typeof fixture>>): Promise<{
  original: Awaited<ReturnType<typeof textObjects>>
  actual: Awaited<ReturnType<typeof textObjects>>
  failures: unknown[]
}> {
  const registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'greek-script-alias' })
  try {
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'greek-script-alias',
        data: input.data,
        pages: [{ width: 400, height: 500 }],
        preserveUnsupported: true,
        units: [
          {
            source: input.source,
            translation: input.translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 38 / 400, y: 84 / 500, width: 310 / 400, height: 30 / 500 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(output).toBeDefined()
    return {
      original: await textObjects(input.data),
      actual: await textObjects(output!.data),
      failures: [...output!.layoutFailures]
    }
  } finally {
    caller.release()
  }
}

it.each(['raised', 'lowered', 'derivative', 'tensor'] as const)(
  'keeps native mu aliases at their proven script level: %s',
  async (kind) => {
    const input = await fixture(kind),
      { original, actual, failures } = await translate(input)
    expect(original.some((o) => o.text.includes('µ'))).toBe(true)
    expect(failures).toEqual([])
    const normalized = (s: string): string => s.normalize('NFKC').trim(),
      body = actual.find((o) =>
        kind === 'tensor'
          ? normalized(o.text) === 'T'
          : o.text.includes(kind === 'derivative' ? '∂' : 'η')
      ),
      script = actual.find((o) => normalized(o.text) === (kind === 'tensor' ? 'μν' : 'μ'))
    expect(body).toBeDefined()
    expect(script).toBeDefined()
    expect(script!.size * Math.abs(script!.matrix[3])).toBeLessThan(
      body!.size * Math.abs(body!.matrix[3]) * 0.85
    )
    const rise = script!.matrix[5] - body!.matrix[5]
    if (kind === 'lowered') expect(rise).toBeLessThan(-0.5)
    else expect(rise).toBeGreaterThan(0.5)
    expect(actual.find((o) => o.text.includes('Independent neighbor'))).toEqual(
      original.find((o) => o.text.includes('Independent neighbor'))
    )
  }
)

it.each(['missing', 'changed', 'duplicate'] as const)(
  'retains the source when the target %s its aliased native script',
  async (kind) => {
    const input = await fixture('raised')
    input.translation = input.translation.replace(
      'ημ',
      { missing: 'η', changed: 'ην', duplicate: 'ημμ' }[kind]
    )
    const { original, actual, failures } = await translate(input)
    expect(failures).not.toEqual([])
    expect(actual).toEqual(original)
  }
)

it.each([
  { kind: 'derivative', from: 'λ', to: '' },
  { kind: 'derivative', from: 'λ', to: 'ν' },
  { kind: 'tensor', from: 'ρσ', to: '' },
  { kind: 'tensor', from: 'ρσ', to: 'ρν' }
] as const)('requires the complete native group without a mu alias: %j', async (change) => {
  const input = await fixture(change.kind, false)
  input.translation = input.translation.replace(change.from, change.to)
  const { original, actual, failures } = await translate(input)
  expect(original.some((o) => /[µμ]/u.test(o.text))).toBe(false)
  expect(failures).not.toEqual([])
  expect(actual).toEqual(original)
})

it('preserves a closed native derivative with no mu spelling difference', async () => {
  const { original, actual, failures } = await translate(await fixture('derivative', false))
  expect(failures).toEqual([])
  const sourceBody = original.find((o) => o.text === '∂')!,
    sourceScript = original.find((o) => o.text === 'λ')!,
    body = actual.find((o) => o.text === '∂')!,
    script = actual.find((o) => o.text === 'λ')!
  expect(script.size).toBe(sourceScript.size)
  expect(body.size).toBe(sourceBody.size)
  expect(script.matrix[5] - body.matrix[5]).toBeCloseTo(
    sourceScript.matrix[5] - sourceBody.matrix[5],
    3
  )
})

it('does not reconcile a different source letter as mu', async () => {
  const input = await fixture('raised')
  input.source = input.source.replace('ημ', 'ηλ')
  await expect(translate(input)).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
})

it.each(['μ', 'µ'])('does not turn a body-sized micro unit into a script: %s', async (mu) => {
  const input = await fixture('micro-unit')
  input.source = input.source.replace('μm', mu + 'm')
  input.translation = input.translation.replace('μm', mu + 'm')
  const { actual, failures } = await translate(input)
  expect(failures).toEqual([])
  const unit = actual.find((o) => o.text.normalize('NFKC').includes('μm'))
  expect(unit).toBeDefined()
  expect(actual.some((o) => o.text.normalize('NFKC').trim() === 'μ')).toBe(false)
})
