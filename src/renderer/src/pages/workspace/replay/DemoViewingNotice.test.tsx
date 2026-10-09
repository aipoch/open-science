// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../../test/i18n-test-stub'
import { DemoViewingNotice } from './DemoViewingNotice'

vi.mock('react-i18next', () => {
  const stub = createI18nTestStub()
  return { ...stub, useTranslation: () => ({ ...stub.useTranslation(), i18n: { language: 'en' } }) }
})
afterEach(cleanup)

it('discloses the admitted viewing policy and upper bound before launch', () => {
  render(
    <DemoViewingNotice
      phase="preparing"
      context={{
        purpose: 'offline-demo',
        conditionChanges: [],
        demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 600_000 }
      }}
    />
  )
  expect(
    screen.getByText(
      'This run keeps the project page open after its actions finish. Stop the run when you are done viewing.'
    )
  ).toBeTruthy()
  expect(
    screen.getByText('Maximum execution time: 10 min. The program may finish earlier.')
  ).toBeTruthy()
})

it('shows an execution budget while running without inventing an absolute deadline', () => {
  render(
    <DemoViewingNotice
      phase="running"
      context={{
        purpose: 'offline-demo',
        conditionChanges: [],
        demoViewing: { mode: 'process-lifetime', timeoutMs: 360_000 }
      }}
    />
  )
  expect(
    screen.getByText('Maximum execution time: 6 min. The program may finish earlier.')
  ).toBeTruthy()
  expect(screen.queryByText(/no later than/)).toBeNull()
})

it('does not promise to hold a legacy program open or infer its deadline', () => {
  render(
    <DemoViewingNotice
      phase="running"
      context={{ purpose: 'offline-demo', conditionChanges: [] }}
    />
  )
  expect(screen.getByText('The project page closes when this run ends.')).toBeTruthy()
  expect(screen.getByText('The viewing time limit was not recorded for this run.')).toBeTruthy()
})

it.each(['completed', 'failed', 'cancelled', 'interrupted', 'timeout', 'collecting'] as const)(
  'does not show an active viewing promise for %s',
  (phase) => {
    const { container } = render(
      <DemoViewingNotice
        phase={phase}
        context={{
          purpose: 'offline-demo',
          conditionChanges: [],
          demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 600_000 }
        }}
      />
    )
    expect(container.textContent).toBe('')
  }
)

it.each(['research', 'unknown'] as const)(
  'does not couple %s execution to demo viewing',
  (purpose) => {
    const { container } = render(
      <DemoViewingNotice phase="running" context={{ purpose, conditionChanges: [] }} />
    )
    expect(container.textContent).toBe('')
  }
)

it('does not offer viewing in a historical record of a running phase', () => {
  const { container } = render(
    <DemoViewingNotice
      phase="running"
      recorded
      context={{
        purpose: 'offline-demo',
        conditionChanges: [],
        demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 600_000 }
      }}
    />
  )
  expect(container.textContent).toBe('')
})
