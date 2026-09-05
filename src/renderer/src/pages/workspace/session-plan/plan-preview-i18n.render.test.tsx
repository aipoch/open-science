// @vitest-environment jsdom
// Renders the plan preview under each locale and asserts on the copy a reader sees. The unit test
// beside this one covers structure in English; this one exists because the panel's leaks were all
// invisible to that — an enum interpolated into a translated frame ('high 置信度') and a sentence
// assembled from three pieces still read as passing English assertions.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { PlanPreviewSurface } from './SessionPlanSurfaces'

let container: HTMLDivElement
let root: Root

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
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

const mount = (plan: ActivePlanProjection): void => {
  act(() => root.render(<PlanPreviewSurface projection={plan} />))
}

beforeEach(() => {
  switchTo('en')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  switchTo('en')
})

describe('plan preview i18n', () => {
  it('renders the summary, roles, and confidence in English', () => {
    mount(projection(PARALLEL, 'medium'))

    expect(container.textContent).toContain(
      'Complete 2 phases in order. Delegations within a phase may run in parallel.'
    )
    expect(container.textContent).toContain('primary agent')
    expect(container.textContent).toContain('runs in parallel')
    expect(container.textContent).toContain('SCOPE & FEASIBILITY · medium confidence')
  })

  it('picks the singular frame for a one-phase plan', () => {
    mount(projection(SOLO, 'high'))

    expect(container.textContent).toContain(
      'Complete 1 phase in order. Delegations within a phase may run in parallel.'
    )
    expect(container.textContent).toContain('high confidence')
  })

  it('renders every piece in Simplified Chinese', () => {
    switchTo('zh-Hans')
    mount(projection(PARALLEL, 'medium'))

    expect(container.textContent).toContain('按顺序完成 2 个阶段。同一阶段内的委派可以并行执行。')
    expect(container.textContent).toContain('主智能体')
    expect(container.textContent).toContain('并行执行')
    // The level itself is translated, not interpolated as the protocol enum.
    expect(container.textContent).toContain('范围与可行性 · 中等置信度')
    expect(container.textContent).not.toContain('medium')
    expect(container.textContent).not.toContain('phases')
  })

  it('renders every piece in Traditional Chinese', () => {
    switchTo('zh-Hant')
    mount(projection(SOLO, 'low'))

    expect(container.textContent).toContain('按順序完成 1 個階段。同一階段內的委派可以平行執行。')
    expect(container.textContent).toContain('主智能體')
    expect(container.textContent).toContain('範圍與可行性 · 低信賴度')
    expect(container.textContent).not.toContain('low confidence')
  })
})
