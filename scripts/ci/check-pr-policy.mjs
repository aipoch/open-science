/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseNameStatus } from './classify-pr-changes.mjs'
import { prismaSchemaFingerprint } from '../check-prisma-client.mjs'

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

const databaseSchemaPaths = new Set([
  'prisma/schema.prisma',
  'prisma/sqlite-check-constraints.json'
])
const migrationDirectory = 'src/main/database/migrations/'
const migrationServicePath = 'src/main/database/migration-service.ts'
const migrationPathPattern =
  /^src\/main\/database\/migrations\/(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/

const migrationVersion = (path) => Number(path.match(migrationPathPattern)?.[1])

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const sanitizePolicySource = (source, { maskStrings = false } = {}) => {
  let result = ''
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (state === 'line-comment') {
      if (character === '\n') {
        result += '\n'
        state = 'code'
      } else result += ' '
      continue
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        result += '  '
        index += 1
        state = 'code'
      } else result += character === '\n' ? '\n' : ' '
      continue
    }
    if (state === 'template') {
      if (character === '\\' && next) {
        result += '  '
        index += 1
      } else if (character === '`') {
        result += '`'
        state = 'code'
      } else result += character === '\n' ? '\n' : ' '
      continue
    }
    if (state === 'single-quote' || state === 'double-quote') {
      const quote = state === 'single-quote' ? "'" : '"'
      if (character === '\\' && next) {
        result += maskStrings ? '  ' : `${character}${next}`
        index += 1
      } else {
        result += maskStrings && character !== quote ? ' ' : character
        if (character === quote) state = 'code'
      }
      continue
    }

    if (character === '/' && next === '/') {
      result += '  '
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      result += '  '
      index += 1
      state = 'block-comment'
    } else if (character === '`') {
      result += '`'
      state = 'template'
    } else if (character === "'") {
      result += character
      state = 'single-quote'
    } else if (character === '"') {
      result += character
      state = 'double-quote'
    } else result += character
  }
  return result
}

const manifestEntries = (source) => {
  const sanitized = sanitizePolicySource(source, { maskStrings: true })
  const match = sanitized.match(
    /(?:^|\n)\s*const MIGRATION_MANIFEST = \[([\s\S]*?)\]\s+as const satisfies/m
  )
  if (!match) return []

  const bodyStart = match.index + match[0].indexOf('[') + 1
  const bodyEnd = bodyStart + match[1].length
  const entries = []
  const depth = { brace: 0, bracket: 0, parenthesis: 0 }
  let entryStart = bodyStart
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    switch (sanitized[index]) {
      case '{':
        depth.brace += 1
        break
      case '}':
        depth.brace -= 1
        break
      case '[':
        depth.bracket += 1
        break
      case ']':
        depth.bracket -= 1
        break
      case '(':
        depth.parenthesis += 1
        break
      case ')':
        depth.parenthesis -= 1
        break
      case ',':
        if (depth.brace === 0 && depth.bracket === 0 && depth.parenthesis === 0) {
          const entry = source.slice(entryStart, index).trim()
          if (entry) entries.push(entry)
          entryStart = index + 1
        }
        break
    }
  }
  const finalEntry = source.slice(entryStart, bodyEnd).trim()
  if (finalEntry) entries.push(finalEntry)
  return entries
}

const manifestMigrationNames = (source) =>
  manifestEntries(source).flatMap((entry) =>
    [
      ...sanitizePolicySource(entry, { maskStrings: true }).matchAll(/\.\.\.([A-Za-z_$][\w$]*)\b/g)
    ].map((match) => match[1])
  )

const namedImports = (source) => {
  const imports = new Map()
  const sanitized = sanitizePolicySource(source)
  for (const match of sanitized.matchAll(
    /(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm
  )) {
    for (const specifier of match[1].split(',')) {
      const names = specifier
        .trim()
        .match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (names) imports.set(names[2] ?? names[1], `${names[1]}\0${match[2]}`)
    }
  }
  return imports
}

export function checkDatabaseMigrationPolicy({
  changes,
  baseMigrationPaths,
  baseFiles = {},
  headFiles = {}
}) {
  const violations = []
  const basePaths = new Set(baseMigrationPaths)
  const changedSchemaPaths = new Set(
    changes.flatMap(({ path, previousPath }) =>
      [path, previousPath].filter((candidate) => databaseSchemaPaths.has(candidate))
    )
  )
  const schemaContractChanged = [...changedSchemaPaths].some((path) => {
    const baseSource = baseFiles[path]
    const headSource = headFiles[path]
    return (
      baseSource === undefined ||
      headSource === undefined ||
      prismaSchemaFingerprint(baseSource) !== prismaSchemaFingerprint(headSource)
    )
  })
  const addedPaths = changes
    .filter(
      ({ path, status }) =>
        path.startsWith(migrationDirectory) &&
        !basePaths.has(path) &&
        ['added', 'copied', 'renamed'].includes(status)
    )
    .map(({ path }) => path)

  for (const { path, previousPath, status } of changes) {
    const changedReleasedPath =
      (basePaths.has(path) && status !== 'copied') ||
      (basePaths.has(previousPath) && ['deleted', 'renamed'].includes(status))
    if (changedReleasedPath) {
      violations.push({
        kind: 'database-migration',
        subject: `${previousPath ?? path} is immutable; add a new versioned migration instead`
      })
    }
  }

  if (schemaContractChanged && addedPaths.length === 0) {
    violations.push({
      kind: 'database-migration',
      subject: `database schema contracts changed without a new migration under ${migrationDirectory}`
    })
  }

  const baseVersions = baseMigrationPaths.map(migrationVersion).filter(Number.isInteger)
  let expectedVersion = Math.max(0, ...baseVersions) + 1
  const versionedPaths = []
  for (const path of addedPaths) {
    const match = path.match(migrationPathPattern)
    if (!match) {
      violations.push({
        kind: 'database-migration',
        subject: `${path} must use the NNNN-lowercase-description.ts format`
      })
      continue
    }
    versionedPaths.push({ path, version: Number(match[1]), description: match[2] })
  }

  const serviceSource = sanitizePolicySource(headFiles[migrationServicePath] ?? '')
  const headManifestNames = manifestMigrationNames(headFiles[migrationServicePath] ?? '')
  const addedMigrationNames = []
  for (const { path, version, description } of versionedPaths.sort(
    (left, right) => left.version - right.version || left.path.localeCompare(right.path)
  )) {
    if (version !== expectedVersion) {
      violations.push({
        kind: 'database-migration',
        subject: `${path} must use the next migration version ${String(expectedVersion).padStart(4, '0')}`
      })
    }
    expectedVersion += 1

    const migrationSource = sanitizePolicySource(headFiles[path] ?? '')
    const declaration = migrationSource.match(
      /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^}]*\bid:\s*['"]([^'"]+)['"]/m
    )
    const expectedId = `${String(version).padStart(4, '0')}_${description.replaceAll('-', '_')}`
    if (!declaration || declaration[2] !== expectedId) {
      violations.push({
        kind: 'database-migration',
        subject: `${path} must declare migration id ${expectedId}`
      })
      continue
    }

    const migrationName = declaration[1]
    addedMigrationNames.push(migrationName)
    const moduleName = path.slice(migrationDirectory.length, -3)
    const importPattern = new RegExp(
      `(?:^|\\n)\\s*import\\s*\\{[^}]*\\b${escapeRegularExpression(migrationName)}\\b[^}]*\\}\\s*from\\s*['"]\\.\\/migrations\\/${escapeRegularExpression(moduleName)}['"]`,
      'm'
    )
    if (!importPattern.test(serviceSource) || !headManifestNames.includes(migrationName)) {
      violations.push({
        kind: 'database-migration',
        subject: `${path} must be imported and registered in MIGRATION_MANIFEST`
      })
    }
  }

  if (Object.hasOwn(baseFiles, migrationServicePath)) {
    const baseServiceSource = baseFiles[migrationServicePath]
    const baseManifestEntries = manifestEntries(baseServiceSource)
    const headManifestEntries = manifestEntries(headFiles[migrationServicePath] ?? '')
    const baseManifestNames = manifestMigrationNames(baseServiceSource)
    const expectedManifestNames = [...baseManifestNames, ...addedMigrationNames]
    const baseImports = namedImports(baseServiceSource)
    const headImports = namedImports(headFiles[migrationServicePath] ?? '')
    if (
      headManifestEntries.length !== baseManifestEntries.length + addedMigrationNames.length ||
      baseManifestEntries.some((entry, index) => headManifestEntries[index] !== entry) ||
      baseManifestNames.some((name) => baseImports.get(name) !== headImports.get(name)) ||
      expectedManifestNames.length !== headManifestNames.length ||
      expectedManifestNames.some((name, index) => headManifestNames[index] !== name)
    ) {
      violations.push({
        kind: 'database-migration',
        subject:
          'MIGRATION_MANIFEST must preserve existing entries and imports exactly and append new migrations in version order'
      })
    }
  }

  return violations
}

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

const readRevisionFiles = (revision, paths) =>
  Object.fromEntries(
    [...paths].flatMap((path) => {
      try {
        return [
          [
            path,
            execFileSync('git', ['show', `${revision}:${path}`], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore']
            })
          ]
        ]
      } catch {
        return []
      }
    })
  )

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
  let databaseMigrationViolations = []

  if (['pull_request', 'merge_group'].includes(eventName) && scope !== 'title') {
    const base = requireCommit(environment.BASE_SHA, 'BASE_SHA')
    const head = requireCommit(environment.HEAD_SHA, 'HEAD_SHA')
    const mergeBase = execFileSync('git', ['merge-base', base, head], {
      encoding: 'utf8'
    }).trim()
    const changes = parseNameStatus(
      execFileSync('git', ['diff', '--name-status', '-z', mergeBase, head]).toString('utf8')
    )
    const baseMigrationPaths = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', base, '--', migrationDirectory],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean)
    const addedMigrationPaths = changes
      .filter(
        ({ path, status }) =>
          path.startsWith(migrationDirectory) &&
          !baseMigrationPaths.includes(path) &&
          ['added', 'copied', 'renamed'].includes(status)
      )
      .map(({ path }) => path)
    const headPaths = new Set(addedMigrationPaths)
    const changedSchemaPaths = new Set(
      changes.flatMap(({ path, previousPath }) =>
        [path, previousPath].filter((candidate) => databaseSchemaPaths.has(candidate))
      )
    )
    for (const path of changedSchemaPaths) headPaths.add(path)
    const serviceChanged = changes.some(({ path, previousPath }) =>
      [path, previousPath].includes(migrationServicePath)
    )
    if (addedMigrationPaths.length > 0 || serviceChanged) headPaths.add(migrationServicePath)
    const headFiles = readRevisionFiles(head, headPaths)
    const baseFiles = readRevisionFiles(mergeBase, changedSchemaPaths)
    if (headPaths.has(migrationServicePath)) {
      Object.assign(baseFiles, readRevisionFiles(base, [migrationServicePath]))
    }
    databaseMigrationViolations = checkDatabaseMigrationPolicy({
      changes,
      baseMigrationPaths,
      baseFiles,
      headFiles
    })

    if (eventName === 'pull_request') {
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
  }

  const result = checkPrPolicy({
    eventName,
    title: environment.PR_TITLE ?? '',
    commitSubjects,
    commitMessages,
    scope
  })
  result.violations.push(...databaseMigrationViolations)
  result.ok = result.violations.length === 0
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
