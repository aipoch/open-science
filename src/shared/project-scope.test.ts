import { describe, expect, it } from 'vitest'

import { resolveProjectId } from './project-scope'

describe('resolveProjectId', () => {
  it('returns the canonical projectId', () => {
    expect(resolveProjectId({ projectId: 'project-1' })).toBe('project-1')
  })

  it('uses an explicit fallback as the Project id', () => {
    expect(resolveProjectId({}, 'default-project')).toBe('default-project')
  })

  it('rejects missing Project identity', () => {
    expect(() => resolveProjectId({})).toThrow('A projectId is required.')
  })
})
