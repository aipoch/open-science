import { describe, expect, it } from 'vitest'

import { resolveProjectId } from './project-scope'

describe('resolveProjectId', () => {
  it('prefers the canonical projectId and accepts the matching legacy alias', () => {
    expect(resolveProjectId({ projectId: 'project-1' })).toBe('project-1')
    expect(resolveProjectId({ projectId: 'project-1', projectName: 'project-1' })).toBe('project-1')
  })

  it('accepts a historical projectName value and an explicit fallback as Project ids', () => {
    expect(resolveProjectId({ projectName: 'legacy-project-id' })).toBe('legacy-project-id')
    expect(resolveProjectId({}, 'default-project')).toBe('default-project')
  })

  it('rejects ambiguous or missing Project identity', () => {
    expect(() =>
      resolveProjectId({ projectId: 'project-1', projectName: 'renamed-project' })
    ).toThrow('Conflicting projectId and legacy projectName values.')
    expect(() => resolveProjectId({})).toThrow('A projectId is required.')
  })
})
