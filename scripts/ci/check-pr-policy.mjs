/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const allowedTypes = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert'
]

const subjectPattern = new RegExp(
  `^(${allowedTypes.join('|')})\\([a-z][A-Za-z0-9-]*\\)!?: [a-z][^\\r\\n]*$`
)

export function checkPrPolicy({
  eventName,
  title,
  commitSubjects = [],
  commitMessages = commitSubjects,
  scope = 'all'
}) {
  if (eventName !== 'pull_request') return { ok: true, violations: [] }

  const violations = []
  if (scope !== 'commits' && !subjectPattern.test(title ?? '')) {
    violations.push({ kind: 'title', subject: title ?? '' })
  }
  if (scope !== 'title') {
    for (const [index, subject] of commitSubjects.entries()) {
      if (!subjectPattern.test(subject)) violations.push({ kind: 'commit', subject })
      if (/\)!:/.test(subject) && !/^BREAKING CHANGE:\s+\S.*$/m.test(commitMessages[index] ?? '')) {
        violations.push({ kind: 'breaking-change-footer', subject })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

function requireCommit(value, name) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} must be a full 40-character Git commit SHA`)
  }
  return value
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function formatPrPolicySummary(result) {
  const violations =
    result.violations.length === 0
      ? '- None'
      : result.violations
          .map(
            ({ kind, subject }) =>
              `- Invalid ${escapeHtml(kind)}: <code>${escapeHtml(subject)}</code>`
          )
          .join('\n')
  return `## PR policy

Result: **${result.ok ? 'pass' : 'fail'}**

${violations}
`
}

export function runPrPolicyCli(environment = process.env) {
  const eventName = environment.EVENT_NAME ?? ''
  const scope = environment.POLICY_SCOPE ?? 'all'
  if (!['all', 'commits', 'title'].includes(scope)) {
    throw new Error('POLICY_SCOPE must be one of: all, commits, title')
  }
  let commitSubjects = []
  let commitMessages = []

  if (eventName === 'pull_request' && scope !== 'title') {
    const base = requireCommit(environment.BASE_SHA, 'BASE_SHA')
    const head = requireCommit(environment.HEAD_SHA, 'HEAD_SHA')
    const commitHashes = execFileSync('git', ['log', '--format=%H', `${base}..${head}`], {
      encoding: 'utf8'
    })
      .split('\n')
      .filter(Boolean)
    commitSubjects = commitHashes.map((commit) =>
      execFileSync('git', ['show', '-s', '--format=%s', commit], { encoding: 'utf8' }).trimEnd()
    )
    commitMessages = commitHashes.map((commit) =>
      execFileSync('git', ['show', '-s', '--format=%B', commit], { encoding: 'utf8' }).trimEnd()
    )
  }

  const result = checkPrPolicy({
    eventName,
    title: environment.PR_TITLE ?? '',
    commitSubjects,
    commitMessages,
    scope
  })
  const summary = formatPrPolicySummary(result)
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary)
  else process.stdout.write(summary)
  if (!result.ok) process.exitCode = 1
  return result
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    runPrPolicyCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
