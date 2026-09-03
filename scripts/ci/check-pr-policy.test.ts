import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkDatabaseMigrationPolicy, checkPrPolicy } from './check-pr-policy.mjs'

const baselineMigrations = [
  'src/main/database/migrations/0001-runtime-schema-baseline.ts',
  'src/main/database/migrations/0002-project-agent-context.ts'
]
const nextMigrationPath = 'src/main/database/migrations/0003-project-label.ts'
const nextMigrationSource = `const projectLabelMigration = {
  id: '0003_project_label',
  statements: [],
  verifiers: []
}
`
const baseMigrationServiceSource = `import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
import { projectAgentContextMigration } from './migrations/0002-project-agent-context'
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration },
  { ...projectAgentContextMigration }
] as const satisfies readonly MigrationManifestEntry[]
`
const migrationServiceSource = `import { projectLabelMigration } from './migrations/0003-project-label'
import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
import { projectAgentContextMigration } from './migrations/0002-project-agent-context'
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration },
  { ...projectAgentContextMigration },
  { ...projectLabelMigration }
] as const satisfies readonly MigrationManifestEntry[]
`

describe('pull request policy', () => {
  it('requires schema contract changes to add and register the next migration version', () => {
    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: 'prisma/schema.prisma', status: 'modified' }],
        baseMigrationPaths: baselineMigrations
      })
    ).toEqual([
      expect.objectContaining({ subject: expect.stringContaining('without a new migration') })
    ])

    expect(
      checkDatabaseMigrationPolicy({
        changes: [
          { path: 'prisma/schema.prisma', status: 'modified' },
          { path: nextMigrationPath, status: 'added' }
        ],
        baseMigrationPaths: baselineMigrations,
        baseFiles: { 'src/main/database/migration-service.ts': baseMigrationServiceSource },
        headFiles: {
          [nextMigrationPath]: nextMigrationSource,
          'src/main/database/migration-service.ts': migrationServiceSource
        }
      })
    ).toEqual([])
  })

  it('allows comment-only schema documentation changes without a migration', () => {
    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: 'prisma/schema.prisma', status: 'modified' }],
        baseMigrationPaths: baselineMigrations,
        baseFiles: {
          'prisma/schema.prisma': '// Phase 1 placeholder\nmodel Project { id String @id }\n'
        },
        headFiles: {
          'prisma/schema.prisma': '// Current project record.\nmodel Project { id String @id }\n'
        }
      })
    ).toEqual([])
  })

  it('keeps released migrations immutable', () => {
    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: baselineMigrations[1], status: 'modified' }],
        baseMigrationPaths: baselineMigrations
      })
    ).toEqual([expect.objectContaining({ subject: expect.stringContaining('is immutable') })])
  })

  it('rejects skipped and mismatched migration versions', () => {
    const path = 'src/main/database/migrations/0004-project-label.ts'
    const violations = checkDatabaseMigrationPolicy({
      changes: [{ path, status: 'added' }],
      baseMigrationPaths: baselineMigrations,
      headFiles: {
        [path]: nextMigrationSource,
        'src/main/database/migration-service.ts': ''
      }
    })

    expect(violations.map(({ subject }) => subject)).toEqual([
      expect.stringContaining('next migration version 0003'),
      expect.stringContaining('must declare migration id 0004_project_label')
    ])
  })

  it('rejects unversioned and unregistered migration files', () => {
    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: 'src/main/database/migrations/project-label.ts', status: 'added' }],
        baseMigrationPaths: baselineMigrations
      })
    ).toEqual([
      expect.objectContaining({ subject: expect.stringContaining('NNNN-lowercase-description.ts') })
    ])

    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: nextMigrationPath, status: 'added' }],
        baseMigrationPaths: baselineMigrations,
        headFiles: { [nextMigrationPath]: nextMigrationSource }
      })
    ).toEqual([
      expect.objectContaining({
        subject: expect.stringContaining('registered in MIGRATION_MANIFEST')
      })
    ])
  })

  it('requires new migrations to append after the unchanged manifest prefix', () => {
    const reversedServiceSource = `import { projectLabelMigration } from './migrations/0003-project-label'
const MIGRATION_MANIFEST = [
  { ...projectLabelMigration },
  { ...runtimeSchemaBaselineMigration },
  { ...projectAgentContextMigration }
] as const satisfies readonly MigrationManifestEntry[]
`

    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: nextMigrationPath, status: 'added' }],
        baseMigrationPaths: baselineMigrations,
        baseFiles: { 'src/main/database/migration-service.ts': baseMigrationServiceSource },
        headFiles: {
          [nextMigrationPath]: nextMigrationSource,
          'src/main/database/migration-service.ts': reversedServiceSource
        }
      })
    ).toEqual([
      expect.objectContaining({ subject: expect.stringContaining('preserve existing entries') })
    ])
  })

  it('keeps every existing migration manifest entry immutable', () => {
    const baseSource = `const MIGRATION_MANIFEST = [
  {
    ...runtimeSchemaBaselineMigration,
    checksum: BASELINE_CHECKSUM,
    backupOnApply: 'required'
  }
] as const satisfies readonly MigrationManifestEntry[]
`
    const changedSource = baseSource.replace("backupOnApply: 'required'", "backupOnApply: 'none'")

    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: 'src/main/database/migration-service.ts', status: 'modified' }],
        baseMigrationPaths: baselineMigrations,
        baseFiles: { 'src/main/database/migration-service.ts': baseSource },
        headFiles: { 'src/main/database/migration-service.ts': changedSource }
      })
    ).toEqual([
      expect.objectContaining({ subject: expect.stringContaining('preserve existing entries') })
    ])
  })

  it('keeps imports for existing migration manifest entries immutable', () => {
    const baseSource = `import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration }
] as const satisfies readonly MigrationManifestEntry[]
`
    const changedSource = baseSource.replace(
      './migrations/0001-runtime-schema-baseline',
      './migrations/0002-project-agent-context'
    )

    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: 'src/main/database/migration-service.ts', status: 'modified' }],
        baseMigrationPaths: baselineMigrations,
        baseFiles: { 'src/main/database/migration-service.ts': baseSource },
        headFiles: { 'src/main/database/migration-service.ts': changedSource }
      })
    ).toEqual([
      expect.objectContaining({ subject: expect.stringContaining('preserve existing entries') })
    ])
  })

  it('does not accept migration declarations and registrations found only in comments', () => {
    expect(
      checkDatabaseMigrationPolicy({
        changes: [{ path: nextMigrationPath, status: 'added' }],
        baseMigrationPaths: baselineMigrations,
        baseFiles: { 'src/main/database/migration-service.ts': baseMigrationServiceSource },
        headFiles: {
          [nextMigrationPath]: "// const projectLabelMigration = { id: '0003_project_label' }\n",
          'src/main/database/migration-service.ts': `// import { projectLabelMigration } from './migrations/0003-project-label'
const MIGRATION_MANIFEST = [
  // { ...projectLabelMigration }
] as const satisfies readonly MigrationManifestEntry[]
`
        }
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: expect.stringContaining('declare migration id') }),
        expect.objectContaining({ subject: expect.stringContaining('preserve existing entries') })
      ])
    )
  })

  it('validates commit subjects from the Git revision CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-policy-'))
    const summary = join(root, 'summary')

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'chore(fixture): add baseline'], {
        cwd: root
      })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      writeFileSync(join(root, 'README.md'), '# updated fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync(
        'git',
        [
          'commit',
          '--quiet',
          '-m',
          'feat(api)!: remove legacy session endpoint',
          '-m',
          'BREAKING CHANGE: remove the legacy session endpoint.'
        ],
        { cwd: root }
      )
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const result = spawnSync(process.execPath, [resolve('scripts/ci/check-pr-policy.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_SHA: base,
          EVENT_NAME: 'pull_request',
          GITHUB_STEP_SUMMARY: summary,
          HEAD_SHA: head,
          PR_TITLE: 'feat(api): update the session endpoint'
        }
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(summary, 'utf8')).toContain('Result: **pass**')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects an unversioned schema contract change from the Git revision CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'database-migration-policy-'))
    const summary = join(root, 'summary')

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      mkdirSync(join(root, 'prisma'), { recursive: true })
      mkdirSync(join(root, 'src/main/database/migrations'), { recursive: true })
      writeFileSync(join(root, 'prisma/schema.prisma'), 'model Probe { id String @id }\n')
      writeFileSync(
        join(root, 'src/main/database/migrations/0001-runtime-schema-baseline.ts'),
        "const baseline = { id: '0001_runtime_schema_baseline' }\n"
      )
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'chore(fixture): add baseline'], {
        cwd: root
      })
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      writeFileSync(
        join(root, 'prisma/schema.prisma'),
        'model Probe { id String @id, value String }\n'
      )
      execFileSync('git', ['add', 'prisma/schema.prisma'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'feat(database): add probe value'], {
        cwd: root
      })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const result = spawnSync(process.execPath, [resolve('scripts/ci/check-pr-policy.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_SHA: base,
          EVENT_NAME: 'pull_request',
          GITHUB_STEP_SUMMARY: summary,
          HEAD_SHA: head,
          POLICY_SCOPE: 'commits'
        }
      })

      expect(result.status, result.stderr).toBe(1)
      expect(readFileSync(summary, 'utf8')).toContain(
        'database schema contracts changed without a new migration'
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('uses the current target base when choosing the next migration version', () => {
    const root = mkdtempSync(join(tmpdir(), 'database-migration-target-base-'))

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root })
      mkdirSync(join(root, 'prisma'), { recursive: true })
      mkdirSync(join(root, 'src/main/database/migrations'), { recursive: true })
      writeFileSync(join(root, 'prisma/schema.prisma'), 'model Probe { id String @id }\n')
      writeFileSync(
        join(root, 'src/main/database/migrations/0001-runtime-schema-baseline.ts'),
        "const runtimeSchemaBaselineMigration = { id: '0001_runtime_schema_baseline' }\n"
      )
      writeFileSync(
        join(root, 'src/main/database/migration-service.ts'),
        `import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration }
] as const satisfies readonly MigrationManifestEntry[]
`
      )
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'chore(fixture): add baseline'], {
        cwd: root
      })
      const common = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: root })
      writeFileSync(
        join(root, 'prisma/schema.prisma'),
        'model Probe { id String @id, value String }\n'
      )
      writeFileSync(
        join(root, 'src/main/database/migrations/0002-feature-value.ts'),
        "const featureValueMigration = { id: '0002_feature_value' }\n"
      )
      writeFileSync(
        join(root, 'src/main/database/migration-service.ts'),
        `import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
import { featureValueMigration } from './migrations/0002-feature-value'
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration },
  { ...featureValueMigration }
] as const satisfies readonly MigrationManifestEntry[]
`
      )
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'feat(database): add feature value'], {
        cwd: root
      })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      execFileSync('git', ['checkout', '--quiet', '-b', 'target', common], { cwd: root })
      writeFileSync(
        join(root, 'src/main/database/migrations/0002-target-field.ts'),
        "const targetFieldMigration = { id: '0002_target_field' }\n"
      )
      writeFileSync(
        join(root, 'src/main/database/migration-service.ts'),
        `import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
import { targetFieldMigration } from './migrations/0002-target-field'
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration },
  { ...targetFieldMigration }
] as const satisfies readonly MigrationManifestEntry[]
`
      )
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'feat(database): add target field'], {
        cwd: root
      })
      const target = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim()

      const result = spawnSync(process.execPath, [resolve('scripts/ci/check-pr-policy.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_SHA: target,
          EVENT_NAME: 'pull_request',
          GITHUB_STEP_SUMMARY: '',
          HEAD_SHA: head,
          POLICY_SCOPE: 'commits'
        }
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.stdout).toContain('next migration version 0003')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('reports an invalid PR title and every invalid commit subject', () => {
    const result = checkPrPolicy({
      eventName: 'pull_request',
      title: 'Improve CI',
      commitSubjects: [
        'ci(gate): add aggregate result',
        'missing conventional format',
        'fix(Bad Scope): Uppercase description'
      ]
    })

    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      { kind: 'title', subject: 'Improve CI' },
      { kind: 'commit', subject: 'missing conventional format' },
      { kind: 'commit', subject: 'fix(Bad Scope): Uppercase description' }
    ])
  })

  it('can validate editable title policy separately from immutable commit policy', () => {
    expect(
      checkPrPolicy({
        eventName: 'pull_request',
        scope: 'title',
        title: 'Improve CI',
        commitSubjects: ['missing conventional format']
      }).violations
    ).toEqual([{ kind: 'title', subject: 'Improve CI' }])

    expect(
      checkPrPolicy({
        eventName: 'pull_request',
        scope: 'commits',
        title: 'Improve CI',
        commitSubjects: ['missing conventional format']
      }).violations
    ).toEqual([{ kind: 'commit', subject: 'missing conventional format' }])
  })

  it('validates a title-only CLI run without requiring Git revisions', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/ci/check-pr-policy.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        GITHUB_STEP_SUMMARY: '',
        POLICY_SCOPE: 'title',
        PR_TITLE: 'feat(ci): refresh pull request metadata'
      }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Result: **pass**')
  })

  it('rejects a breaking commit without the required footer', () => {
    const result = checkPrPolicy({
      eventName: 'pull_request',
      title: 'feat(api): update the session endpoint',
      commitSubjects: ['feat(api)!: remove legacy session endpoint'],
      commitMessages: ['feat(api)!: remove legacy session endpoint']
    })

    expect(result.violations).toContainEqual({
      kind: 'breaking-change-footer',
      subject: 'feat(api)!: remove legacy session endpoint'
    })
  })

  it('accepts a breaking commit with its required footer', () => {
    const subject = 'feat(api)!: remove legacy session endpoint'
    const result = checkPrPolicy({
      eventName: 'pull_request',
      title: 'feat(api): update the session endpoint',
      commitSubjects: [subject],
      commitMessages: [`${subject}\n\nBREAKING CHANGE: remove the legacy session endpoint.`]
    })

    expect(result).toEqual({ ok: true, violations: [] })
  })
})
