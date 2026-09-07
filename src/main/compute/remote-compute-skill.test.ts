import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseSkillDocument } from '../../shared/skill-frontmatter'

const skillPath = join(process.cwd(), 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md')

describe('remote-compute-ssh immediate failure guidance', () => {
  it('keeps valid public Skill identity metadata', async () => {
    const skill = parseSkillDocument(await readFile(skillPath, 'utf8'))
    expect(skill).toMatchObject({
      name: 'remote-compute-ssh',
      hasFrontmatter: true
    })
    expect(skill.description).toBeTruthy()
  })

  it('executes submit, one bounded wait, and one proactive non-blocking result fetch', async () => {
    const skill = await readFile(skillPath, 'utf8')
    const workflow = skill.match(
      /## API reference \(async jobs\)[\s\S]*?```javascript\n([\s\S]*?)\n```/
    )?.[1]

    expect(workflow).toBeDefined()
    const events: string[] = []
    const resultSnapshot = { job_id: 'job-1', status: 'failed', stderr_tail: 'missing executable' }
    const result = vi.fn(async () => {
      events.push('result')
      return resultSnapshot
    })
    const status = vi.fn(async () => {
      events.push('status')
      return { job_id: 'job-1', status: 'failed' }
    })
    const attachJob = vi.fn((jobId: string) => {
      events.push(`attach:${jobId}`)
      return { result, status }
    })
    const submitJob = vi.fn(async () => {
      events.push('submit')
      return { job_id: 'job-1', provider_id: 'ssh:test', status: 'submitted' }
    })
    const create = vi.fn(() => {
      events.push('create')
      return { submitJob, attachJob }
    })
    const print = vi.fn(() => {
      throw new Error('the JS kernel has no print; use a trailing expression or return')
    })
    const execute = new AsyncFunction('host', 'print', workflow!)
    let returned: unknown
    vi.useFakeTimers()
    try {
      const completion = execute({ compute: { create } }, print)
      await vi.waitFor(() => expect(submitJob).toHaveBeenCalledOnce())
      expect(result).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1999)
      expect(result).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      returned = await completion
    } finally {
      vi.useRealTimers()
    }

    expect(events).toEqual(['create', 'submit', 'attach:job-1', 'result'])
    expect(returned).toBe(resultSnapshot)
    expect(status).not.toHaveBeenCalled()
    expect(result).toHaveBeenCalledOnce()
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
