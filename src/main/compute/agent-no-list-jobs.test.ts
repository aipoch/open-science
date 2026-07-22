import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression guard (design.md §9): the agent-facing repl kernel must NOT expose a
// "list jobs" or "list_jobs" method. Only the renderer IPC surface (`compute:jobs:list`)
// is allowed to enumerate session jobs — the agent side only knows about handle-based
// queries (`attach_job(jobId).status()`).
//
// If this test fails, a "list_jobs" method has been added to the repl kernel, which
// would break the agent/renderer surface separation required by design.md §9.
describe('agent repl — no list_jobs method (design.md §9 regression guard)', () => {
  const replLoop = readFileSync(
    join(__dirname, '../../../resources/notebook/repl_loop.js'),
    'utf-8'
  )

  it('does not define list_jobs on the host.compute handle', () => {
    // Guard against any function named list_jobs or listJobs being added to the compute handle.
    expect(replLoop).not.toMatch(/list_jobs\s*\(/)
    expect(replLoop).not.toMatch(/listJobs\s*\(/)
  })

  it('does not expose a job-listing computeCall op', () => {
    // The only allowed ops from the agent side are: list, call_command, submit_job, job_status,
    // details. A "list_jobs" or "jobs_list" op would be a violation.
    expect(replLoop).not.toMatch(/op:\s*['"]list_jobs['"]/)
    expect(replLoop).not.toMatch(/op:\s*['"]jobs_list['"]/)
  })

  it('only has attach_job for per-job handle queries', () => {
    // attach_job should exist (the allowed handle-query path).
    expect(replLoop).toContain('attach_job')
    // job_status op is the allowed DB read-only query.
    expect(replLoop).toContain("op: 'job_status'")
  })
})
