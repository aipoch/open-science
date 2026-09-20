import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  DEFAULT_LABEL,
  reportScheduledOutcome,
  trackingMarker
} from './report-scheduled-failure.mjs'

const repo = { owner: 'example-org', repo: 'example-repo' }
const sha = 'a'.repeat(40)
const run = {
  workflowFile: 'nightly.yml',
  workflowName: 'Nightly',
  runId: 101,
  runUrl: 'https://example.com/actions/runs/101',
  runAttempt: 1,
  headSha: sha
}
const trackingIssue = {
  number: 7,
  body: `${trackingMarker('nightly.yml')}\n<!-- scheduled-failure-run:100 -->\nfailed`
}

type Fixture = {
  github: { paginate: Mock; rest: { issues: Record<string, Mock> } }
  repo: typeof repo
  log: Mock
  issues: Record<string, Mock>
}
function fixture({
  issues = [] as Array<{ number: number; body: string; pull_request?: unknown }>,
  comments = [] as Array<{ body: string }>
} = {}): Fixture {
  const rest = {
    listForRepo: vi.fn(),
    listComments: vi.fn(),
    createLabel: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ data: { number: 42 } }),
    createComment: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({})
  }
  const paginate = vi.fn(async (endpoint: Mock) =>
    endpoint === rest.listForRepo ? issues : endpoint === rest.listComments ? comments : []
  )
  return { github: { paginate, rest: { issues: rest } }, repo, log: vi.fn(), issues: rest }
}

describe('scheduled failure tracking issues', () => {
  it('opens a labelled tracking issue on the first failure', async () => {
    const f = fixture()
    expect(await reportScheduledOutcome({ ...f, ...run, conclusion: 'failure' })).toEqual({
      action: 'created',
      issueNumber: 42
    })
    expect(f.github.paginate).toHaveBeenCalledWith(
      f.issues.listForRepo,
      expect.objectContaining({ ...repo, state: 'open', labels: DEFAULT_LABEL })
    )
    expect(f.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ ...repo, name: DEFAULT_LABEL, color: expect.any(String) })
    )
    const created = f.issues.create.mock.calls[0][0]
    expect(created).toMatchObject({
      ...repo,
      title: 'ci(nightly.yml): scheduled run failing',
      labels: [DEFAULT_LABEL]
    })
    for (const fragment of [
      trackingMarker('nightly.yml'),
      run.runUrl,
      sha,
      'attempt 1',
      'To investigate'
    ]) {
      expect(created.body).toContain(fragment)
    }
    expect(f.issues.createComment).not.toHaveBeenCalled()
  })

  it('appends a comment when the tracking issue already exists', async () => {
    const f = fixture({ issues: [trackingIssue] })
    expect(
      await reportScheduledOutcome({ ...f, ...run, runAttempt: 2, conclusion: 'failure' })
    ).toEqual({ action: 'commented', issueNumber: 7 })
    expect(f.issues.create).not.toHaveBeenCalled()
    expect(f.issues.createLabel).not.toHaveBeenCalled()
    const comment = f.issues.createComment.mock.calls[0][0]
    expect(comment).toMatchObject({ ...repo, issue_number: 7 })
    expect(comment.body).toContain(run.runUrl)
    expect(comment.body).toContain('attempt 2')
    expect(comment.body).toContain(sha)
  })

  it('skips a duplicate report for the same run id', async () => {
    const latest = fixture({
      issues: [trackingIssue],
      comments: [
        { body: '<!-- scheduled-failure-run:99 -->' },
        { body: '<!-- scheduled-failure-run:101 -->' }
      ]
    })
    expect(await reportScheduledOutcome({ ...latest, ...run, conclusion: 'failure' })).toEqual({
      action: 'none',
      issueNumber: 7
    })
    expect(latest.issues.createComment).not.toHaveBeenCalled()

    const body = fixture({ issues: [{ ...trackingIssue, number: 8 }] })
    expect(
      await reportScheduledOutcome({ ...body, ...run, runId: 100, conclusion: 'failure' })
    ).toEqual({ action: 'none', issueNumber: 8 })
    expect(body.issues.createComment).not.toHaveBeenCalled()

    const older = fixture({
      issues: [trackingIssue],
      comments: [{ body: '<!-- scheduled-failure-run:101 -->' }, { body: 'unrelated' }]
    })
    await reportScheduledOutcome({ ...older, ...run, conclusion: 'failure' })
    expect(older.issues.createComment).toHaveBeenCalledTimes(1)
  })

  it('closes the tracking issue after a scheduled success', async () => {
    const f = fixture({ issues: [trackingIssue] })
    expect(await reportScheduledOutcome({ ...f, ...run, conclusion: 'success' })).toEqual({
      action: 'closed',
      issueNumber: 7
    })
    expect(f.issues.createComment.mock.calls[0][0].body).toContain(`Recovered in ${run.runUrl}`)
    expect(f.issues.update).toHaveBeenCalledWith({
      ...repo,
      issue_number: 7,
      state: 'closed',
      state_reason: 'completed'
    })
  })

  it('does nothing on success without an open tracking issue', async () => {
    const f = fixture({
      issues: [
        { number: 1, body: trackingMarker('source-regression.yml') },
        { number: 2, body: trackingMarker('nightly.yml'), pull_request: {} }
      ]
    })
    expect(await reportScheduledOutcome({ ...f, ...run, conclusion: 'success' })).toEqual({
      action: 'none'
    })
    expect(f.issues.createComment).not.toHaveBeenCalled()
    expect(f.issues.update).not.toHaveBeenCalled()
    expect(f.issues.create).not.toHaveBeenCalled()
  })

  it.each([404, 409, 422])('tolerates a label creation race returning %i', async (status) => {
    const f = fixture()
    f.issues.createLabel.mockRejectedValue({ status })
    expect(await reportScheduledOutcome({ ...f, ...run, conclusion: 'failure' })).toEqual({
      action: 'created',
      issueNumber: 42
    })
  })

  it('propagates other label and API errors', async () => {
    const f = fixture()
    f.issues.createLabel.mockRejectedValue({ status: 403 })
    await expect(reportScheduledOutcome({ ...f, ...run, conclusion: 'failure' })).rejects.toEqual({
      status: 403
    })
    expect(f.issues.create).not.toHaveBeenCalled()
    await expect(
      reportScheduledOutcome({ ...fixture(), ...run, conclusion: 'cancelled' })
    ).rejects.toThrow('Unsupported conclusion')
  })
})
