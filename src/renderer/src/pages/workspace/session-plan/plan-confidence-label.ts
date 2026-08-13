import type { PlanConfidence } from '../../../../../shared/session-plan/contract'

// The document stores confidence as a protocol enum (`high`), and the UI used to render it by
// interpolating that value into '{{confidence}} confidence' — which leaves the level itself in
// English on a Chinese screen ('high 置信度'). Translating the whole phrase instead also lets zh
// put the level where its grammar wants it.
//
// `satisfies` is what keeps this honest: a fourth confidence level added upstream fails to compile
// here rather than resolving to undefined and rendering nothing.
const PLAN_CONFIDENCE_LABEL = {
  high: 'high confidence',
  medium: 'medium confidence',
  low: 'low confidence'
} as const satisfies Record<PlanConfidence, string>

const planConfidenceLabelKey = (confidence: PlanConfidence): string =>
  PLAN_CONFIDENCE_LABEL[confidence]

export { planConfidenceLabelKey }
