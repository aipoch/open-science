import { readPdfTranslationCases } from '../../test/fixtures/pdf-translation/read-cases'
import { expect, it } from 'vitest'
import { pdfTranslationCheckpointSchema, type PdfTranslationCheckpoint } from './pdf-translation'
import {
  reconcilePdfTranslationCheckpoint,
  pdfTranslationSourceIndices,
  nextPdfTranslationSourceIndex,
  normalizePdfTranslationText,
  pdfTranslationHasCommentary,
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
} from './pdf-translation-recovery'

const saved: PdfTranslationCheckpoint = {
  version: 1,
  key: '11111111-1111-4111-8111-111111111111',
  revision: 4,
  attachmentVersionId: 'v',
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
