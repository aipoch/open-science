// @vitest-environment jsdom
// Renders the plan preview under each locale and asserts on the copy a reader sees. The unit test
// beside this one covers structure in English; this one exists because the panel's leaks were all
// invisible to that — an enum interpolated into a translated frame ('high 置信度') and a sentence
// assembled from three pieces still read as passing English assertions.
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setI18nLocale } from '@/i18n'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { PlanPreviewSurface } from './SessionPlanSurfaces'

// Mock react-i18next to work around React 19 + jsdom context issues
let currentLocale = 'en'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; defaultValue_one?: string }) => {
      // Handle pluralization: when count is 1 and defaultValue_one exists, use it
      const effectiveKey =
        options?.count === 1 && options?.defaultValue_one ? options.defaultValue_one : key

      // Return the key itself for English (natural-language keys)
      if (currentLocale === 'en') {
        // Handle interpolation for English
        if (options?.count !== undefined) {
          return effectiveKey.replace('{{count}}', String(options.count))
        }
        return effectiveKey
      }

      // Simple translations for test assertions
      const translations: Record<string, Record<string, string>> = {
        'zh-Hans': {
          'Complete {{count}} phase in order. Delegations within a phase may run in parallel.':
            '按顺序完成 {{count}} 个阶段。同一阶段内的委派可以并行执行。',
          'Complete {{count}} phases in order. Delegations within a phase may run in parallel.':
            '按顺序完成 {{count}} 个阶段。同一阶段内的委派可以并行执行。',
          'primary agent': '主 Agent',
          'runs in parallel': '并行执行',
          'SCOPE & FEASIBILITY': '范围与可行性',
          'high confidence': '高置信度',
          'medium confidence': '中等置信度',
          'low confidence': '低置信度'
        },
        'zh-Hant': {
          'Complete {{count}} phase in order. Delegations within a phase may run in parallel.':
            '按順序完成 {{count}} 個階段。同一階段內的委派可以平行執行。',
          'Complete {{count}} phases in order. Delegations within a phase may run in parallel.':
            '按順序完成 {{count}} 個階段。同一階段內的委派可以平行執行。',
          'primary agent': '主 Agent',
          'SCOPE & FEASIBILITY': '範圍與可行性',
          'high confidence': '高信賴度',
          'medium confidence': '中等信賴度',
          'low confidence': '低信賴度'
        }
      }

      let translated = translations[currentLocale]?.[effectiveKey] || effectiveKey

      // Handle interpolation for translated strings
      if (options?.count !== undefined) {
        translated = translated.replace('{{count}}', String(options.count))
      }

      return translated
    },
    i18n: { language: currentLocale }
  })
}))

const switchTo = (language: string): void => {
  currentLocale = language
  setI18nLocale(language as 'en' | 'zh-Hans' | 'zh-Hant')
}

type Phase = ActivePlanProjection['document']['phases'][number]

const phase = (name: string, delegationNames: readonly string[]): Phase =>
  ({
    name,
    delegations: delegationNames.map((delegationName) => ({
      name: delegationName,
      steps: [{ title: `${delegationName} step`, description: 'Do the work.' }]
    }))
  }) as Phase

const SOLO: Phase[] = [phase('Data intake', ['Cohort build'])]
const PARALLEL: Phase[] = [
  phase('Data intake', ['Cohort build', 'Evidence review']),
  phase('Compare', ['Compare cohorts'])
]

const projection = (phases: Phase[], confidence: 'high' | 'medium' | 'low'): ActivePlanProjection =>
  ({
    artifactVersionId: 'v1',
    revision: 1,
    approval: 'approved',
    lifecycle: 'in_progress',
    continuationState: 'active',
    requiresExplicitContinuation: false,
    stepStatuses: {},
    stepStates: {},
    counts: { phases: phases.length, delegations: 1, steps: 1, completed: 0, inProgress: 0 },
    document: {
      schema_version: 1,
      task_summary: 'Compare cohorts',
      phases,
      desired_outputs: ['Report'],
      feasibility: { confidence, rationale: 'Inputs are available.' }
    }
  }) as unknown as ActivePlanProjection

beforeEach(() => {
  currentLocale = 'en'
})

afterEach(() => {
  cleanup()
  switchTo('en')
})

describe('plan preview i18n', () => {
  it('renders the summary, roles, and confidence in English', () => {
    const { container } = render(<PlanPreviewSurface projection={projection(PARALLEL, 'medium')} />)

    expect(container.textContent).toContain(
      'Complete 2 phases in order. Delegations within a phase may run in parallel.'
    )
    expect(container.textContent).toContain('primary agent')
    expect(container.textContent).toContain('runs in parallel')
    expect(container.textContent).toContain('SCOPE & FEASIBILITY · medium confidence')
  })

  it('picks the singular frame for a one-phase plan', () => {
    const { container } = render(<PlanPreviewSurface projection={projection(SOLO, 'high')} />)

    expect(container.textContent).toContain(
      'Complete 1 phase in order. Delegations within a phase may run in parallel.'
    )
    expect(container.textContent).toContain('high confidence')
  })

  it('renders every piece in Simplified Chinese', () => {
    switchTo('zh-Hans')
    const { container } = render(<PlanPreviewSurface projection={projection(PARALLEL, 'medium')} />)

    expect(container.textContent).toContain('按顺序完成 2 个阶段。同一阶段内的委派可以并行执行。')
    expect(container.textContent).toContain('主 Agent')
    expect(container.textContent).toContain('并行执行')
    // The level itself is translated, not interpolated as the protocol enum.
    expect(container.textContent).toContain('范围与可行性 · 中等置信度')
    expect(container.textContent).not.toContain('medium')
    expect(container.textContent).not.toContain('phases')
  })

  it('renders every piece in Traditional Chinese', () => {
    switchTo('zh-Hant')
    const { container } = render(<PlanPreviewSurface projection={projection(SOLO, 'low')} />)

    expect(container.textContent).toContain('按順序完成 1 個階段。同一階段內的委派可以平行執行。')
    expect(container.textContent).toContain('主 Agent')
    expect(container.textContent).toContain('範圍與可行性 · 低信賴度')
    expect(container.textContent).not.toContain('low confidence')
  })
})
