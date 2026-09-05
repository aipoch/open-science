import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import AccessibilityReporter, {
  ACCESSIBILITY_SCAN_ATTACHMENT,
  ACCESSIBILITY_SURFACES,
  ACCESSIBILITY_UI_FINDING_ATTACHMENT,
  ACCESSIBILITY_UI_READY_ATTACHMENT,
  classifyAccessibilityRun,
  formatAccessibilitySummary,
  type AccessibilityScan
} from '../../e2e/accessibility-reporter'

const scan = (surface: AccessibilityScan['surface'], violationCount = 0): AccessibilityScan => ({
  surface,
  violations: Array.from({ length: violationCount }, (_, index) => ({
    id: `rule-${index + 1}`,
    impact: 'serious',
    help: `Fix rule ${index + 1}`,
    nodes: [{ html: '<button></button>', target: ['button'] }]
  }))
})

describe('accessibility run classification', () => {
  const completeScans = (): AccessibilityScan[] =>
    ACCESSIBILITY_SURFACES.map((surface) => scan(surface))

  it('passes a complete scan without blocking findings', () => {
    expect(
      classifyAccessibilityRun({
        runStatus: 'passed',
        plannedTests: 11,
        completedTests: 11,
        readyTests: 11,
        scans: completeScans(),
        uiFindings: []
      })
    ).toEqual({ status: 'passed', findings: 0 })
  })

  it('keeps a complete scan with blocking findings advisory', () => {
    const result = classifyAccessibilityRun({
      runStatus: 'passed',
      plannedTests: 11,
      completedTests: 11,
      readyTests: 11,
      scans: completeScans().map((item) =>
        item.surface === 'Settings' ? scan('Settings', 2) : item
      ),
      uiFindings: []
    })

    expect(result).toEqual({ status: 'advisory', findings: 2 })
    expect(formatAccessibilitySummary(result)).toContain('A11Y_FINDINGS')
  })

  it.each([
    {
      name: 'Electron launch failed before axe ran',
      input: {
        runStatus: 'failed' as const,
        plannedTests: 11,
        completedTests: 11,
        readyTests: 0,
        scans: [],
        uiFindings: []
      }
    },
    {
      name: 'a test ended without any axe evidence',
      input: {
        runStatus: 'passed' as const,
        plannedTests: 11,
        completedTests: 11,
        readyTests: 11,
        scans: completeScans().slice(1),
        uiFindings: []
      }
    }
  ])('fails closed when $name', ({ input }) => {
    const result = classifyAccessibilityRun(input)

    expect(result).toEqual({ status: 'infra-failure', findings: 0 })
    expect(formatAccessibilitySummary(result)).toContain('INFRA_FAILURE')
  })

  it('keeps a keyboard accessibility failure advisory after a complete scan', () => {
    expect(
      classifyAccessibilityRun({
        runStatus: 'passed',
        plannedTests: 11,
        completedTests: 11,
        readyTests: 11,
        scans: completeScans(),
        uiFindings: [{ surface: 'Keyboard-only project journey', message: 'Focus was lost' }]
      })
    ).toEqual({ status: 'advisory', findings: 1 })
  })

  it('keeps an unstructured Playwright failure blocking after a complete scan', () => {
    expect(
      classifyAccessibilityRun({
        runStatus: 'failed',
        plannedTests: 11,
        completedTests: 11,
        readyTests: 11,
        scans: completeScans(),
        uiFindings: []
      })
    ).toEqual({ status: 'infra-failure', findings: 0 })
  })

  it('uses one stable attachment name for scan evidence', () => {
    expect(ACCESSIBILITY_SCAN_ATTACHMENT).toBe('accessibility-scan')
    expect(ACCESSIBILITY_UI_FINDING_ATTACHMENT).toBe('accessibility-ui-finding')
    expect(ACCESSIBILITY_UI_READY_ATTACHMENT).toBe('accessibility-ui-ready')
    expect(new AccessibilityReporter().printsToStdio()).toBe(false)
  })

  it('fails closed when scan evidence is malformed', async () => {
    const reporter = new AccessibilityReporter()
    reporter.onBegin({} as never, { allTests: () => [{ id: 'test-1' }] } as never)
    reporter.onTestEnd(
      { id: 'test-1' } as never,
      {
        status: 'passed',
        attachments: [
          {
            name: ACCESSIBILITY_SCAN_ATTACHMENT,
            contentType: 'application/json',
            body: Buffer.from('{invalid')
          }
        ]
      } as never
    )

    await expect(reporter.onEnd({ status: 'passed' } as never)).resolves.toEqual({
      status: 'failed'
    })
  })

  it('writes an advisory report without failing the Playwright run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'accessibility-reporter-'))
    const previousResultPath = process.env.ACCESSIBILITY_RESULT_PATH

    try {
      const resultPath = join(root, 'summary.json')
      process.env.ACCESSIBILITY_RESULT_PATH = resultPath
      const reporter = new AccessibilityReporter()
      reporter.onBegin({} as never, { allTests: () => [{ id: 'test-1' }] } as never)
      reporter.onTestEnd(
        { id: 'test-1' } as never,
        {
          status: 'passed',
          attachments: completeScans()
            .map((item) => ({
              name: ACCESSIBILITY_SCAN_ATTACHMENT,
              contentType: 'application/json',
              body: Buffer.from(JSON.stringify(item))
            }))
            .concat(
              {
                name: ACCESSIBILITY_UI_READY_ATTACHMENT,
                contentType: 'application/json',
                body: Buffer.from('{"ready":true}')
              },
              {
                name: ACCESSIBILITY_UI_FINDING_ATTACHMENT,
                contentType: 'application/json',
                body: Buffer.from(
                  '{"surface":"Keyboard-only project journey","message":"Focus was lost"}'
                )
              }
            )
        } as never
      )

      await expect(reporter.onEnd({ status: 'passed' } as never)).resolves.toBeUndefined()
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
        status: 'advisory',
        axeRunCount: ACCESSIBILITY_SURFACES.length,
        readyTests: 1,
        uiFindings: [{ surface: 'Keyboard-only project journey', message: 'Focus was lost' }]
      })
    } finally {
      if (previousResultPath === undefined) delete process.env.ACCESSIBILITY_RESULT_PATH
      else process.env.ACCESSIBILITY_RESULT_PATH = previousResultPath
      rmSync(root, { force: true, recursive: true })
    }
  })
})

it('accepts complete evidence from the expanded responsive and contrast matrix', () => {
  const surfaces = [
    ...ACCESSIBILITY_SURFACES.slice(0, 12),
    'Home (375px, light)',
    'Home (375px, dark)',
    'Home (767px, light)',
    'Home (767px, dark)',
    'Reported text (light)',
    'Reported text (dark)'
  ]
  expect(
    classifyAccessibilityRun({
      runStatus: 'passed',
      plannedTests: 11,
      completedTests: 11,
      readyTests: 11,
      scans: surfaces.map((surface) => ({ surface, violations: [] })) as AccessibilityScan[],
      uiFindings: []
    })
  ).toEqual({ status: 'passed', findings: 0 })
})
