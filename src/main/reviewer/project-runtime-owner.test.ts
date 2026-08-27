import { describe, expect, it } from 'vitest'

import { ReviewerProjectRuntimeOwner } from './project-runtime-owner'

describe('ReviewerProjectRuntimeOwner', () => {
  it('aborts and drains admitted work for only the deleting Project', async () => {
    const owner = new ReviewerProjectRuntimeOwner()
    const target = owner.admit('project-1')
    const other = owner.admit('project-2')

    expect(owner.isProjectBusy('project-1')).toBe(true)
    expect(owner.isProjectBusy('project-2')).toBe(true)

    let quiesced = false
    const quiescing = owner.quiesceProject('project-1').then(() => {
      quiesced = true
    })
    await Promise.resolve()

    expect(target.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect(quiesced).toBe(false)
    expect(() => owner.admit('project-1')).toThrow('Project is being deleted.')

    target.release()
    await quiescing
    expect(quiesced).toBe(true)
    expect(owner.isProjectBusy('project-1')).toBe(false)

    const stillAvailable = owner.admit('project-2')
    stillAvailable.release()
    other.release()
  })

  it('restores and releases a deletion fence without creating an operation', () => {
    const owner = new ReviewerProjectRuntimeOwner()

    owner.restoreProjectDeletion('project-1')
    expect(() => owner.admit('project-1')).toThrow('Project is being deleted.')

    owner.releaseProjectDeletion('project-1')
    const admission = owner.admit('project-1')
    expect(admission.signal.aborted).toBe(false)
    admission.release()
  })
})
