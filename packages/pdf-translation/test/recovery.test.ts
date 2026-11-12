import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { expect, it } from 'vitest'
import { pdfTranslationCheckpointSchema, type PdfTranslationCheckpoint } from '../src/contracts.js'
import { createHash } from 'node:crypto'
import {
  reconcilePdfTranslationCheckpoint,
  pdfTranslationSourceIndices,
  nextPdfTranslationSourceIndex,
  normalizePdfTranslationText,
  normalizePdfTranslationScriptMarkup,
  pdfTranslationHasCommentary,
  pdfTranslationIntroducesReplacementCharacters,
  pdfTranslationIntroducesMathMarkup,
  pdfTranslationCopiesNeighborFormula,
  pdfTranslationCopiesEnglishProse,
  pdfTranslationConfusesScientificLabel,
  pdfTranslationAddsNumericLiterals,
  pdfTranslationChangesNumericSigns,
  pdfTranslationMissingCitationIdentities,
  pdfTranslationDropsStandaloneProperName,
  pdfTranslationReordersInlineMath,
  pdfTranslationMissingMathIdentifiers
} from '../src/recovery.js'

const saved: PdfTranslationCheckpoint = {
  version: 1,
  key: '11111111-1111-4111-8111-111111111111',
  revision: 4,
  sourceId: 'v',
  checksum: 'a'.repeat(64),
  fingerprint: 'fp',
  language: 'Chinese',
  glossary: [],
  targetKey: 'b'.repeat(64),
  model: { frameworkId: 'direct-api', mode: 'api' },
  sources: ['Title', 'Old paragraph', 'Repeated', 'Unchanged', 'Repeated'],
  translations: ['标题', '旧段落', '重复', '不变'],
  translatedSourceIndices: [0, 1, 2, 3]
}

it.each([false, true])(
  'restores accepted Unicode targets using their saved mode: %s',
  (contentFirst) => {
    const sources = ['The scale is 10⁻².', 'A. B. Author, Journal 8, 24 (2020)'],
      translations = ['尺度为10⁻²。', 'A. B. Author，Journal 8，24 (2020)'],
      units = sources.map((source, index) => ({
        id: `unit-${index}`,
        source,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1 + index * 0.2, width: 0.8, height: 0.1 },
            items: [{ index, text: source }]
          }
        ]
      })),
      hash = (text: string): string => createHash('sha256').update(text).digest('hex'),
      checkpoint: PdfTranslationCheckpoint = {
        ...saved,
        contentFirst,
        sources,
        translations,
        translatedSourceIndices: [0, 1],
        layoutSnapshot: {
          version: 1,
          parserVersion: 'pdfjs-paragraph-layout-6',
          fingerprint: 'fp',
          pages: [{ width: 100, height: 100 }],
          units,
          coverage: {
            pageCount: 1,
            textItemCount: 2,
            includedItemCount: 2,
            excludedItemCount: 0,
            pagesWithoutText: [],
            exclusions: [],
            warnings: []
          }
        },
        layoutReports: sources.map((text, sourceIndex) => ({
          sourceIndex,
          sourceHash: hash(text),
          translationHash: hash(translations[sourceIndex]),
          generatedAt: 1
        }))
      },
      before = structuredClone(checkpoint),
      expected = contentFirst ? translations : ['尺度为10^(-2)。', sources[1]],
      reconciled = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', sources)!
    expect(reconciled.translations).toEqual(expected)
    expect(reconciled.translatedSourceIndices).toEqual([0, 1])
    expect(reconciled.layoutSnapshot).toBe(checkpoint.layoutSnapshot)
    expect(reconciled.layoutReports).toEqual(contentFirst ? checkpoint.layoutReports : undefined)
    if (contentFirst) expect(reconciled).toBe(checkpoint)
    expect(checkpoint).toEqual(before)
    expect(reconcilePdfTranslationCheckpoint(reconciled, 'fp', sources)).toBe(reconciled)
    expect(reconcilePdfTranslationCheckpoint(checkpoint, 'other', sources)).toBeUndefined()
    expect(
      reconcilePdfTranslationCheckpoint(checkpoint, 'fp', ['Changed source', sources[1]])
    ).toBeUndefined()
  }
)

it('trims content-first targets while retaining recovery validation', () => {
  const source = 'The scale is 10⁻².',
    checkpoint = {
      ...saved,
      contentFirst: true,
      sources: [source],
      translatedSourceIndices: [0],
      translations: ['  尺度为10⁻²。\n']
    },
    before = structuredClone(checkpoint),
    restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])!
  expect(restored.translations).toEqual(['尺度为10⁻²。'])
  expect(reconcilePdfTranslationCheckpoint(restored, 'fp', [source])).toBe(restored)
  expect(
    reconcilePdfTranslationCheckpoint(
      { ...checkpoint, sources: ['Dose was 5 mg.'], translations: ['剂量为5千克。'] },
      'fp',
      ['Dose was 5 mg.']
    )?.translations
  ).toEqual([])
  expect(checkpoint).toEqual(before)
})

it.each([[1, 1], [3, 1], [0, 9], [-1, 1], [1]])(
  'rejects invalid translated source indices %j',
  (...indices) => {
    expect(
      pdfTranslationCheckpointSchema.safeParse({
        ...saved,
        version: 1,
        translations: ['甲', '乙'],
        translatedSourceIndices: indices
      }).success
    ).toBe(false)
  }
)

it.each(
  [
    'checkpoint-layout-change-and-sparse-recovery.jsonl',
    'unchanged-table-label-split-recovery.jsonl',
    'local-anchor-reorder-recovery.jsonl',
    'repeated-model-identity-recovery.jsonl'
  ].flatMap((file) =>
    readPdfTranslationCases<{
      name: string
      sources: string[]
      translations: string[]
      current: string[]
      indices?: number[]
      fingerprint?: string
      identity?: boolean
      expected: { indices: number[]; translations: string[]; next: number } | null
    }>(file)
  )
)('$name', (record) => {
  const checkpoint: PdfTranslationCheckpoint = {
    ...saved,
    version: 1,
    sources: record.sources,
    translations: record.translations,
    translatedSourceIndices: record.indices ?? record.translations.map((_, index) => index)
  }
  const before = structuredClone(checkpoint)
  const restored = reconcilePdfTranslationCheckpoint(
    checkpoint,
    record.fingerprint ?? 'fp',
    record.current
  )
  expect(checkpoint).toEqual(before)
  if (!record.expected) {
    expect(restored).toBeUndefined()
    return
  }
  expect(restored).toBeDefined()
  if (record.identity) expect(restored).toBe(checkpoint)
  expect(pdfTranslationSourceIndices(restored!)).toEqual(record.expected.indices)
  expect(restored!.translations).toEqual(record.expected.translations)
  expect(restored!.sources).toEqual(record.current)
  expect(nextPdfTranslationSourceIndex(restored!)).toBe(record.expected.next)
  expect(pdfTranslationCheckpointSchema.parse(restored)).toEqual(restored)
  expect(reconcilePdfTranslationCheckpoint(restored!, 'fp', record.current)).toBe(restored)
})

it('strips invisible format controls before checkpoint reconciliation', () => {
  expect(normalizePdfTranslationText('formula\u000f source', '公式\u2060文本')).toBe('公式文本')
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    expected: string
    rejected?: boolean
  }>('source-proven-script-markup.jsonl').concat(
    readPdfTranslationCases('redundant-bilingual-scientific-labels.jsonl'),
    readPdfTranslationCases('source-proven-supplementary-appendix-label.jsonl'),
    readPdfTranslationCases<{
      name: string
      source: string
      translation: string
      expected: string
    }>('cited-original-name-display.jsonl').concat(
      readPdfTranslationCases<{
        name: string
        source: string
        translation: string
        expected: string
        owner?: boolean
      }>('source-proven-numeric-citation-markers.jsonl')
    )
  )
)('$name', ({ source, translation, expected, rejected }) => {
  expect(normalizePdfTranslationText(source, translation)).toBe(expected)
  for (const current of [[source], [source, 'New paragraph']]) {
    const checkpoint: PdfTranslationCheckpoint = {
      ...saved,
      version: 1,
      sources: ['Excluded formula', source],
      translations: [translation],
      translatedSourceIndices: [1]
    }
    const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', current)
    expect(restored?.translations ?? []).toEqual(rejected ? [] : [expected])
    expect(restored?.translatedSourceIndices ?? []).toEqual(rejected ? [] : [0])
    expect(checkpoint.translations).toEqual([translation])
  }
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [translation]
  }
  expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])?.translations).toEqual(
    rejected ? [] : [expected]
  )
})

it.each(
  readPdfTranslationCases<{ name: string; source: string; output: string; accepted: boolean }>(
    'unwrapped-translation-commentary.jsonl'
  )
)('reopens only contaminated saved output: $name', ({ source, output, accepted }) => {
  expect(pdfTranslationHasCommentary(source, output)).toBe(!accepted)
  const checkpoint = {
    ...saved,
    sources: ['Heading', source, 'Conclusion'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['标题', output, '结论']
  }
  const before = structuredClone(checkpoint)
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)!
  expect(pdfTranslationSourceIndices(restored)).toEqual(accepted ? [0, 1, 2] : [0, 2])
  expect(restored.translations).toEqual(accepted ? checkpoint.translations : ['标题', '结论'])
  expect(nextPdfTranslationSourceIndex(restored)).toBe(accepted ? 3 : 1)
  expect(checkpoint).toEqual(before)
  expect(reconcilePdfTranslationCheckpoint(restored, 'fp', checkpoint.sources)).toBe(restored)
  expect(pdfTranslationCheckpointSchema.safeParse(restored).success).toBe(true)
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    text: string
    language: string
    accepted: boolean
  }>('untranslated-body-and-protected-labels.jsonl').concat(
    readPdfTranslationCases('untranslated-scientific-table-labels.jsonl'),
    readPdfTranslationCases('translated-heading-copied-body.jsonl'),
    readPdfTranslationCases('clinical-section-headings-not-proper-names.jsonl'),
    readPdfTranslationCases('scientific-statement-title-not-proper-name.jsonl'),
    readPdfTranslationCases('training-and-statistical-column-labels.jsonl'),
    readPdfTranslationCases('accented-names-not-inline-math.jsonl'),
    readPdfTranslationCases('scientific-axis-label-identities.jsonl'),
    readPdfTranslationCases('footnote-marker-caption-confusion.jsonl')
  )
)('reuses only translated saved prose: $name', ({ source, text, language, accepted }) => {
  expect(
    pdfTranslationCopiesEnglishProse(source, text, language) ||
      pdfTranslationConfusesScientificLabel(source, text)
  ).toBe(!accepted)
  const checkpoint = {
    ...saved,
    language,
    sources: ['Heading', source, 'Conclusion'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['标题', text, '结论']
  }
  const recovered = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)
  expect(recovered?.translations).toEqual(
    accepted ? ['标题', normalizePdfTranslationText(source, text), '结论'] : ['标题', '结论']
  )
  expect(pdfTranslationSourceIndices(recovered!)).toEqual(accepted ? [0, 1, 2] : [0, 2])
  expect(checkpoint.translations).toEqual(['标题', text, '结论'])
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    rejected: boolean
  }>('unexpected-numeric-literals.jsonl')
)('$name', ({ source, translation, rejected }) => {
  expect(pdfTranslationAddsNumericLiterals(source, translation)).toBe(rejected)
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [translation]
  }
  expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])?.translations).toEqual(
    rejected ? [] : [translation]
  )
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    rejected: boolean
  }>('caption-number-reused-as-quantity.jsonl')
)('$name', ({ source, translation, rejected }) => {
  expect(pdfTranslationAddsNumericLiterals(source, translation)).toBe(rejected)
  const checkpoint = {
    ...saved,
    sources: ['Heading', source, 'Conclusion'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['标题', translation, '结论']
  }
  const recovered = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)
  expect(pdfTranslationSourceIndices(recovered!)).toEqual(rejected ? [0, 2] : [0, 1, 2])
  expect(checkpoint.translations).toEqual(['标题', translation, '结论'])
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    missing: string[]
  }>('missing-citation-identities.jsonl').concat(
    readPdfTranslationCases('statistical-header-footnote-identities.jsonl')
  )
)('$name', ({ source, translation, missing }) => {
  expect(pdfTranslationMissingCitationIdentities(source, translation)).toEqual(missing)
})

it('retries only the saved statistical header with a missing footnote', () => {
  const source = 'Mean Difference (90% CI)c'
  const checkpoint = {
    ...saved,
    sources: ['Heading', source, 'Conclusion'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['标题', '平均差值（90% 置信区间）', '结论']
  }
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)
  expect(restored?.translations).toEqual(['标题', '结论'])
  expect(restored?.translatedSourceIndices).toEqual([0, 2])
})

it('drops a saved fragment that imported digits from a neighboring formula', () => {
  const source = 'AdaGrad corresponds to a limiting version of Adam.'
  const checkpoint = {
    ...saved,
    version: 1 as const,
    sources: [source],
    translations: ['AdaGrad 对应 Adam 的 β1 = 0 极限版本。'],
    translatedSourceIndices: [0]
  }
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])
  expect(restored?.translations).toEqual([])
  expect(restored?.translatedSourceIndices).toEqual([])
})

it('drops a saved fragment that lost a linked author identity', () => {
  const source = 'The method was validated (Han et al., 2016a).'
  const checkpoint = {
    ...saved,
    version: 1 as const,
    sources: [source],
    translations: ['该方法已得到验证（2016a）。'],
    translatedSourceIndices: [0]
  }
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])
  expect(restored?.translations).toEqual([])
  expect(restored?.translatedSourceIndices).toEqual([])
})

it.each([
  ['Token Classification Institute', '词元分类研究所'],
  ['Warmup Steps Foundation', '预热步数基金会'],
  ['Weight Decay Institute', '权重衰减研究所'],
  ['Transformer Layer Institute', 'Transformer 层研究所'],
  ['ReSeARCH Labs', '研究实验室'],
  ['OpenAI Model', '开放模型']
])('keeps unknown containing names outside the ordinary-label vocabulary: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(true)
})

it.each([
  ['Related Work', '相关工作'],
  ['Input Sequence', '输入序列'],
  ['Atom Attention Encoder', '原子注意力编码器'],
  ['Physical Validity Constraints', '物理有效性约束'],
  ['Date Range', '日期范围'],
  ['Chl Range', 'Chl 范围'],
  ['COMMUTATIVE ALGEBRA', '交换代数']
])('translates a complete ordinary scientific label: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, source, 'Chinese')).toBe(true)
})

it.each([
  ['Related Work Institute', '相关工作研究所'],
  ['Input Sequence NimbusNet', '输入序列'],
  ['Physical Validity Foundation', '物理有效性基金会'],
  ['Date Range Research', '日期范围研究']
])('keeps names containing ordinary label words protected: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(true)
})

it('rejects a translated standalone proper name', () => {
  expect(pdfTranslationDropsStandaloneProperName('Hugging Face', '抱抱脸')).toBe(true)
  expect(pdfTranslationDropsStandaloneProperName('Hugging Face', 'Hugging Face')).toBe(false)
  expect(
    pdfTranslationDropsStandaloneProperName('MNIST Logistic Regression', 'MNIST 逻辑回归')
  ).toBe(false)
  expect(pdfTranslationDropsStandaloneProperName('Abstract', '摘要')).toBe(false)
  expect(pdfTranslationDropsStandaloneProperName('Open Access', '开放获取')).toBe(false)
  expect(pdfTranslationDropsStandaloneProperName('Unit Type', '单元类型')).toBe(false)
  expect(pdfTranslationDropsStandaloneProperName('Unit Type Institute', '单元类型研究所')).toBe(
    true
  )
  expect(pdfTranslationDropsStandaloneProperName('Unclear Institute', '不明确研究所')).toBe(true)
  expect(
    pdfTranslationDropsStandaloneProperName('Physical Symptoms Institute', '身体症状研究所')
  ).toBe(true)
  expect(
    pdfTranslationDropsStandaloneProperName('Limited Context Institute', '有限上下文研究所')
  ).toBe(true)
  expect(pdfTranslationDropsStandaloneProperName('High Risk Research', '高风险研究')).toBe(true)
  expect(pdfTranslationDropsStandaloneProperName('Open Access Institute', '开放获取研究所')).toBe(
    true
  )
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    negativeTranslation?: string
  }>('scientific-role-heading-labels.jsonl')
)('$name', ({ source, translation, negativeTranslation }) => {
  expect(pdfTranslationDropsStandaloneProperName(source, translation)).toBe(false)
  expect(
    reconcilePdfTranslationCheckpoint(
      { ...saved, sources: [source], translatedSourceIndices: [0], translations: [translation] },
      'fp',
      [source]
    )?.translations
  ).toEqual([translation])
  if (negativeTranslation)
    expect(pdfTranslationDropsStandaloneProperName(source, negativeTranslation)).toBe(true)
})

it.each([
  ['Denoising Diffusion Probabilistic Models', '去噪扩散概率模型', true],
  ['Denoising Diffusion Models', '去噪扩散模型', true],
  ['Broader Impact', '更广泛的影响', true],
  ['Denoising Diffusion Institute', '去噪扩散研究所', false],
  ['Broader Impact Foundation', '广泛影响基金会', false],
  ['Denoising Diffusion NimbusNet', '去噪扩散模型', false]
])(
  'admits complete scientific noun labels without renaming organizations: %s',
  (source, text, accepted) => {
    expect(pdfTranslationDropsStandaloneProperName(source, text)).toBe(!accepted)
    const checkpoint = {
      ...saved,
      sources: [source],
      translatedSourceIndices: [0],
      translations: [text]
    }
    expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])?.translations).toEqual(
      accepted ? [text] : []
    )
  }
)

it.each([
  ['Question Answer Institute', '问答研究所'],
  ['Fine Tuning Foundation', '微调基金会'],
  ['Segment Embeddings Institute', '片段嵌入研究所']
])('rejects a saved renamed organization containing scientific labels: %s', (source, text) => {
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [text]
  }
  expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])?.translations).toEqual([])
})

it.each([
  ['Acupuncture Massage Mindfulness', '针灸 按摩 正念', false],
  ['Acupuncture\nMassage\nMindfulness', '针灸 按摩 正念', false],
  ['Yoga Reflexology', '瑜伽 足部反射疗法', false],
  ['Mindfulness Institute', '正念研究所', true],
  ['Acupuncture Massage Research', '针灸按摩研究', true],
  ['Yoga Foundation', '瑜伽基金会', true],
  ['Example Massage', '示例按摩', true],
  ['YogaNet', '瑜伽网络', true]
])('distinguishes a complete treatment list from a name: %s', (source, text, renamed) => {
  expect(pdfTranslationDropsStandaloneProperName(source, text)).toBe(renamed)
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [text]
  }
  expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])?.translations).toEqual(
    renamed ? [] : [text]
  )
})

it.each([
  ['无 NSP', true],
  ['未使用 NSP', true],
  ['No NSP', false],
  ['无', false],
  ['无 MLM', false],
  ['无 NSPA', false]
])('preserves the identifier in a saved ablation label: %s', (text, accepted) => {
  const source = 'No NSP'
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [text]
  }
  expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [source])?.translations).toEqual(
    accepted ? [text] : []
  )
})

it('rejects translated prose that reorders inline math markers', () => {
  expect(
    pdfTranslationReordersInlineMath('First use x̂y and then use q̂x.', '先使用 q̂x，然后使用 x̂y。')
  ).toBe(true)

  const source = 'The normalized activations x̂ are crucial, and if we neglect ǫ.'
  expect(
    pdfTranslationReordersInlineMath(
      source,
      '归一化的激活值 x̂ 至关重要，并且任何 x̂ 都会在忽略 ǫ 的情况下处理。'
    )
  ).toBe(false)
  expect(
    pdfTranslationReordersInlineMath(
      'The normalized activations x̂ are crucial, any x̂ is stable, and if we neglect ǫ.',
      '归一化的激活值 x̂ 至关重要，并且在忽略 ǫ 的情况下，任何 x̂ 都是稳定的。'
    )
  ).toBe(true)
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    neighbors: string[]
    rejected: boolean
  }>('neighbor-formula-leakage.jsonl')
)('$name', ({ source, translation, neighbors, rejected }) => {
  expect(pdfTranslationCopiesNeighborFormula(source, translation, neighbors)).toBe(rejected)
  const checkpoint = {
    ...saved,
    sources: [source, ...neighbors],
    translatedSourceIndices: [0],
    translations: [translation]
  }
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.translations
  ).toEqual(rejected ? [] : [translation])
})

it.each(
  readPdfTranslationCases<{ name: string; source: string; translation: string; reject: boolean }>(
    'marked-author-byline-identity.jsonl'
  )
)('$name', ({ source, translation, reject }) => {
  expect(pdfTranslationDropsStandaloneProperName(source, translation)).toBe(reject)
  const checkpoint = {
    ...saved,
    sources: ['Title', source],
    translatedSourceIndices: [0, 1],
    translations: ['标题', translation]
  }
  const result = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)!
  expect(result.translations).toEqual(reject ? ['标题'] : checkpoint.translations)
  expect(pdfTranslationSourceIndices(result)).toEqual(reject ? [0] : [0, 1])
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    reject: boolean
    expected?: string
  }>('unrequested-latex-math-output.jsonl')
)('$name', ({ source, translation, reject, expected }) => {
  expect(
    pdfTranslationIntroducesMathMarkup(source, normalizePdfTranslationText(source, translation))
  ).toBe(reject)
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [translation]
  }
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.translations
  ).toEqual(reject ? [] : [expected ?? translation])
})

it.each(
  readPdfTranslationCases<{ name: string; source: string; translation: string; missing: string[] }>(
    'complete-greek-script-identifiers.jsonl'
  )
)('$name', ({ source, translation, missing }) => {
  expect(pdfTranslationMissingMathIdentifiers(source, translation)).toEqual(missing)
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: [translation]
  }
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.translations
  ).toEqual(missing.length ? [] : [translation])
})

it.each(
  readPdfTranslationCases<{ name: string; source: string; translation: string; rejected: boolean }>(
    'numeric-sign-preservation.jsonl'
  )
)('$name', ({ source, translation, rejected }) => {
  expect(pdfTranslationChangesNumericSigns(source, translation)).toBe(rejected)
})

it('removes saved translations with changed numeric signs while retaining valid neighbors', () => {
  const checkpoint = {
    ...saved,
    sources: ['Heading', 'The change was −23.94.', 'Conclusion'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['标题', '变化为23.94。', '结论']
  }
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)
  expect(restored?.translations).toEqual(['标题', '结论'])
  expect(pdfTranslationSourceIndices(restored!)).toEqual([0, 2])
  expect(checkpoint.translations).toEqual(['标题', '变化为23.94。', '结论'])
})

it('keeps skipped source indices separate from translations and invalidates them after extraction changes', () => {
  const checkpoint: PdfTranslationCheckpoint = {
    ...saved,
    version: 1,
    sources: ['Title', 'Paragraph', 'Last'],
    translations: ['标题', '末尾'],
    translatedSourceIndices: [0, 2],
    failedSourceIndices: [1]
  }
  expect(pdfTranslationCheckpointSchema.safeParse(checkpoint).success).toBe(true)
  expect(nextPdfTranslationSourceIndex(checkpoint)).toBe(3)
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.failedSourceIndices
  ).toEqual([1])
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', ['Title', 'New paragraph', 'Last'])
      ?.failedSourceIndices
  ).toBeUndefined()
  for (const failedSourceIndices of [[0], [1, 1], [3], [-1]])
    expect(
      pdfTranslationCheckpointSchema.safeParse({ ...checkpoint, failedSourceIndices }).success
    ).toBe(false)
})

it('preserves a named model beside an ordinary scientific qualifier', () => {
  const source = 'Shallow NimbusNet'
  expect(pdfTranslationDropsStandaloneProperName(source, '浅层 NimbusNet')).toBe(false)
  expect(pdfTranslationDropsStandaloneProperName(source, '浅层模型')).toBe(true)
  expect(pdfTranslationDropsStandaloneProperName('Conv NimbusNet', '卷积 NimbusNet')).toBe(false)
  expect(
    pdfTranslationDropsStandaloneProperName('Object Detection Institute', '目标检测研究所')
  ).toBe(true)
  const checkpoint = {
    ...saved,
    sources: [source],
    translatedSourceIndices: [0],
    translations: ['浅层模型']
  }
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.translations
  ).toEqual([])
})

it('preserves the metric acronym and containing name in a clinical table label', () => {
  expect(pdfTranslationDropsStandaloneProperName('Intraoperative HR', '术中 HR')).toBe(false)
  expect(pdfTranslationConfusesScientificLabel('Intraoperative HR', '术中 BP')).toBe(true)
  expect(pdfTranslationConfusesScientificLabel('Intraoperative HR', '术中')).toBe(true)
  expect(
    pdfTranslationDropsStandaloneProperName('Intraoperative HR Institute', '术中心率研究所')
  ).toBe(true)
})

it.each([
  ['EDITED BY', '编辑'],
  ['REVIEWED BY', '审稿'],
  ['Additional Information', '补充信息'],
  ['ADDITIONAL INFORMATION', '补充信息'],
  ['Sleep Score', '睡眠评分'],
  ['AE Class', '不良事件类别'],
  ['Aim Trainer Score', 'Aim Trainer 评分'],
  ['Aim Trainer SCORE', 'Aim Trainer 评分'],
  ['AIM TRAINER SCORE', 'AIM TRAINER 评分'],
  ['Aim trainer score', 'Aim trainer 评分']
])('translates a complete publication or clinical score label: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, target, 'Chinese')).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, source, 'Chinese')).toBe(true)
  const restored = reconcilePdfTranslationCheckpoint(
    { ...saved, sources: [source], translatedSourceIndices: [0], translations: [target] },
    'fp',
    [source]
  )
  expect(restored?.translations).toEqual([target])
})

it.each([
  ['Aim Trainer Score', '瞄准训练器评分'],
  ['Aim Trainer Score', 'Other Trainer 评分'],
  ['Aim Trainer SCORE', '瞄准训练器评分'],
  ['AIM TRAINER SCORE', '瞄准训练器评分'],
  ['Aim trainer score', '瞄准训练器评分'],
  ['AIM TRAINER SCORE', 'Aim Trainer 评分'],
  ['Sleep Institute', '睡眠研究所'],
  ['AE Foundation', '不良事件基金会'],
  ['Sleep Score Institute', '睡眠评分研究所'],
  ['Reviewed By Foundation', '审稿基金会'],
  ['Additional Information Institute', '补充信息研究所'],
  ['Additional Information Foundation', '补充信息基金会']
])('keeps unknown names and the named test identity: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(true)
})

it('keeps failure diagnostics only while their extraction identity is unchanged', () => {
  const checkpoint: PdfTranslationCheckpoint = {
    ...saved,
    failedSourceIndices: [4],
    failures: [{ sourceIndex: 4, reasonCode: 'incomplete-output', pageNumbers: [3], attempts: 2 }]
  }
  expect(reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.failures).toEqual(
    checkpoint.failures
  )
  const changed = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', [
    'New section',
    ...checkpoint.sources
  ])!
  expect(changed.failures).toBeUndefined()
  expect(changed.failedSourceIndices).toBeUndefined()
  expect(pdfTranslationCheckpointSchema.safeParse(changed).success).toBe(true)
})

it('does not attach old layout diagnostics to a reordered extraction', () => {
  const checkpoint: PdfTranslationCheckpoint = {
    ...saved,
    layoutReports: [
      {
        sourceIndex: 0,
        sourceHash: 'a'.repeat(64),
        translationHash: 'b'.repeat(64),
        generatedAt: 1,
        failure: { code: 'overflow', phase: 'planning', pageNumbers: [1], fragmentCount: 1 }
      }
    ]
  }
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)?.layoutReports
  ).toEqual(checkpoint.layoutReports)
  expect(
    reconcilePdfTranslationCheckpoint(checkpoint, 'fp', ['New section', ...checkpoint.sources])
      ?.layoutReports
  ).toBeUndefined()
})

it('rechecks numeric unit bindings on recovery without discarding valid neighbors', () => {
  const checkpoint = {
    ...saved,
    sources: ['Heading', 'Accuracy increased from 82 percent to 91 percent.', 'Dose was 5 mg.'],
    translatedSourceIndices: [0, 1, 2],
    translations: ['标题', '准确率从82个百分点提升至91个百分点。', '剂量为5毫克。']
  }
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)
  expect(restored?.translations).toEqual(['标题', '剂量为5毫克。'])
  expect(pdfTranslationSourceIndices(restored!)).toEqual([0, 2])
  expect(checkpoint.translations).toHaveLength(3)
})

it('handles long malformed script, footnote and contact tokens without rescanning suffixes', () => {
  for (const prefix of ['0'.repeat(40_000), 'A'.repeat(40_000)]) {
    expect(normalizePdfTranslationScriptMarkup('Independent source', prefix + '<sup>!</sup>')).toBe(
      prefix + '<sup>!</sup>'
    )
  }
  expect(
    pdfTranslationMissingCitationIdentities('Mean (SD)a', '(a' + '\t'.repeat(40_000) + '!')
  ).toContain('a')
  const punctuation = '!'.repeat(40_000)
  expect(
    pdfTranslationCopiesEnglishProse(
      'This is the original text ' + punctuation,
      'This is the original text ' + punctuation,
      'Chinese'
    )
  ).toBe(true)
  expect(
    pdfTranslationCopiesEnglishProse(
      'This is the original text ' + '0'.repeat(40_000),
      '这是完整的翻译。',
      'Chinese'
    )
  ).toBe(false)
})

it.each([
  ['Ethics Statement', '伦理声明'],
  ['Open Science', '开放科学'],
  ['Open Science Statement', '开放科学声明'],
  ['Training Details', '训练细节'],
  ['Additional Results', '补充结果'],
  ['Implementation Details', '实现细节'],
  ['Data Availability', '数据可用性'],
  ['Ethical Considerations', '伦理考量'],
  ['A.1 Ethics Statement', 'A.1 伦理声明'],
  ['A.2 Open Science Statement', 'A.2 开放科学声明'],
  ['3.1 Training Details', '3.1 训练细节'],
  ['3.2. Ablation Study', '3.2. 消融研究'],
  ['  ETHICS\t STATEMENT  ', '伦理声明']
])('translates a complete academic heading and rejects copied English: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, target, 'Chinese')).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, source, 'Chinese')).toBe(true)
})

it.each([
  ['A.1 Ethics Statement', 'A.1 伦理 Statement'],
  ['Open Science Statement', 'Open Science 声明'],
  ['Training Details', '训练 Details']
])('rejects an untranslated word within a known complete heading: %s', (source, target) => {
  expect(pdfTranslationCopiesEnglishProse(source, target, 'Chinese')).toBe(true)
})

it.each([
  ['Open Science Foundation', '开放科学基金会'],
  ['Ethics Statement Initiative', '伦理声明倡议'],
  ['Training Details Institute', '训练细节研究所'],
  ['Additional Results Lab', '补充结果实验室'],
  ['Implementation Details Association', '实现细节协会'],
  ['Data Availability Foundation', '数据可用性基金会'],
  ['Ablation Study Foundation', '消融研究基金会'],
  ['EthicsStatement', '伦理声明'],
  ['OpenScience', '开放科学'],
  ['ABC Ethics Statement', 'ABC 伦理声明'],
  ['Ada River*', '河某']
])('keeps unknown identities containing academic heading words: %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(true)
  expect(pdfTranslationDropsStandaloneProperName(source, source)).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, source, 'Chinese')).toBe(false)
})

it.each([
  ['SUPPLEMENTAL MATERIAL', '补充材料'],
  ['Supplemental Material', '补充材料'],
  ['Weighting Scheme', '权重方案'],
  ['Human Immunodeficiency Virus', '人类免疫缺陷病毒'],
  ['Non-Hispanic Black', '非西班牙裔黑人'],
  ['Non-Hispanic White', '非西班牙裔白人'],
  ['SEX-BASED ANALYSES', '基于性别的分析'],
  ['COMPETING INTERESTS STATEMENT', '利益冲突声明'],
  ['CONTRIBUTORSHIP STATEMENT', '作者贡献声明'],
  ['Structural Metadata', '结构元数据'],
  ['Technical Metadata', '技术元数据'],
  ['Declarative Metadata', '声明元数据'],
  ['Operation Registry', '操作注册表'],
  ['Schema Registry', '模式注册表'],
  ['Any Technology', '任意技术'],
  ['Industry API', '行业 API'],
  ['INDUSTRY API', '行业 API'],
  ['ABC Domain', 'ABC 域'],
  ['ABC Information Record', 'ABC 信息记录']
])('translates a complete generic diagram role while retaining identifiers: %s', (source, text) => {
  expect(pdfTranslationDropsStandaloneProperName(source, text)).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, source, 'Chinese')).toBe(true)
})
it.each([
  ['Supplemental Material Foundation', '补充材料基金会'],
  ['Weighting Scheme Labs', '权重方案实验室'],
  ['Human Immunodeficiency Virus Foundation', '人类免疫缺陷病毒基金会'],
  ['Non-Hispanic Blue', '非西班牙裔蓝色'],
  ['Sex-Based Analyses Lab', '基于性别的分析实验室'],
  ['Competing Interests Statement Foundation', '利益冲突声明基金会'],
  ['ABC Weighting Scheme', 'ABC 权重方案'],
  ['Structural Metadata Institute', '结构元数据研究所'],
  ['Metadata Registry Foundation', '元数据注册表基金会'],
  ['Any Technology Labs', '任意技术实验室'],
  ['Blue Domain', '蓝域'],
  ['ABC Domain', '字母域'],
  ['ABC Domain', 'ABC1 域'],
  ['ABC Domain', '_ABC 域'],
  ['ABC Information Record', '信息记录']
])('retains unknown containing names and complete diagram acronyms: %s', (source, text) => {
  expect(pdfTranslationDropsStandaloneProperName(source, text)).toBe(true)
})
it.each([
  ['Industry API', '行业接口'],
  ['Industry API', '行业 API2'],
  ['Industry API', '行业 XAPI'],
  ['Industry API Labs', '行业 API 实验室'],
  ['Example API', '示例 API'],
  ['Val Precision Labs', '验证精确率实验室']
])(
  'keeps complete identifiers and unknown names beside ordinary role words: %s',
  (source, text) => {
    expect(pdfTranslationDropsStandaloneProperName(source, text)).toBe(true)
  }
)
it.each([
  ['Industry API', 'IndustryAPI'],
  ['Industry API', 'Industry API 行业'],
  ['Industry API', '行业 IndustryAPI']
])(
  'rejects copied ordinary label words despite typography or added Chinese: %s',
  (source, text) => {
    expect(pdfTranslationCopiesEnglishProse(source, text, 'Chinese')).toBe(true)
  }
)
it.each([
  [
    'Prediction accuracy - 87% of cases were correct.',
    '预测准确率为87%，这些情况判断正确。',
    false
  ],
  [
    'Detection completeness - 85% of cases were identified.',
    '检测完整性为85%，这些情况已识别。',
    false
  ],
  ['Prediction accuracy - 87% of cases were correct.', '预测准确率为−87%。', true],
  ['The change in accuracy - 5% was measured.', '准确率变化为5%。', true],
  ['The change in prediction accuracy - 5% of cases was measured.', '预测准确率变化为5%。', true],
  ['Prediction accuracy - 5%', '预测准确率为5%。', true],
  ['The accuracy was -87%.', '准确率为87%。', true],
  ['The accuracy was −87%.', '准确率为87%。', true],
  ['The accuracy change was - 5%.', '准确率变化为5%。', true],
  ['Prediction accuracy -87% of cases were correct.', '预测准确率为87%。', true],
  ['Prediction accuracy − 87% of cases were correct.', '预测准确率为87%。', true],
  ['The change was - 5 units.', '变化为5个单位。', true],
  ['The expression is x - 5.', '该表达式为x - 5。', false]
])('distinguishes a metric separator from a unary numeric sign: %s', (source, text, changed) => {
  expect(pdfTranslationChangesNumericSigns(source, text)).toBe(changed)
})

it.each([
  ['The response remains readable.', '回复应保持可�读。', true],
  ['The damaged label reads �.', '损坏的标签显示为�。', false],
  ['The damaged label reads �.', '损坏的标签显示为��。', true],
  ['The response remains readable.', '回复应保持可读。', false]
])('rejects only newly introduced replacement glyphs: %s', (source, translation, expected) => {
  expect(pdfTranslationIntroducesReplacementCharacters(source, translation)).toBe(expected)
})

it('drops a damaged saved response while preserving an original replacement-symbol literal', () => {
  const checkpoint = {
    ...saved,
    sources: ['The response remains readable.', 'The damaged label reads �.'],
    translations: ['回复应保持可�读。', '损坏的标签显示为�。'],
    translatedSourceIndices: [0, 1]
  }
  const restored = reconcilePdfTranslationCheckpoint(checkpoint, 'fp', checkpoint.sources)
  expect(restored?.translatedSourceIndices).toEqual([1])
  expect(restored?.translations).toEqual(['损坏的标签显示为�。'])
})

it.each([
  ['ABC Concepts', 'ABC 概念'],
  ['Overall XYZ', '总体 XYZ'],
  ['AB Coordinates', 'AB 坐标'],
  ['Training Setting', '训练设置'],
  ['Rendered Input', '渲染输入'],
  ['THE CODE', '代码'],
  ['Gaussian Map', '高斯映射'],
  ['ABC2 Concepts', 'ABC2 概念']
])('localizes the ordinary label %s while retaining its exact identifier', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(false)
  expect(pdfTranslationCopiesEnglishProse(source, source, 'Chinese')).toBe(true)
})
it.each([
  ['ABC Concepts', '概念'],
  ['ABC Concepts', 'abc 概念'],
  ['ABC Concepts', 'XABC 概念'],
  ['ABC Concepts', 'ABC1 概念'],
  ['ABC Concepts', '_ABC 概念'],
  ['ABC2 Concepts', 'ABC 概念'],
  ['Jane Doe', '简·多'],
  ['RenderedImage', '渲染图像'],
  ['ABC Concepts Institute', 'ABC 概念研究所'],
  ['Defense Setting Foundation', '防御设置基金会']
])('preserves complete identifiers and unknown names in %s', (source, target) => {
  expect(pdfTranslationDropsStandaloneProperName(source, target)).toBe(true)
})
