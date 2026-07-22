// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { readDeepLinkParams, replaceNavigationParams } from './deep-link'

describe('deep-link URL helpers', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('reads project and session navigation parameters', () => {
    expect(readDeepLinkParams('?project=project%201&session=session%2F1')).toEqual({
      projectId: 'project 1',
      sessionId: 'session/1'
    })
  })

  it('treats missing and empty parameters as absent', () => {
    expect(readDeepLinkParams('?project=&other=value')).toEqual({
      projectId: undefined,
      sessionId: undefined
    })
  })

  it('writes workspace navigation while preserving unrelated parameters', () => {
    window.history.replaceState({}, '', '/?other=value#result')

    replaceNavigationParams('workspace', 'project 1', 'session/1')

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/?other=value&project=project+1&session=session%2F1#result'
    )
  })

  it('clears navigation parameters on Home', () => {
    window.history.replaceState({}, '', '/?project=p&session=s&other=value')

    replaceNavigationParams('home', undefined, undefined)

    expect(window.location.search).toBe('?other=value')
  })
})
