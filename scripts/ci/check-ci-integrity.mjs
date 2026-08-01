/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from 'js-yaml'

import { parseNameStatus } from './classify-pr-changes.mjs'

function actionReferences(text) {
  const references = new Set()
  const pattern = /^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)['"]?/gm
  for (const match of text.matchAll(pattern)) references.add(match[1])
  return references
}

function isImmutableActionReference(reference) {
  if (reference.startsWith('./')) return true
  if (reference.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/i.test(reference)
  return /@[0-9a-f]{40}$/i.test(reference)
}

function withoutCommentLines(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

function executesPullRequestHead(text) {
  const workflow = withoutCommentLines(text)
  if (!/\bpull_request_target\b/.test(workflow)) return false

  return [
    /github\.event\.pull_request\.head\.(?:sha|ref)/,
    /\bgithub\.head_ref\b/,
    /\bgh\s+pr\s+checkout\b/,
    /\bgit\s+(?:checkout|switch)\b[^\n]*(?:head|pull\/)/i
  ].some((pattern) => pattern.test(workflow))
}

function writePermissions(text) {
  const permissions = new Set()
  const workflow = withoutCommentLines(text)
  if (/^\s*permissions:\s*write-all\s*$/m.test(workflow)) permissions.add('write-all')
  for (const match of workflow.matchAll(/^\s*([a-z-]+):\s*write\s*$/gm)) {
    permissions.add(match[1])
  }
  return permissions
}

const stableChecks = {
  '.github/workflows/pr-gate.yml': { jobId: 'gate', name: 'PR Gate' },
  '.github/workflows/ci-integrity.yml': { jobId: 'integrity', name: 'CI Integrity' }
}

function isWorkflowPath(path) {
  return /^\.github\/workflows\/.*\.ya?ml$/i.test(path)
}

function isActionDefinitionPath(path) {
  return /^\.github\/actions\/.*\/action\.ya?ml$/i.test(path)
}

function hasStableJobName(text, { jobId, name }) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === `  ${jobId}:`)
  if (start === -1) return false

  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}\S/.test(lines[index])) return false
    if (lines[index].trimEnd() === `    name: ${name}`) return true
  }
  return false
}

export function checkCiIntegrityChanges(files) {
  const violations = []

  for (const file of files) {
    const headText = file.headText ?? ''
    const workflow = isWorkflowPath(file.path)
    const executableYaml = workflow || isActionDefinitionPath(file.path)

    if (workflow && headText) {
      try {
        load(headText)
      } catch (error) {
        violations.push({
          path: file.path,
          rule: 'valid-workflow-yaml',
          message: error instanceof Error ? error.message.split('\n', 1)[0] : 'Invalid YAML'
        })
      }
    }

    if (executableYaml) {
      for (const reference of actionReferences(headText)) {
        if (!isImmutableActionReference(reference)) {
          violations.push({
            path: file.path,
            rule: 'immutable-action-reference',
            message: `New action reference must use an immutable full commit SHA: ${reference}`
          })
        }
      }
    }

    if (workflow && executesPullRequestHead(headText)) {
      violations.push({
        path: file.path,
        rule: 'no-pr-head-execution',
        message: 'pull_request_target workflows must never checkout or execute PR-head code'
      })
    }
    if (workflow && /\bpull_request_target\b/.test(withoutCommentLines(headText))) {
      const baseWritePermissions = writePermissions(file.baseText ?? '')
      for (const permission of writePermissions(headText)) {
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
    if (stableCheck && file.baseText && headText !== file.baseText) {
      violations.push({
        path: file.path,
        rule: 'protected-gate-control-plane',
        message:
          'Established required workflows may change only through an explicit maintainer ruleset bypass'
      })
    }
    if (stableCheck && !hasStableJobName(headText, stableCheck)) {
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
  const diff = execFileSync('git', ['diff', '--name-status', '-z', base, head], { cwd })
  return parseNameStatus(diff.toString('utf8'))
    .filter(({ path, previousPath }) => [path, previousPath].filter(Boolean).some(isGuardedPath))
    .map(({ path, previousPath }) => ({
      path,
      previousPath,
      baseText: textAtRevision(base, previousPath ?? path, cwd),
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
