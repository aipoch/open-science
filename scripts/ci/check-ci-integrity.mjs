/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'
import * as ts from 'typescript'

import { parseNameStatus } from './classify-pr-changes.mjs'
import { checkDerivedConsumerRevisions } from './module-graph/index.mjs'
import { moduleOwnershipFromRevisions } from './check-module-ownership.mjs'

const GIT_OUTPUT_MAX_BUFFER = 128 * 1024 * 1024
const integrityWorkflowPath = '.github/workflows/ci-integrity.yml'
const signalWorkflowPath = '.github/workflows/pr-automation-signal.yml'
const resolverWorkflowPath = '.github/workflows/resolve-pr-signal.yml'
const signalActivities = [
  'opened',
  'edited',
  'synchronize',
  'reopened',
  'ready_for_review',
  'converted_to_draft'
]

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
  '.github/workflows/pr-gate.yml': {
    jobId: 'gate',
    name: 'PR Gate',
    pullRequestTrigger: 'pull_request'
  },
  '.github/workflows/ci-integrity.yml': {
    jobId: 'integrity',
    name: 'CI Integrity',
    pullRequestTrigger: 'pull_request_target',
    pullRequestSignal: 'PR Automation Signal'
  }
}

function workflowTriggers(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return {}
  const triggers = document.on
  if (typeof triggers === 'string') return { [triggers]: null }
  if (Array.isArray(triggers)) {
    return Object.fromEntries(triggers.filter((t) => typeof t === 'string').map((t) => [t, null]))
  }
  return triggers && typeof triggers === 'object' ? triggers : {}
}

function triggerTypes(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return []
  const types = trigger.types
  if (typeof types === 'string') return [types]
  return Array.isArray(types) ? types : []
}

function missingRequiredTriggers(document, { pullRequestTrigger, pullRequestSignal }) {
  const triggers = workflowTriggers(document)
  const missing = []
  // Land this policy before replacing the target trigger: candidate workflows cannot
  // authorize their own migration. Only the named, unfiltered completion signal qualifies.
  const signal = triggers.workflow_run
  const hasSignal =
    pullRequestSignal &&
    signal &&
    Array.isArray(signal.workflows) &&
    signal.workflows.length === 1 &&
    signal.workflows[0] === pullRequestSignal &&
    triggerTypes(signal).length === 1 &&
    triggerTypes(signal)[0] === 'completed' &&
    !Object.hasOwn(signal, 'branches') &&
    !Object.hasOwn(signal, 'branches-ignore')
  if (!Object.hasOwn(triggers, pullRequestTrigger) && !hasSignal) {
    missing.push(pullRequestTrigger)
  }
  if (
    !Object.hasOwn(triggers, 'merge_group') ||
    !triggerTypes(triggers.merge_group).includes('checks_requested')
  ) {
    missing.push('merge_group (types: checks_requested)')
  }
  return missing
}

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

function resolverScriptHasTrustedContract(script) {
  const source = ts.createSourceFile(
    'resolve-pr-signal.js',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  if (source.parseDiagnostics.length > 0) return false

  const normalize = (text) => text.replace(/\s+/g, ' ')
  const guardConditions = []
  const binaryExpressions = []
  const propertyAccesses = []
  const outputNames = new Set()
  let hasJobsAttemptLookup = false

  function visit(node, functionDepth = 0) {
    if (functionDepth === 0 && ts.isIfStatement(node)) {
      const branch = node.thenStatement.getText(source)
      if (/\b(?:return|throw)\b/.test(branch)) {
        guardConditions.push(normalize(node.expression.getText(source)))
      }
    }
    if (functionDepth === 0 && ts.isBinaryExpression(node)) {
      binaryExpressions.push(normalize(node.getText(source)))
    }
    if (functionDepth === 0 && ts.isPropertyAccessExpression(node)) {
      const access = normalize(node.getText(source))
      propertyAccesses.push(access)
      if (access.endsWith('listJobsForWorkflowRunAttempt')) hasJobsAttemptLookup = true
    }
    if (functionDepth === 0 && ts.isCallExpression(node)) {
      const callee = normalize(node.expression.getText(source))
      if (callee.endsWith('listJobsForWorkflowRunAttempt')) hasJobsAttemptLookup = true
      if (
        callee === 'core.setOutput' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        outputNames.add(node.arguments[0].text)
      }
    }
    const nextDepth = ts.isFunctionLike(node) ? functionDepth + 1 : functionDepth
    ts.forEachChild(node, (child) => visit(child, nextDepth))
  }

  visit(source)
  const hasBinary = (parts) =>
    binaryExpressions.some((expression) => parts.every((part) => expression.includes(part)))
  const hasGuard = (parts) =>
    guardConditions.some((condition) => parts.every((part) => condition.includes(part)))
  return (
    hasGuard(['run.repository.id', 'run.event', 'run.path', 'run.status', 'run.conclusion']) &&
    propertyAccesses.some((access) => access.includes('run.display_title')) &&
    hasGuard(['run.head_repository']) &&
    hasGuard(['job.name', 'Signal PR automation']) &&
    hasGuard(['pr.state', 'pr.base.ref', 'pr.head.sha', 'run.head_sha']) &&
    hasBinary(['pr.created_at', 'run.created_at']) &&
    propertyAccesses.some((access) => access.includes('run.pull_requests')) &&
    propertyAccesses.some((access) => access.includes('run.run_attempt')) &&
    hasJobsAttemptLookup &&
    ['number', 'head_sha', 'base_sha', 'action', 'title'].every((name) => outputNames.has(name))
  )
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
    // CODEOWNERS review authorizes control-plane edits; Integrity validates their safety.
    if (stableCheck && !hasStableJobName(document, stableCheck)) {
      violations.push({
        path: file.path,
        rule: 'stable-required-check',
        message: `Required job must remain ${stableCheck.jobId} with name ${stableCheck.name}`
      })
    }
    if (stableCheck) {
      const missing = missingRequiredTriggers(document, stableCheck)
      if (missing.length > 0) {
        violations.push({
          path: file.path,
          rule: 'required-check-triggers',
          message: `Required workflow must keep its triggers: ${missing.join(', ')}`
        })
      }
    }
  }

  violations.push(...prAutomationSupportViolations(files))

  return {
    ok: violations.length === 0,
    inspectedFiles: files.map(({ path }) => path).sort(),
    violations
  }
}

function prAutomationSupportViolations(files) {
  const documents = new Map()
  for (const path of [integrityWorkflowPath, signalWorkflowPath, resolverWorkflowPath]) {
    try {
      documents.set(path, load(files.find((file) => file.path === path)?.headText ?? ''))
    } catch {
      // Changed malformed YAML is reported above; missing support still fails below.
    }
  }
  const integrity = documents.get(integrityWorkflowPath)
  if (!workflowTriggers(integrity).workflow_run?.workflows?.includes('PR Automation Signal'))
    return []
  const signal = documents.get(signalWorkflowPath)
  const resolver = documents.get(resolverWorkflowPath)
  const trigger = workflowTriggers(signal).pull_request
  const job = workflowJobs(signal).signal
  const validSignal =
    signal?.name === 'PR Automation Signal' &&
    signal['run-name'] === 'PR automation (${{ github.event.action }})' &&
    trigger?.branches?.length === 1 &&
    trigger.branches[0] === 'main' &&
    !['paths', 'paths-ignore', 'branches-ignore'].some((key) => Object.hasOwn(trigger, key)) &&
    signalActivities.every((activity) => triggerTypes(trigger).includes(activity)) &&
    signal.permissions &&
    typeof signal.permissions === 'object' &&
    !Array.isArray(signal.permissions) &&
    Object.keys(signal.permissions).length === 0 &&
    job?.name === 'Signal PR automation' &&
    !Object.hasOwn(job, 'if') &&
    !Object.hasOwn(job, 'permissions') &&
    job.steps?.length === 1 &&
    job.steps[0]?.run === 'true' &&
    !Object.hasOwn(job.steps[0], 'if')
  const resolverJob = workflowJobs(resolver).resolve
  const resolverStep = resolverJob?.steps?.find(
    (step) =>
      step &&
      typeof step === 'object' &&
      step.with &&
      typeof step.with === 'object' &&
      typeof step.with.script === 'string'
  )
  const resolverScript = resolverStep?.with?.script ?? ''
  const resolverCall = workflowTriggers(resolver).workflow_call
  const resolverOutputNames = ['number', 'head_sha', 'base_sha', 'action', 'title']
  const resolverOutputWiring = resolverOutputNames.every(
    (name) =>
      resolverCall?.outputs?.[name]?.value === `\${{ jobs.resolve.outputs.${name} }}` &&
      resolverJob?.outputs?.[name] === `\${{ steps.resolve.outputs.${name} }}`
  )
  const validResolver =
    resolverCall?.inputs?.run_id?.required === true &&
    resolverJob &&
    typeof resolverJob === 'object' &&
    !Object.hasOwn(resolverJob, 'if') &&
    resolverJob.permissions?.actions === 'read' &&
    resolverJob.permissions?.['pull-requests'] === 'read' &&
    resolverJob.steps?.length === 1 &&
    resolverStep &&
    resolverStep.uses === 'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3' &&
    !Object.hasOwn(resolverStep, 'if') &&
    resolverOutputWiring &&
    resolverScriptHasTrustedContract(resolverScript)
  const integrityJob = workflowJobs(integrity).integrity
  const integrityJobText = JSON.stringify(integrityJob ?? '')
  const integrityResolverJob = workflowJobs(integrity).resolve
  const needs = integrityJob?.needs
  const integrityConsumesResolver =
    (Array.isArray(needs) ? needs : [needs]).includes('resolve') &&
    [
      'needs.resolve.outputs.number',
      'needs.resolve.outputs.head_sha',
      'needs.resolve.outputs.base_sha',
      'needs.resolve.outputs.title'
    ].every((reference) => integrityJobText.includes(reference))
  const validIntegrityConsumer =
    integrityResolverJob?.uses === `./${resolverWorkflowPath}` && integrityConsumesResolver
  return [
    ...(!validSignal
      ? [
          {
            path: signalWorkflowPath,
            rule: 'pr-automation-support',
            message:
              'CI Integrity requires the permissionless PR Automation Signal and its complete PR trigger.'
          }
        ]
      : []),
    ...(!validResolver || !validIntegrityConsumer
      ? [
          {
            path: resolverWorkflowPath,
            rule: 'pr-automation-support',
            message:
              'CI Integrity must execute the complete trusted PR resolver and consume its validated outputs before inspection.'
          }
        ]
      : [])
  ]
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
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

export function ciIntegrityFilesFromRevisions(base, head, { cwd = process.cwd() } = {}) {
  const mergeBase = execFileSync('git', ['merge-base', base, head], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER
  }).trim()
  const diff = execFileSync('git', ['diff', '--name-status', '-z', mergeBase, head], {
    cwd,
    maxBuffer: GIT_OUTPUT_MAX_BUFFER
  })
  const files = parseNameStatus(diff.toString('utf8'))
    .filter(({ path, previousPath }) => [path, previousPath].filter(Boolean).some(isGuardedPath))
    .map(({ path, previousPath }) => ({
      path,
      previousPath,
      baseText: textAtRevision(mergeBase, previousPath ?? path, cwd),
      headText: textAtRevision(head, path, cwd)
    }))
  const integrityText = textAtRevision(head, integrityWorkflowPath, cwd)
  let successor = false
  try {
    successor = workflowTriggers(load(integrityText)).workflow_run?.workflows?.includes(
      'PR Automation Signal'
    )
  } catch {
    // The changed-workflow YAML guard reports malformed candidates.
  }
  if (successor) {
    // Validate unchanged support too: a later PR may delete or disable only the signal.
    for (const path of [integrityWorkflowPath, signalWorkflowPath, resolverWorkflowPath]) {
      if (!files.some((file) => file.path === path))
        files.push({
          path,
          baseText: textAtRevision(mergeBase, path, cwd),
          headText: path === integrityWorkflowPath ? integrityText : textAtRevision(head, path, cwd)
        })
    }
  }
  return files
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

### Verified consumer retirements

${(result.retiredConsumers ?? []).map((entry) => `- <code>${escapeHtml(entry)}</code>`).join('\n') || '- None'}

### Dependency-model consumer retirements (opaque cones may remain)

${(result.dependencyBasedRetirements ?? []).map((entry) => `- <code>${escapeHtml(entry)}</code>`).join('\n') || '- None'}

### Verified excluded package test retirements

${(result.retiredPackageTests ?? []).map((entry) => `- <code>${escapeHtml(entry)}</code>`).join('\n') || '- None'}

### Historical module ownership gaps (nonblocking)

${(result.legacyGaps ?? []).map((path) => `- <code>${escapeHtml(path)}</code>`).join('\n') || '- None'}

### Verified bounded owner splits

${(result.boundedOwnerSplits ?? []).map((entry) => `- <code>${escapeHtml(entry)}</code>`).join('\n') || '- None'}
`
}

export function runCiIntegrityCli(arguments_ = process.argv.slice(2), environment = process.env) {
  const base = requireCommit(argumentValue(arguments_, '--base') ?? environment.BASE_SHA, '--base')
  const head = requireCommit(argumentValue(arguments_, '--head') ?? environment.HEAD_SHA, '--head')
  const result = checkCiIntegrityChanges(ciIntegrityFilesFromRevisions(base, head))
  const ownership = moduleOwnershipFromRevisions(base, head)
  result.violations.push(...ownership.violations)
  try {
    checkDerivedConsumerRevisions(base, head)
  } catch (error) {
    result.violations.push({
      path: 'scripts/ci/module-derived-consumers.json',
      rule: 'derived-consumer-evidence',
      message: error.message
    })
  }
  result.legacyGaps = ownership.legacyGaps
  result.retiredConsumers = ownership.retiredConsumers
  result.dependencyBasedRetirements = ownership.dependencyBasedRetirements
  result.retiredPackageTests = ownership.retiredPackageTests
  result.boundedOwnerSplits = ownership.boundedOwnerSplits
  result.ok = result.ok && ownership.ok && result.violations.length === 0

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
