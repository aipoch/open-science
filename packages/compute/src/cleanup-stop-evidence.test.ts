import { describe, expect, it } from 'vitest'
import { createCleanupStopEvidence, hasCleanupStopEvidence } from './cleanup-stop-evidence'

const identity = {
  job_id: 'j',
  provider_id: 'ssh:cluster',
  project_id: 'p',
  session_id: 's',
  created_at: 1,
  command_hash: 'hash',
  execution_mode: 'direct_ssh' as const,
  remote_workdir: '/scratch/.open-science/jobs/j',
  remote_handle: '{"pid":123}',
  last_poll_error: undefined as string | undefined
}

describe('scoped cleanup stop evidence', () => {
  it('requires the exact persisted execution identity and selected workdir', () => {
    const job = {
      ...identity,
      last_poll_error: createCleanupStopEvidence(identity, identity.remote_workdir)
    }
    expect(hasCleanupStopEvidence(job, identity.remote_workdir)).toBe(true)
    for (const changed of [
      { job_id: 'k' },
      { provider_id: 'ssh:other' },
      { project_id: 'other' },
      { session_id: 'other' },
      { created_at: 2 },
      { command_hash: 'different' },
      { execution_mode: 'slurm' as const },
      { remote_workdir: '/other/.open-science/jobs/j' },
      { remote_handle: '{"pid":456}' }
    ])
      expect(hasCleanupStopEvidence({ ...job, ...changed })).toBe(false)
    expect(hasCleanupStopEvidence(job, '/other/.open-science/jobs/j')).toBe(false)
  })

  it('rejects malformed, non-versioned, or unsafe evidence', () => {
    for (const last_poll_error of [
      'remote_cleanup_stopped_v1:[]',
      'remote_cleanup_stopped_v1:{',
      'remote_cleanup_stopped_v2:[]',
      'stopped'
    ]) {
      expect(hasCleanupStopEvidence({ ...identity, last_poll_error })).toBe(false)
    }
    expect(
      hasCleanupStopEvidence({
        ...identity,
        last_poll_error: createCleanupStopEvidence(identity, '/scratch/../.open-science/jobs/j')
      })
    ).toBe(false)
  })
})
