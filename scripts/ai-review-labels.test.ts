import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { checkCiIntegrityChanges } from './ci/check-ci-integrity.mjs'

import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'

// Behavior tests execute the exact inline github-script blocks shipped by the label lifecycle and
// AI review workflows instead of reimplementing their logic.
type WorkflowJob = {
  steps: { with?: { script?: string }; uses?: string; run?: string }[]
  permissions?: Record<string, string>
  concurrency?: { group: string; 'cancel-in-progress': boolean }
  if?: string
}
type Workflow = {
  jobs: Record<string, WorkflowJob>
  on: Record<string, unknown>
}
const catalogText = readFileSync(join(process.cwd(), '.github/labels.json'), 'utf8')
const catalog = JSON.parse(catalogText) as {
  name: string
  color: string
  description: string
  type?: string
}[]
const syncWorkflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/sync-labels.yml'), 'utf8')
) as Workflow
const labelsWorkflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ai-review-labels.yml'), 'utf8')
) as Workflow
const reviewWorkflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ai-review-single.yml'), 'utf8')
) as Workflow

type MockFn = ReturnType<typeof vi.fn>
type MockCore = {
  notice: MockFn
  warning: MockFn
  setFailed: MockFn
  info: MockFn
  summary: Record<string, MockFn>
}
type Context = {
  repo: { owner: string; repo: string }
  payload: Record<string, unknown>
  sha?: string
}
type ChangedFile = {
  filename: string
  additions: number
  deletions: number
  previous_filename?: string
}

function makeGithub({
  prHeadSha = 'sha1',
  prState = 'open',
  labels = [] as string[],
  pr = {} as Record<string, unknown>,
  files = [{ filename: 'README.md', additions: 1, deletions: 0 }] as ChangedFile[],
  definitions = catalog as { name: string; color: string; description: string }[]
} = {}): { github: MockGithub; added: string[][]; removed: string[]; created: string[] } {
  const added: string[][] = []
  const removed: string[] = []
  const created: string[] = []
  const github = {
    paginate: vi.fn(),
    rest: {
      repos: {
        getContent: vi.fn(async () => ({
          data: { content: Buffer.from(catalogText).toString('base64') }
        }))
      },
      pulls: {
        get: vi.fn(async () => ({
          data: {
            title: 'feat(ai-review): add thing',
            head: { sha: prHeadSha, ref: 'feat/ai-review-thing' },
            base: { sha: 'base1' },
            state: prState,
            changed_files: files.length,
            ...pr
          }
        })),
        listFiles: vi.fn()
      },
      issues: {
        listLabelsOnIssue: vi.fn(),
        listLabelsForRepo: vi.fn(),
        getLabel: vi.fn(async ({ name }: { name: string }) => ({ data: { name } })),
        updateLabel: vi.fn(),
        deleteLabel: vi.fn(),
        createLabel: vi.fn(async ({ name }: { name: string }) => {
          created.push(name)
        }),
        addLabels: vi.fn(async ({ labels: names }: { labels: string[] }) => {
          added.push(names)
        }),
        removeLabel: vi.fn(async ({ name }: { name: string }) => {
          if (!labels.includes(name)) throw Object.assign(new Error('not found'), { status: 404 })
          removed.push(name)
        })
      }
    }
  }
  github.paginate.mockImplementation(async (method) => {
    if (method === github.rest.pulls.listFiles) return files
    if (method === github.rest.issues.listLabelsOnIssue) return labels.map((name) => ({ name }))
    if (method === github.rest.issues.listLabelsForRepo) return definitions
    throw new Error('Unexpected paginated endpoint')
  })
  return { github, added, removed, created }
}
type MockGithub = {
  paginate: MockFn
  rest: {
    repos: { getContent: MockFn }
    pulls: { get: MockFn; listFiles: MockFn }
    issues: {
      listLabelsOnIssue: MockFn
      listLabelsForRepo: MockFn
      getLabel: MockFn
      updateLabel: MockFn
      deleteLabel: MockFn
      createLabel: MockFn
      addLabels: MockFn
      removeLabel: MockFn
    }
  }
}

async function runJob(
  jobId: string,
  context: Context,
  github: MockGithub,
  env: Record<string, string> = {}
): Promise<MockCore> {
  const workflow =
    jobId === 'apply_review_outcome'
      ? reviewWorkflow
      : jobId === 'sync'
        ? syncWorkflow
        : labelsWorkflow
  const script = workflow.jobs[jobId]?.steps[0].with?.script
  if (!script) throw new Error(`job ${jobId} has no inline script`)
  const summary = { addHeading: vi.fn(), addTable: vi.fn(), write: vi.fn() }
  summary.addHeading.mockReturnValue(summary)
  summary.addTable.mockReturnValue(summary)
  const core = { notice: vi.fn(), warning: vi.fn(), setFailed: vi.fn(), info: vi.fn(), summary }
  const processStub = { env }
  const run = new Function(
    'github',
    'context',
    'core',
    'process',
    'require',
    `return (async () => {\n${script}\n})()`
  )
  await run(github, context, core, processStub, createRequire(import.meta.url))
  return core
}

const repo = { owner: 'o', repo: 'r' }

function reviewContext(overrides: Record<string, unknown> = {}): Context {
  return {
    repo,
    payload: overrides
  }
}

function pullRequestContext(overrides: Record<string, unknown> = {}): Context {
  return {
    repo,
    sha: 'trusted-base-sha',
    payload: {
      pull_request: {
        number: 7,
        title: 'feat(ai-review): add thing',
        head: { ref: 'feat/ai-review-thing' },
        labels: [],
        ...overrides
      }
    }
  }
}

const reviewBody = (header: string, verdict: string): string =>
  [header, `**Verdict: ${verdict}**`].join('\n')

function reviewEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PR_NUMBER: '7',
    REVIEW_HEAD_SHA: 'sha1',
    REVIEW_REQUIRED: 'true',
    REVIEW_RESULT: 'success',
    REVIEW_POST_RESULT: 'success',
    REVIEW_POSTED: 'true',
    REVIEW_BODY: reviewBody('## Codex Review', 'mergeable'),
    ...overrides
  }
}

describe('apply_review_outcome', () => {
  it('labels ready-to-merge when the combined reviewer is mergeable', async () => {
    const { github, added, removed } = makeGithub()
    await runJob('apply_review_outcome', reviewContext(), github, reviewEnv())
    expect(added).toEqual([['ready-to-merge']])
    expect(removed).toEqual([])
  })

  it('removes ready-to-merge when the reviewer is disabled', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ REVIEW_REQUIRED: 'false' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('fails closed when a reviewer job ran but did not succeed', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ REVIEW_RESULT: 'failure' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('fails closed when a selected reviewer is skipped by its review limit', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({
        REVIEW_RESULT: 'skipped',
        REVIEW_POST_RESULT: 'skipped',
        REVIEW_POSTED: '',
        REVIEW_BODY: ''
      })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('fails closed when a review comment was not posted', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ REVIEW_POSTED: 'false' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('removes the label when any verdict is needs changes', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ REVIEW_BODY: reviewBody('## Codex Review', 'needs changes') })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('fails closed when an active reviewer output has no unambiguous verdict', async () => {
    const { github, added, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob(
      'apply_review_outcome',
      reviewContext(),
      github,
      reviewEnv({ REVIEW_BODY: 'review unavailable' })
    )
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })

  it('does nothing when a newer pull request commit exists', async () => {
    const { github, added, removed } = makeGithub({ prHeadSha: 'newer-sha' })
    await runJob('apply_review_outcome', reviewContext(), github, reviewEnv())
    expect(added).toEqual([])
    expect(removed).toEqual([])
  })

  it('removes ready-to-merge from a closed pull request', async () => {
    const { github, added, removed } = makeGithub({
      prState: 'closed',
      labels: ['ready-to-merge']
    })
    await runJob('apply_review_outcome', reviewContext(), github, reviewEnv())
    expect(added).toEqual([])
    expect(removed).toEqual(['ready-to-merge'])
  })
})

describe('PR classification', () => {
  it.each(catalog.filter((label) => label.type))('maps $type to $name', async ({ type, name }) => {
    const { github, added } = makeGithub({ pr: { title: `${type}(scope)!: change thing` } })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([[name, 'size:XS']])
  })

  it('falls back to the branch when the title is not conventional', async () => {
    const { github, added } = makeGithub({
      pr: { title: 'Update docs', head: { sha: 'sha1', ref: 'docs/readme' } }
    })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([['documentation', 'size:XS']])
  })

  it('uses current API metadata, changes owned labels and preserves human/bot labels', async () => {
    const { github, added, removed } = makeGithub({
      pr: { title: 'fix(notebook): stop crash' },
      labels: [
        'enhancement',
        'area:ci',
        'size:L',
        'notebook',
        'security',
        'ready-to-merge',
        'dependencies'
      ],
      files: [{ filename: 'src/main/notebook/kernel.ts', additions: 10, deletions: 1 }]
    })
    await runJob('apply_type_labels', pullRequestContext({ title: 'docs(old): old title' }), github)
    expect(added).toEqual([['bug', 'size:S']])
    expect(removed).toEqual(['enhancement', 'size:L'])
    expect(github.rest.issues.addLabels.mock.invocationCallOrder[0]).toBeLessThan(
      github.rest.issues.removeLabel.mock.invocationCallOrder[0]
    )
  })

  it('drops stale types for unknown titles and branches', async () => {
    const { github, added, removed } = makeGithub({
      labels: ['bug'],
      pr: { title: 'Update', head: { sha: 'sha1', ref: 'unknown' } }
    })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([['size:XS']])
    expect(removed).toEqual(['bug'])
  })

  it.each([
    [0, 'XS'],
    [9, 'XS'],
    [10, 'S'],
    [29, 'S'],
    [30, 'M'],
    [99, 'M'],
    [100, 'L'],
    [499, 'L'],
    [500, 'XL'],
    [999, 'XL'],
    [1000, 'XXL']
  ])('counts additions plus deletions at %i lines as %s', async (count, size) => {
    const changes = Number(count)
    const { github, added } = makeGithub({
      files: [
        {
          filename: 'README.md',
          additions: Math.floor(changes / 2),
          deletions: Math.ceil(changes / 2)
        }
      ]
    })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added.flat()).toContain(`size:${size}`)
  })

  it('ignores nested lockfiles but counts locales and fixtures', async () => {
    const files = [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'uv.lock'
    ].map((name) => ({ filename: `nested/${name}`, additions: 10000, deletions: 10000 }))
    files.push(
      { filename: 'src/shared/i18n/locales/de.json', additions: 50, deletions: 0 },
      { filename: 'fixtures/data.json', additions: 40, deletions: 10 }
    )
    const { github, added } = makeGithub({ files })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added.flat()).toContain('size:L')
  })

  it('keeps size accounting without labeling areas for source, tests, workflows or renames', async () => {
    const { github, added } = makeGithub({
      files: [
        {
          filename: 'src/main/literature/new.test.ts',
          previous_filename: 'src/main/notebook/old.ts',
          additions: 4,
          deletions: 3
        },
        { filename: '.github/workflows/check.yml', additions: 1, deletions: 0 }
      ]
    })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added.flat()).toEqual(['enhancement', 'size:XS'])
  })

  it('paginates complete file and label lists', async () => {
    const { github, added } = makeGithub({
      files: Array.from({ length: 101 }, (_, i) => ({
        filename: `file-${i}.md`,
        additions: 1,
        deletions: 0
      }))
    })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(github.paginate).toHaveBeenCalledWith(github.rest.pulls.listFiles, {
      ...repo,
      pull_number: 7,
      per_page: 100
    })
    expect(github.paginate).toHaveBeenCalledWith(github.rest.issues.listLabelsOnIssue, {
      ...repo,
      issue_number: 7,
      per_page: 100
    })
    expect(added.flat()).toContain('size:L')
  })

  it('clears file-derived classifications if GitHub returns a partial list', async () => {
    const { github, added, removed } = makeGithub({
      pr: { changed_files: 3001 },
      labels: ['area:ui', 'size:XXL', 'ready-to-merge']
    })
    const core = await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([['enhancement']])
    expect(removed).toEqual(['size:XXL'])
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Incomplete'))
  })

  it.each(['head', 'base', 'title', 'state', 'changed_files'])(
    'does not write if %s changes during reads',
    async (field) => {
      const { github, added, removed } = makeGithub()
      const original = (await github.rest.pulls.get()).data
      const values = {
        head: { sha: 'new', ref: 'feat/new' },
        base: { sha: 'new-base' },
        title: 'fix(new): new title',
        state: 'closed',
        changed_files: 2
      }
      github.rest.pulls.get
        .mockResolvedValueOnce({ data: original })
        .mockResolvedValueOnce({ data: { ...original, [field]: values[field] } })
      const core = await runJob('apply_type_labels', pullRequestContext(), github)
      expect(added).toEqual([])
      expect(removed).toEqual([])
      expect(core.warning).toHaveBeenCalled()
    }
  )

  it('does not label closed PRs', async () => {
    const { github, added } = makeGithub({ prState: 'closed' })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([])
    expect(github.paginate).not.toHaveBeenCalled()
  })

  it('is idempotent and reads configuration from the trusted base SHA', async () => {
    const { github, added, removed } = makeGithub({ labels: ['enhancement', 'size:XS'] })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(added).toEqual([])
    expect(removed).toEqual([])
    expect(github.rest.repos.getContent).toHaveBeenCalledWith({
      ...repo,
      path: '.github/labels.json',
      ref: 'trusted-base-sha'
    })
  })

  it('dry-runs the real classifier without any writes', async () => {
    const { github, added, removed, created } = makeGithub({ labels: ['bug'] })
    const core = await runJob('apply_type_labels', pullRequestContext(), github, {
      LABELS_DRY_RUN: 'true'
    })
    expect(JSON.parse(core.info.mock.calls[0][0])).toEqual({
      dryRun: true,
      add: ['enhancement', 'size:XS'],
      remove: ['bug']
    })
    expect([...added, ...removed, ...created]).toEqual([])
  })

  it('preserves previous classification when additions fail', async () => {
    const { github, removed } = makeGithub({ labels: ['bug'] })
    github.rest.issues.addLabels.mockRejectedValueOnce(new Error('unavailable'))
    await expect(runJob('apply_type_labels', pullRequestContext(), github)).rejects.toThrow(
      'unavailable'
    )
    expect(removed).toEqual([])
  })

  it('heals missing definitions and only tolerates confirmed creation races', async () => {
    const { github, created } = makeGithub()
    github.rest.issues.getLabel.mockRejectedValueOnce({ status: 404 })
    github.rest.issues.createLabel.mockRejectedValueOnce({ status: 422 })
    await runJob('apply_type_labels', pullRequestContext(), github)
    expect(github.rest.issues.createLabel).toHaveBeenCalledWith({
      ...repo,
      name: 'enhancement',
      color: 'a2eeef',
      description: 'New feature or request'
    })
    expect(github.rest.issues.getLabel).toHaveBeenCalledTimes(3)
    expect(created).toEqual([])
  })

  it('surfaces authentication errors instead of creating labels', async () => {
    const { github, created } = makeGithub()
    github.rest.issues.getLabel.mockRejectedValueOnce({ status: 403 })
    await expect(runJob('apply_type_labels', pullRequestContext(), github)).rejects.toMatchObject({
      status: 403
    })
    expect(created).toEqual([])
  })
})

describe('reset_review_labels', () => {
  it('removes stale outcome labels and tolerates missing ones', async () => {
    const { github, removed } = makeGithub({ labels: ['ready-to-merge'] })
    await runJob('reset_review_labels', pullRequestContext(), github)
    expect(removed).toEqual(['ready-to-merge'])
  })
})

describe('label catalog synchronization', () => {
  it('retires only the former area catalog while preserving size and custom labels', async () => {
    const retired = [
      'area:ui',
      'area:agents',
      'area:notebook',
      'area:compute',
      'area:literature',
      'area:storage',
      'area:extensions',
      'area:cli',
      'area:ci',
      'area:tests'
    ]
    const { github, created } = makeGithub({
      definitions: [
        ...catalog,
        ...[...retired, 'area:custom', 'security', 'ready-to-merge'].map((name) => ({
          name,
          color: 'ffffff',
          description: 'Existing label'
        }))
      ]
    })
    await runJob('sync', reviewContext(), github)
    expect(github.rest.issues.deleteLabel.mock.calls.map(([args]) => args)).toEqual(
      retired.map((name) => ({ ...repo, name }))
    )
    expect(created).toEqual([])
    expect(github.rest.issues.updateLabel).not.toHaveBeenCalled()
  })

  it('previews retirement without deleting labels and supports already-clean repositories', async () => {
    for (const dryRun of [true, false]) {
      const { github } = makeGithub({
        definitions: dryRun
          ? [...catalog, { name: 'AREA:UI', color: 'ffffff', description: 'Old area' }]
          : catalog
      })
      const core = await runJob('sync', reviewContext(), github, { LABELS_DRY_RUN: String(dryRun) })
      expect(github.rest.issues.deleteLabel).not.toHaveBeenCalled()
      if (dryRun)
        expect(core.summary.addTable.mock.calls[0][0]).toContainEqual(['AREA:UI', 'delete'])
    }
  })

  it('tolerates concurrent retirement but surfaces deletion permission errors', async () => {
    for (const status of [404, 403]) {
      const { github } = makeGithub({
        definitions: [...catalog, { name: 'AREA:UI', color: 'ffffff', description: 'Old area' }]
      })
      github.rest.issues.deleteLabel.mockRejectedValueOnce({ status })
      const run = runJob('sync', reviewContext(), github)
      if (status === 404) await run
      else await expect(run).rejects.toMatchObject({ status })
      expect(github.rest.issues.deleteLabel).toHaveBeenCalledExactlyOnceWith({
        ...repo,
        name: 'AREA:UI'
      })
    }
  })

  it('creates missing labels, updates managed metadata, and ignores labels outside the catalog', async () => {
    const { github, created } = makeGithub({
      definitions: [
        { ...catalog[0], color: '000000' },
        ...catalog.slice(2),
        { name: 'security', color: 'ffffff', description: 'Human-owned' }
      ]
    })
    const core = await runJob('sync', reviewContext(), github)
    expect(created).toEqual(['bug'])
    expect(github.rest.issues.updateLabel).toHaveBeenCalledExactlyOnceWith({
      ...repo,
      name: catalog[0].name,
      color: catalog[0].color,
      description: catalog[0].description
    })
    expect(github.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(core.summary.write).toHaveBeenCalled()
    expect(github.rest.repos.getContent).toHaveBeenCalledWith({
      ...repo,
      path: '.github/labels.json',
      ref: 'main'
    })
  })

  it('does not write when the catalog matches or a preview is requested', async () => {
    for (const dryRun of [false, true]) {
      const { github, created } = makeGithub({ definitions: dryRun ? [] : catalog })
      await runJob('sync', reviewContext(), github, { LABELS_DRY_RUN: String(dryRun) })
      expect(created).toEqual([])
      expect(github.rest.issues.updateLabel).not.toHaveBeenCalled()
    }
  })

  it('recognizes existing names case-insensitively without renaming them', async () => {
    const { github, created } = makeGithub({
      definitions: catalog.map((label) => ({ ...label, name: label.name.toUpperCase() }))
    })
    await runJob('sync', reviewContext(), github)
    expect(created).toEqual([])
    expect(github.rest.issues.updateLabel).not.toHaveBeenCalled()
  })

  it('confirms a creation race before updating metadata', async () => {
    const { github } = makeGithub({ definitions: catalog.slice(1) })
    github.rest.issues.createLabel.mockRejectedValueOnce({ status: 422 })
    await runJob('sync', reviewContext(), github)
    expect(github.rest.issues.getLabel).toHaveBeenCalledExactlyOnceWith({
      ...repo,
      name: catalog[0].name
    })
    expect(github.rest.issues.updateLabel).toHaveBeenCalledExactlyOnceWith({
      ...repo,
      name: catalog[0].name,
      color: catalog[0].color,
      description: catalog[0].description
    })
  })

  it('propagates failed writes and unconfirmed creation errors', async () => {
    for (const status of [403, 422]) {
      const { github } = makeGithub({ definitions: [] })
      github.rest.issues.createLabel.mockRejectedValueOnce({ status })
      github.rest.issues.getLabel.mockRejectedValueOnce({ status: 404 })
      await expect(runJob('sync', reviewContext(), github)).rejects.toMatchObject({
        status: status === 422 ? 404 : 403
      })
      expect(github.rest.issues.updateLabel).not.toHaveBeenCalled()
    }
  })
})

describe('label configuration contracts', () => {
  it('has unique valid metadata, every policy type, and only owned label families', () => {
    expect(new Set(catalog.map((label) => label.name.toLowerCase())).size).toBe(catalog.length)
    expect(
      catalog
        .filter((label) => label.type)
        .map((label) => label.type)
        .sort()
    ).toEqual(
      [
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
      ].sort()
    )
    for (const label of catalog) {
      expect(label.color).toMatch(/^[a-f0-9]{6}$/)
      expect(label.description.length).toBeGreaterThan(0)
      expect(label.description.length).toBeLessThanOrEqual(100)
      expect(
        Object.keys(label).every((key) => ['name', 'color', 'description', 'type'].includes(key))
      ).toBe(true)
      expect(
        Boolean(
          label.type ||
          label.name.startsWith('size:') ||
          ['needs-triage', 'reproducibility'].includes(label.name)
        )
      ).toBe(true)
    }
    expect(
      catalog.filter((label) => label.name.startsWith('size:')).map((label) => label.name)
    ).toEqual(['size:XS', 'size:S', 'size:M', 'size:L', 'size:XL', 'size:XXL'])
    expect(catalog.some((label) => label.name.startsWith('area:'))).toBe(false)
    const names = catalog.map((label) => label.name)
    for (const name of [
      'notebook',
      'security',
      'dependencies',
      'github_actions',
      'ready-to-merge',
      'ai-reviewed',
      'ci-scheduled-failure'
    ])
      expect(names).not.toContain(name)
  })

  it('uses catalog labels in each issue template without adding intake fields', () => {
    const expected = {
      bug_report: ['bug', 'needs-triage'],
      feature_request: ['enhancement', 'needs-triage'],
      reproducibility_case: ['reproducibility', 'needs-triage']
    }
    for (const [template, labels] of Object.entries(expected)) {
      const form = load(readFileSync(`.github/ISSUE_TEMPLATE/${template}.yml`, 'utf8')) as {
        labels: string[]
      }
      expect(form.labels).toEqual(labels)
      expect(form.labels.every((name) => catalog.some((label) => label.name === name))).toBe(true)
    }
  })

  it('retains target permissions and isolates classification concurrency from AI review resets', () => {
    expect(labelsWorkflow.on).toEqual({
      pull_request_target: {
        branches: ['main'],
        types: ['opened', 'synchronize', 'reopened', 'edited']
      }
    })
    expect(labelsWorkflow.jobs.apply_type_labels.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write'
    })
    expect(labelsWorkflow.jobs.apply_type_labels.concurrency).toEqual({
      group: 'pr-classification-${{ github.event.pull_request.number }}',
      'cancel-in-progress': false
    })
    expect(labelsWorkflow.jobs.reset_review_labels.concurrency).toBeUndefined()
    expect(labelsWorkflow.jobs.reset_review_labels.if).toContain("github.event.action != 'edited'")
    expect(labelsWorkflow.jobs.apply_type_labels.if).toContain('github.event.changes.title')
    const text = readFileSync('.github/workflows/ai-review-labels.yml', 'utf8')
    const result = checkCiIntegrityChanges([
      { path: '.github/workflows/ai-review-labels.yml', baseText: text, headText: text }
    ])
    expect(result).toMatchObject({ ok: true, violations: [] })
  })

  it('restricts catalog writes to main, offers a safe preview, and never executes checked-out code', () => {
    expect(syncWorkflow.on).toEqual({
      push: {
        branches: ['main'],
        paths: ['.github/labels.json', '.github/workflows/sync-labels.yml']
      },
      workflow_dispatch: {
        inputs: {
          'dry-run': {
            description: 'Preview catalog changes without writing labels',
            type: 'boolean',
            default: true
          }
        }
      }
    })
    expect(syncWorkflow.jobs.sync.if).toBe("github.ref == 'refs/heads/main'")
    expect(syncWorkflow.jobs.sync.permissions).toEqual({ contents: 'read', issues: 'write' })
    for (const workflow of [labelsWorkflow, syncWorkflow]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          expect(step.uses).toMatch(/^actions\/github-script@[a-f0-9]{40}$/)
          expect(step.run).toBeUndefined()
          expect(step.with?.script).not.toContain('${{')
          expect(step.with?.script).not.toContain('.setLabels(')
        }
      }
    }
    expect(readFileSync('.github/CODEOWNERS', 'utf8')).toContain(
      '/.github/labels.json @aipoch/ci-maintainers'
    )
  })
})
