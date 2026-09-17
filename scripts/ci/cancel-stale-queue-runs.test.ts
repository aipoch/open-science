import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { cancelStaleQueueRuns } from './cancel-stale-queue-runs.mjs'

const sha = 'a'.repeat(40)
const run = {
  id: 10,
  event: 'merge_group',
  status: 'queued',
  head_branch: `gh-readonly-queue/main/pr-2680-${sha}`,
  head_sha: sha
}
const repo = { owner: 'aipoch', repo: 'open-science' }
type Fixture = {
  github: {
    paginate: Mock
    rest: { actions: { listWorkflowRuns: Mock; cancelWorkflowRun: Mock }; git: { getRef: Mock } }
  }
  repo: typeof repo
  log: Mock
  cancelWorkflowRun: Mock
  getRef: Mock
}
function fixture(runs = [run]): Fixture {
  const cancelWorkflowRun = vi.fn().mockResolvedValue({})
  const getRef = vi.fn().mockResolvedValue({ data: { object: { sha } } })
  const paginate = vi.fn().mockResolvedValueOnce(runs).mockResolvedValue([])
  const github = {
    paginate,
    rest: { actions: { listWorkflowRuns: vi.fn(), cancelWorkflowRun }, git: { getRef } }
  }
  return { github, repo, log: vi.fn(), cancelWorkflowRun, getRef }
}

describe('obsolete queue cleanup', () => {
  it('preserves all current groups, including multiple concurrent PRs', async () => {
    const f = fixture([
      run,
      { ...run, id: 11, head_branch: run.head_branch.replace('2680', '2682') }
    ])
    expect(await cancelStaleQueueRuns(f)).toEqual([])
    expect(f.cancelWorkflowRun).not.toHaveBeenCalled()
  })
  it.each(['missing', 'replaced'])('cancels a %s queue revision', async (kind) => {
    const f = fixture()
    if (kind === 'missing') f.getRef.mockRejectedValue({ status: 404 })
    else f.getRef.mockResolvedValue({ data: { object: { sha: 'b'.repeat(40) } } })
    expect(await cancelStaleQueueRuns(f)).toEqual([10])
    expect(f.cancelWorkflowRun).toHaveBeenCalledWith({ ...repo, run_id: 10 })
  })
  it.each([403, 429, 500])('does not interpret HTTP %i as an obsolete ref', async (status) => {
    const f = fixture()
    f.getRef.mockRejectedValue({ status })
    await expect(cancelStaleQueueRuns(f)).rejects.toEqual({ status })
    expect(f.cancelWorkflowRun).not.toHaveBeenCalled()
  })
  it('ignores PR, manual, completed, and non-main runs', async () => {
    const f = fixture([
      { ...run, event: 'pull_request' },
      { ...run, event: 'workflow_dispatch' },
      { ...run, status: 'completed' },
      { ...run, head_branch: 'feature/test' },
      { ...run, head_branch: run.head_branch.replace('/main/', '/release/') }
    ])
    await cancelStaleQueueRuns(f)
    expect(f.getRef).not.toHaveBeenCalled()
    expect(f.cancelWorkflowRun).not.toHaveBeenCalled()
  })
  it('tolerates completion during cancellation but reports permission errors', async () => {
    const f = fixture()
    f.getRef.mockRejectedValue({ status: 404 })
    f.cancelWorkflowRun.mockRejectedValue({ status: 409 })
    expect(await cancelStaleQueueRuns(f)).toEqual([])
    const denied = fixture()
    denied.getRef.mockRejectedValue({ status: 404 })
    denied.cancelWorkflowRun.mockRejectedValue({ status: 403 })
    await expect(cancelStaleQueueRuns(denied)).rejects.toEqual({ status: 403 })
  })
  it('executes only trusted main code in a separate Ubuntu job', () => {
    const workflow = load(readFileSync('.github/workflows/queue-cleanup.yml', 'utf8')) as {
      on: { workflow_run: unknown }
      concurrency: Record<string, unknown>
      jobs: {
        cleanup: {
          'runs-on': string
          permissions: Record<string, string>
          steps: Array<{ with: { script: string } }>
        }
      }
    }
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['PR Gate'],
      types: ['requested', 'completed']
    })
    expect(workflow.jobs.cleanup['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.cleanup.permissions).toEqual({ contents: 'read', actions: 'write' })
    expect(workflow.jobs.cleanup.steps[0].with).toMatchObject({
      ref: 'refs/heads/main',
      'persist-credentials': false
    })
    expect(workflow.jobs.cleanup.steps).toHaveLength(2)
    expect(workflow.jobs.cleanup.steps[1].with.script).not.toContain('workflow_run.head')
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  })
})
