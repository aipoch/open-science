import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseSkillDocument } from '../../shared/skill-frontmatter'

const skillPath = join(process.cwd(), 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md')

describe('remote-compute-ssh saved-id result guidance', () => {
  it('keeps valid public Skill identity metadata', async () => {
    const skill = parseSkillDocument(await readFile(skillPath, 'utf8'))
    expect(skill).toMatchObject({
      name: 'remote-compute-ssh',
      hasFrontmatter: true
    })
    expect(skill.description).toBeTruthy()
  })

  it('returns the exact submitted job_id without waiting or fetching speculatively', async () => {
    const skill = await readFile(skillPath, 'utf8')
    const workflow = skill.match(
      /## API reference \(async jobs\)[\s\S]*?```javascript\n([\s\S]*?)\n```/
    )?.[1]

    expect(workflow).toBeDefined()
    const attachJob = vi.fn()
    const submitJob = vi.fn(async () => {
      return { job_id: 'job-1', provider_id: 'ssh:test', status: 'submitted' }
    })
    const create = vi.fn(() => ({ submitJob, attachJob }))
    const print = vi.fn(() => {
      throw new Error('the JS kernel has no print; use a trailing expression or return')
    })
    const execute = new AsyncFunction('host', 'print', workflow!)
    const returned = await execute({ compute: { create } }, print)

    expect(returned).toMatchObject({ job_id: 'job-1', status: 'submitted' })
    expect(submitJob).toHaveBeenCalledOnce()
    expect(attachJob).not.toHaveBeenCalled()
  })

  it('documents saved-id non-blocking snapshots and acknowledged fallback suppression', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('Save the exact `job_id`')
    expect(skill).toMatch(/\.status\(\)` and `\.result\(\)/u)
    expect(skill).toContain('non-blocking')
    expect(skill).toContain('Treat only `result_final: true` as')
    expect(skill).toContain("`follow_up_delivery: 'suppressed'`")
    expect(skill).toContain('`committed`')
    expect(skill).toMatch(/unread final\s+result is delivered in a later Agent Turn/u)
    expect(skill).not.toMatch(/peek once|query once|result read once|do not poll|never poll/i)
    expect(skill).not.toContain('wait_for_notification')
    expect(skill).not.toContain('setTimeout(resolve, 2000)')
    expect(skill).not.toMatch(/listJobs|list jobs|Job history/i)
  })

  it('publishes harvested outputs through the exposed artifact tool contract', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('Call the `write_artifact_file` tool')
    expect(skill).toContain('outside `repl_execute`')
    expect(skill).toContain('"kind": "localPath"')
    expect(skill).toContain('r.local_output_root')
    expect(skill).toContain('r.producer_run_id')
    expect(skill).toContain('"producerRunId": "<producer_run_id>"')
    expect(skill).toContain('"path": "<local_output_root>/hpc/<job_id>/featured/results.csv"')
    expect(skill).toContain(
      "df = pd.read_csv(Path('<local_output_root>') / 'hpc/<job_id>/featured/results.csv')"
    )
    expect(skill).not.toContain("host.mcp('artifacts'")
  })

  it('describes the user time directive and the derived scheduler default consistently', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('You may set the scheduler allocation limit with')
    expect(skill).toContain('Open Science derives a default allocation')
    expect(skill).not.toContain('Open Science owns the Slurm time')
  })
})

const AsyncFunction = Object.getPrototypeOf(async function () {
  return undefined
}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>
