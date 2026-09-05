import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult
} from '@playwright/test/reporter'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const ACCESSIBILITY_SCAN_ATTACHMENT = 'accessibility-scan'
const ACCESSIBILITY_UI_FINDING_ATTACHMENT = 'accessibility-ui-finding'
const ACCESSIBILITY_UI_READY_ATTACHMENT = 'accessibility-ui-ready'
const ACCESSIBILITY_ADVISORY = process.env.ACCESSIBILITY_ADVISORY === '1'
const DEFAULT_RESULT_PATH = 'test-results/accessibility/accessibility-summary.json'
const ACCESSIBILITY_SURFACES = [
  'Onboarding',
  'Home',
  'New project dialog',
  'Workspace',
  'Settings',
  'Permission request',
  'Project files (narrow)',
  'File preview dialog',
  'Long conversation (dark)',
  'Artifact provenance',
  'Compute settings (narrow, dark)',
  'Conversation recovery warning',
  'Home (375px, light)',
  'Home (375px, dark)',
  'Home (767px, light)',
  'Home (767px, dark)',
  'Reported text (light)',
  'Reported text (dark)'
] as const

type AccessibilitySurface = (typeof ACCESSIBILITY_SURFACES)[number]

type BlockingViolation = {
  id: string
  impact: string | null
  help: string
  nodes: Array<{ html: string; target: unknown }>
}

type AccessibilityScan = {
  surface: AccessibilitySurface
  violations: BlockingViolation[]
}

type AccessibilityUiFinding = {
  surface: string
  message: string
}

type AccessibilityRunInput = {
  runStatus: FullResult['status']
  plannedTests: number
  completedTests: number
  readyTests: number
  scans: AccessibilityScan[]
  uiFindings: AccessibilityUiFinding[]
}

type AccessibilityRunClassification = {
  status: 'passed' | 'advisory' | 'infra-failure'
  findings: number
}

const classifyAccessibilityRun = ({
  runStatus,
  plannedTests,
  completedTests,
  readyTests,
  scans,
  uiFindings
}: AccessibilityRunInput): AccessibilityRunClassification => {
  const axeFindings = scans.reduce((total, scan) => total + scan.violations.length, 0)
  const scannedSurfaces = new Set(scans.map(({ surface }) => surface))
  if (
    plannedTests === 0 ||
    runStatus !== 'passed' ||
    completedTests !== plannedTests ||
    readyTests !== plannedTests ||
    scans.length !== ACCESSIBILITY_SURFACES.length ||
    ACCESSIBILITY_SURFACES.some((surface) => !scannedSurfaces.has(surface))
  ) {
    return { status: 'infra-failure', findings: axeFindings }
  }
  const findings = axeFindings + uiFindings.length
  return {
    status: findings === 0 ? 'passed' : 'advisory',
    findings
  }
}

const formatAccessibilitySummary = (
  result: AccessibilityRunClassification,
  scans: AccessibilityScan[] = [],
  uiFindings: AccessibilityUiFinding[] = []
): string => {
  const heading =
    result.status === 'infra-failure'
      ? 'INFRA_FAILURE'
      : result.status === 'advisory'
        ? 'A11Y_FINDINGS'
        : 'VALID_SCAN'
  const lines = [
    '## Accessibility quality signal',
    '',
    `Result: **${heading}**`,
    '',
    `- axe scans completed: ${scans.length}`,
    `- advisory findings: ${result.findings}`
  ]

  if (result.status === 'infra-failure') {
    lines.push('', 'The real UI scan did not complete. Treat this as test infrastructure failure.')
  } else if (result.status === 'advisory') {
    lines.push('', 'Findings are advisory and do not block this pull request.')
    if (scans.some(({ violations }) => violations.length > 0)) {
      lines.push('', '### axe findings', '')
    }
    for (const scan of scans) {
      for (const violation of scan.violations) {
        lines.push(
          `- **${scan.surface} · ${violation.id}** (${violation.impact ?? 'unknown'}): ${violation.help}`
        )
        for (const node of violation.nodes) {
          lines.push(`  - Target: \`${JSON.stringify(node.target)}\`; HTML: \`${node.html}\``)
        }
      }
    }
    for (const finding of uiFindings) {
      lines.push(`- **${finding.surface}**: ${finding.message}`)
    }
  }

  return `${lines.join('\n')}\n`
}

const parseScans = (result: TestResult): AccessibilityScan[] =>
  result.attachments
    .filter(({ name, body }) => name === ACCESSIBILITY_SCAN_ATTACHMENT && body)
    .map(({ body }) => JSON.parse(body!.toString('utf8')) as AccessibilityScan)

const parseUiFindings = (result: TestResult): AccessibilityUiFinding[] =>
  result.attachments
    .filter(({ name, body }) => name === ACCESSIBILITY_UI_FINDING_ATTACHMENT && body)
    .map(({ body }) => JSON.parse(body!.toString('utf8')) as AccessibilityUiFinding)

class AccessibilityReporter implements Reporter {
  private plannedTests = 0
  private readonly finalResults = new Map<string, TestResult>()

  printsToStdio(): boolean {
    return false
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.plannedTests = suite.allTests().length
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.finalResults.set(test.id, result)
  }

  async onEnd(fullResult: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    try {
      const scans = [...this.finalResults.values()].flatMap(parseScans)
      const uiFindings = [...this.finalResults.values()].flatMap(parseUiFindings)
      const readyTests = [...this.finalResults.values()].filter((result) =>
        result.attachments.some(({ name }) => name === ACCESSIBILITY_UI_READY_ATTACHMENT)
      ).length
      const result = classifyAccessibilityRun({
        runStatus: fullResult.status,
        plannedTests: this.plannedTests,
        completedTests: this.finalResults.size,
        readyTests,
        scans,
        uiFindings
      })
      const report = {
        schemaVersion: 1,
        ...result,
        runStatus: fullResult.status,
        plannedTests: this.plannedTests,
        completedTests: this.finalResults.size,
        readyTests,
        axeRunCount: scans.length,
        scans,
        uiFindings
      }
      const resultPath = resolve(process.env.ACCESSIBILITY_RESULT_PATH ?? DEFAULT_RESULT_PATH)

      mkdirSync(dirname(resultPath), { recursive: true })
      writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`)
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          formatAccessibilitySummary(result, scans, uiFindings)
        )
      }
      if (result.status === 'infra-failure') return { status: 'failed' }
      return undefined
    } catch (error) {
      console.error('Failed to publish accessibility scan evidence.', error)
      return { status: 'failed' }
    }
  }
}

export default AccessibilityReporter
export {
  ACCESSIBILITY_ADVISORY,
  ACCESSIBILITY_SCAN_ATTACHMENT,
  ACCESSIBILITY_SURFACES,
  ACCESSIBILITY_UI_FINDING_ATTACHMENT,
  ACCESSIBILITY_UI_READY_ATTACHMENT,
  classifyAccessibilityRun,
  formatAccessibilitySummary
}
export type { AccessibilityScan, AccessibilitySurface, AccessibilityUiFinding }
