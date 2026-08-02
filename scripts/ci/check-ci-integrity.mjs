/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'

import { parseNameStatus } from './classify-pr-changes.mjs'

function actionReferences(document, workflow) {
  const references = new Set()

  function addStepReferences(steps) {
    if (!Array.isArray(steps)) return
    for (const step of steps) {
      if (
        step &&
        typeof step === 'object' &&
        !Array.isArray(step) &&
        typeof step.uses === 'string'
      ) {
        references.add(step.uses)
      }
    }
  }

  if (workflow) {
    for (const job of Object.values(workflowJobs(document))) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) continue
      if (typeof job.uses === 'string') references.add(job.uses)
      addStepReferences(job.steps)
    }
  } else if (document && typeof document === 'object' && !Array.isArray(document)) {
    const runs = document.runs
    if (runs && typeof runs === 'object' && !Array.isArray(runs)) addStepReferences(runs.steps)
  }

  return references
}

function isImmutableActionReference(reference) {
  if (reference.startsWith('./')) return true
  if (reference.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/i.test(reference)
  return /@[0-9a-f]{40}$/i.test(reference)
}

function isPullRequestTargetWorkflow(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false
  const triggers = document.on
  if (triggers === 'pull_request_target') return true
  if (Array.isArray(triggers)) return triggers.includes('pull_request_target')
  return Boolean(
    triggers &&
    typeof triggers === 'object' &&
    !Array.isArray(triggers) &&
    Object.hasOwn(triggers, 'pull_request_target')
  )
}

function scalarStrings(document) {
  const strings = []
  const visited = new WeakSet()

  function visit(value) {
    if (typeof value === 'string') {
      strings.push(value)
      return
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child)
  }

  visit(document)
  return strings
}

function executesPullRequestHead(document) {
  if (!isPullRequestTargetWorkflow(document)) return false

  const patterns = [
    /github\.event\.pull_request\.head\.(?:sha|ref)/,
    /\bgithub\.head_ref\b/,
    /\bgh\s+pr\s+checkout\b/,
    /\bgit\s+(?:checkout|switch)\b[^\n]*(?:head|pull\/)/i
  ]
  return scalarStrings(document).some((value) => patterns.some((pattern) => pattern.test(value)))
}

function writePermissions(document) {
  const permissions = new Set()

  function addWrites(value, scope) {
    if (value === 'write-all') {
      permissions.add(`${scope}:write-all`)
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    for (const [permission, access] of Object.entries(value)) {
      if (access === 'write') permissions.add(`${scope}:${permission}`)
    }
  }

  if (!document || typeof document !== 'object' || Array.isArray(document)) return permissions
  addWrites(document.permissions, 'workflow')
  for (const [jobId, job] of Object.entries(workflowJobs(document))) {
    if (job && typeof job === 'object' && !Array.isArray(job)) {
      addWrites(job.permissions, `job:${jobId}`)
    }
  }
  return permissions
}

const stableChecks = {
  '.github/workflows/pr-gate.yml': { jobId: 'gate', name: 'PR Gate' },
  '.github/workflows/ci-integrity.yml': { jobId: 'integrity', name: 'CI Integrity' }
}

const protectedControlPlanePaths = new Set([
  ...Object.keys(stableChecks),
  'scripts/ci/check-ci-integrity.mjs',
  'scripts/ci/check-pr-policy.mjs',
  'scripts/ci/classify-pr-changes.mjs',
  'scripts/ci/change-impact.json',
  'scripts/ci/evaluate-pr-gate.mjs'
])

function isWorkflowPath(path) {
  return /^\.github\/workflows\/.*\.ya?ml$/i.test(path)
}

function isActionDefinitionPath(path) {
  return /^\.github\/actions\/(?:.*\/)?action\.ya?ml$/i.test(path)
}

function workflowJobs(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return {}
  const jobs = document.jobs
  return jobs && typeof jobs === 'object' && !Array.isArray(jobs) ? jobs : {}
}

function hasStableJobName(document, { jobId, name }) {
  const job = workflowJobs(document)[jobId]
  return Boolean(job && typeof job === 'object' && !Array.isArray(job) && job.name === name)
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dynamicNameCouldEqual(jobName, reservedName) {
  if (!jobName.includes('${{')) return false
  const source = jobName
    .split(/\$\{\{[\s\S]*?\}\}/g)
    .map(escapeRegularExpression)
    .join('.*')
  return new RegExp(`^${source}$`, 's').test(reservedName)
}

function reservedCheckViolations(path, document, workflowChanged) {
  const violations = []
  for (const [jobId, job] of Object.entries(workflowJobs(document))) {
    const jobName = job && typeof job === 'object' && !Array.isArray(job) ? job.name : undefined
    for (const [canonicalPath, stableCheck] of Object.entries(stableChecks)) {
      const isCanonicalJob =
        path === canonicalPath && jobId === stableCheck.jobId && jobName === stableCheck.name
      if (!isCanonicalJob && (jobId === stableCheck.jobId || jobName === stableCheck.name)) {
        violations.push({
          path,
          rule: 'reserved-required-check',
          message: `${stableCheck.jobId}/${stableCheck.name} is reserved for ${canonicalPath}`
        })
      }
    }

    const couldSpoofReservedCheck =
      workflowChanged &&
      typeof jobName === 'string' &&
      Object.values(stableChecks).some(({ name }) => dynamicNameCouldEqual(jobName, name))
    if (couldSpoofReservedCheck) {
      violations.push({
        path,
        rule: 'reserved-dynamic-check',
        message:
          'A dynamic job name that can equal a reserved required check needs an explicit maintainer ruleset bypass'
      })
    }
  }
  return violations
}

export function checkCiIntegrityChanges(files) {
  const violations = []

  for (const file of files) {
    const headText = file.headText ?? ''
    const baseText = file.baseText ?? ''
    const workflow = isWorkflowPath(file.path)
    const executableYaml = workflow || isActionDefinitionPath(file.path)
    let document
    let baseDocument

    if (workflow && baseText) {
      try {
        baseDocument = load(baseText)
      } catch {
        // The base revision is already trusted; only proposed YAML is reported here.
      }
    }

    if (executableYaml && headText) {
      try {
        document = load(headText)
      } catch (error) {
        violations.push({
          path: file.path,
          rule: workflow ? 'valid-workflow-yaml' : 'valid-action-yaml',
          message: error instanceof Error ? error.message.split('\n', 1)[0] : 'Invalid YAML'
        })
      }
    }

    if (document !== undefined) {
      for (const reference of actionReferences(document, workflow)) {
        if (!isImmutableActionReference(reference)) {
          violations.push({
            path: file.path,
            rule: 'immutable-action-reference',
            message: `New action reference must use an immutable full commit SHA: ${reference}`
          })
        }
      }
    }

    if (workflow) {
      violations.push(
        ...reservedCheckViolations(
          file.path,
          document,
          headText !== baseText || Boolean(file.previousPath && file.path !== file.previousPath)
        )
      )
    }

    if (workflow && executesPullRequestHead(document)) {
      violations.push({
        path: file.path,
        rule: 'no-pr-head-execution',
        message: 'pull_request_target workflows must never checkout or execute PR-head code'
      })
    }
    if (workflow && isPullRequestTargetWorkflow(document)) {
      const baseWritePermissions = writePermissions(baseDocument)
      for (const permission of writePermissions(document)) {
        if (!baseWritePermissions.has(permission)) {
          violations.push({
            path: file.path,
            rule: 'minimal-target-permissions',
            message: `pull_request_target must not introduce write permission: ${permission}`
          })
        }
      }
    }

    const stableCheck = stableChecks[file.path] ?? stableChecks[file.previousPath]
    const protectedPath = [file.path, file.previousPath]
      .filter(Boolean)
      .find((path) => protectedControlPlanePaths.has(path))
    const movedProtectedPath = file.previousPath && file.path !== file.previousPath
    if (protectedPath && file.baseText && (headText !== file.baseText || movedProtectedPath)) {
      violations.push({
        path: file.path,
        rule: 'protected-gate-control-plane',
        message: `Established gate control-plane file ${protectedPath} may change only through an explicit maintainer ruleset bypass`
      })
    }
    if (stableCheck && !hasStableJobName(document, stableCheck)) {
      violations.push({
        path: file.path,
        rule: 'stable-required-check',
        message: `Required job must remain ${stableCheck.jobId} with name ${stableCheck.name}`
      })
    }
  }

  return {
    ok: violations.length === 0,
    inspectedFiles: files.map(({ path }) => path).sort(),
    violations
  }
}

function isGuardedPath(path) {
  return (
    path.startsWith('.github/workflows/') ||
    path.startsWith('.github/actions/') ||
    path.startsWith('scripts/ci/') ||
    path === '.github/dependabot.yml' ||
    path === '.github/CODEOWNERS' ||
    path === 'CODEOWNERS'
  )
}

function textAtRevision(revision, path, cwd) {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

export function ciIntegrityFilesFromRevisions(base, head, { cwd = process.cwd() } = {}) {
  const mergeBase = execFileSync('git', ['merge-base', base, head], {
    cwd,
    encoding: 'utf8'
  }).trim()
  const diff = execFileSync('git', ['diff', '--name-status', '-z', mergeBase, head], { cwd })
  return parseNameStatus(diff.toString('utf8'))
    .filter(({ path, previousPath }) => [path, previousPath].filter(Boolean).some(isGuardedPath))
    .map(({ path, previousPath }) => ({
      path,
      previousPath,
      baseText: textAtRevision(mergeBase, previousPath ?? path, cwd),
      headText: textAtRevision(head, path, cwd)
    }))
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

function requireCommit(value, name) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} must be a full 40-character Git commit SHA`)
  }
  return value
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function formatCiIntegritySummary(result) {
  const inspected =
    result.inspectedFiles.length === 0
      ? '- _No CI-sensitive files changed_'
      : result.inspectedFiles.map((path) => `- <code>${escapeHtml(path)}</code>`).join('\n')
  const violations =
    result.violations.length === 0
      ? '- None'
      : result.violations
          .map(
            ({ path, rule, message }) =>
              `- **${escapeHtml(rule)}** in <code>${escapeHtml(path)}</code>: ${escapeHtml(message)}`
          )
          .join('\n')

  return `## CI Integrity

Result: **${result.ok ? 'pass' : 'fail'}**

### Inspected files

${inspected}

### Violations

${violations}
`
}

export function runCiIntegrityCli(arguments_ = process.argv.slice(2), environment = process.env) {
  const base = requireCommit(argumentValue(arguments_, '--base') ?? environment.BASE_SHA, '--base')
  const head = requireCommit(argumentValue(arguments_, '--head') ?? environment.HEAD_SHA, '--head')
  const result = checkCiIntegrityChanges(ciIntegrityFilesFromRevisions(base, head))

  if (environment.GITHUB_STEP_SUMMARY) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, formatCiIntegritySummary(result))
  } else {
    process.stdout.write(formatCiIntegritySummary(result))
  }
  if (!result.ok) process.exitCode = 1
  return result
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runCiIntegrityCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
