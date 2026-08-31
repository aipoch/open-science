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
    const print = vi.fn((value: unknown) => {
      events.push('print')
      expect(value).toBe(resultSnapshot)
    })
    const execute = new AsyncFunction('host', 'print', workflow!)
    vi.useFakeTimers()
    try {
      const completion = execute({ compute: { create } }, print)
      await vi.waitFor(() => expect(submitJob).toHaveBeenCalledOnce())
      expect(result).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1999)
      expect(result).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await completion
    } finally {
      vi.useRealTimers()
    }

    expect(events).toEqual(['create', 'submit', 'attach:job-1', 'result', 'print'])
    expect(status).not.toHaveBeenCalled()
    expect(result).toHaveBeenCalledOnce()
  })
})

const AsyncFunction = Object.getPrototypeOf(async function () {
  return undefined
}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>
