import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { cleanupPrCaches } from './cleanup-pr-caches.mjs'

const repo = { owner: 'aipoch', repo: 'open-science' }
const cache = (id: number, ref = 'refs/pull/42/merge'): Record<string, unknown> => ({
  id,
  ref,
  size_in_bytes: 150_000_000
})
type Fixture = {
  github: {
    paginate: Mock
    rest: { pulls: { get: Mock } }
    request: Mock
  }
  repo: typeof repo
  dryRun: boolean | undefined
  log: Mock
}
const fixture = (caches = [cache(1)]): Fixture => ({
  github: {
    paginate: vi.fn().mockResolvedValue(caches),
    rest: { pulls: { get: vi.fn().mockResolvedValue({ data: { state: 'closed' } }) } },
    request: vi.fn().mockResolvedValue({})
  },
  repo,
  dryRun: false,
  log: vi.fn()
})

describe('closed PR cache cleanup', () => {
  it('uses pagination and deletes every eligible cache by ID', async () => {
    const f = fixture(Array.from({ length: 105 }, (_, index) => cache(index + 1)))
    expect(await cleanupPrCaches(f)).toHaveLength(105)
    expect(f.github.paginate).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/actions/caches', {
      ...repo,
      per_page: 100
    })
    expect(f.github.rest.pulls.get).toHaveBeenCalledTimes(1)
    expect(f.github.request).toHaveBeenLastCalledWith(
      'DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}',
      { ...repo, cache_id: 105 }
    )
  })

  it('preserves main, branch, tag, malformed and open PR refs', async () => {
    const f = fixture([
      cache(1, 'refs/heads/main'),
      cache(2, 'refs/heads/feature'),
      cache(3, 'refs/tags/v1'),
      cache(4, 'refs/pull/42/head'),
      cache(5, 'refs/pull/42/merge/extra'),
      cache(6, 'refs/pull/9007199254740992/merge'),
      cache(7),
      cache(8, 'refs/pull/43/merge')
    ])
    f.github.rest.pulls.get.mockImplementation(async ({ pull_number }) => ({
      data: { state: pull_number === 42 ? 'open' : 'closed' }
    }))
    expect(await cleanupPrCaches(f)).toEqual([8])
    expect(f.github.rest.pulls.get).toHaveBeenCalledTimes(2)
  })

  it('checks current PR state again on each sweep, preserving reopened PRs', async () => {
    const f = fixture()
    expect(await cleanupPrCaches(f)).toEqual([1])
    expect(f.github.rest.pulls.get).toHaveBeenCalledWith({ ...repo, pull_number: 42 })
    f.github.rest.pulls.get.mockResolvedValue({ data: { state: 'open' } })
    f.github.request.mockClear()
    expect(await cleanupPrCaches(f)).toEqual([])
    expect(f.github.request).not.toHaveBeenCalled()
  })

  it('defaults to dry-run and logs eligible caches without deleting', async () => {
    const f = { ...fixture(), dryRun: undefined }
    expect(await cleanupPrCaches(f)).toEqual([])
    expect(f.log).toHaveBeenCalledWith('Would delete cache 1 (refs/pull/42/merge, 150000000 bytes)')
    expect(f.github.request).not.toHaveBeenCalled()
  })

  it.each([404, 403, 429, 500])(
    'does not delete when PR lookup returns HTTP %i',
    async (status) => {
      const f = fixture()
      f.github.rest.pulls.get.mockRejectedValue({ status })
      await expect(cleanupPrCaches(f)).rejects.toEqual({ status })
      expect(f.github.request).not.toHaveBeenCalled()
    }
  )

  it('propagates cache enumeration failure without deleting anything', async () => {
    const f = fixture()
    f.github.paginate.mockRejectedValue({ status: 403 })
    await expect(cleanupPrCaches(f)).rejects.toEqual({ status: 403 })
    expect(f.github.request).not.toHaveBeenCalled()
  })

  it('tolerates an already removed cache and continues to the next one', async () => {
    const f = fixture([cache(1), cache(2)])
    f.github.request.mockRejectedValueOnce({ status: 404 })
    expect(await cleanupPrCaches(f)).toEqual([2])
  })

  it.each([403, 429, 500])('reports HTTP %i deletion errors', async (status) => {
    const f = fixture()
    f.github.request.mockRejectedValue({ status })
    await expect(cleanupPrCaches(f)).rejects.toEqual({ status })
  })

  it('runs only trusted main code with scoped permissions and a manual dry-run', () => {
    const workflow = load(readFileSync('.github/workflows/cache-cleanup.yml', 'utf8')) as {
      on: Record<string, unknown>
      concurrency: Record<string, unknown>
      jobs: {
        cleanup: {
          if: string
          permissions: Record<string, string>
          steps: Array<{
            uses: string
            with: Record<string, unknown>
            env?: Record<string, string>
          }>
        }
      }
    }
    expect(workflow.on).toEqual({
      workflow_run: { workflows: ['PR Gate'], types: ['completed'] },
      workflow_dispatch: {
        inputs: {
          dry_run: {
            description: 'List eligible caches without deleting them',
            type: 'boolean',
            default: true
          }
        }
      }
    })
    const job = workflow.jobs.cleanup
    expect(job.if).toBe(
      "${{ github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.event.workflow_run.event == 'pull_request' || github.event.workflow_run.event == 'merge_group') }}"
    )
    expect(job.permissions).toEqual({
      contents: 'read',
      actions: 'write',
      'pull-requests': 'read'
    })
    expect(job.steps).toHaveLength(2)
    expect(job.steps[0].with).toMatchObject({
      ref: 'refs/heads/main',
      'persist-credentials': false,
      'sparse-checkout': 'scripts/ci/cleanup-pr-caches.mjs'
    })
    expect(job.steps[1].env).toEqual({
      DRY_RUN: "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}"
    })
    expect(job.steps[1].with.script).toContain("dryRun: process.env.DRY_RUN === 'true'")
    expect(job.steps[1].with.script).not.toContain('${{')
    expect(job.steps[1].with.script).not.toContain('context.payload')
    expect(job.steps.some((step) => step.uses.includes('download-artifact'))).toBe(false)
    expect(workflow.concurrency).toEqual({
      group: 'closed-pr-cache-cleanup',
      'cancel-in-progress': false
    })
  })
})
