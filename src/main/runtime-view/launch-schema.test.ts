import { describe, expect, it } from 'vitest'
import { runtimeViewLaunchSchema } from '../../shared/runtime-view'

describe('project runtime view declaration', () => {
  it('accepts bounded application intent without accepting authority fields', () => {
    expect(
      runtimeViewLaunchSchema.parse({
        title: '  Project  ',
        entryPath: '/lab?tab=run',
        allowedRequestHeaders: ['x-project-csrf'],
        webSocketProtocols: ['project.v1'],
        adaptFrameAncestors: true
      })
    ).toEqual({
      title: 'Project',
      entryPath: '/lab?tab=run',
      allowedRequestHeaders: ['x-project-csrf'],
      webSocketProtocols: ['project.v1'],
      adaptFrameAncestors: true
    })
    for (const field of [
      'url',
      'socketPath',
      'expectedProof',
      'allowedParentOrigins',
      'cookiePolicy',
      'pid',
      'scope'
    ]) {
      expect(
        runtimeViewLaunchSchema.safeParse({ title: 'Project', [field]: 'untrusted' }).success
      ).toBe(false)
    }
  })

  it('rejects malformed paths, management headers, overlarge declarations and protocol injection', () => {
    for (const path of [
      'https://remote.invalid',
      '//other',
      '/%2fother',
      '/%00secret',
      '/a\\b',
      '/%5cb',
      '/bad%encoding',
      `/${'a'.repeat(8192)}`
    ]) {
      expect(runtimeViewLaunchSchema.safeParse({ title: 'Project', entryPath: path }).success).toBe(
        false
      )
    }
    for (const header of [
      'Cookie',
      'authorization',
      'host',
      'x-forwarded-host',
      'x-proxy-authorization',
      'x-open-science-token'
    ]) {
      expect(
        runtimeViewLaunchSchema.safeParse({ title: 'Project', allowedRequestHeaders: [header] })
          .success
      ).toBe(false)
    }
    expect(runtimeViewLaunchSchema.safeParse({ title: ' ' }).success).toBe(false)
    expect(runtimeViewLaunchSchema.safeParse({ title: 'a'.repeat(257) }).success).toBe(false)
    expect(
      runtimeViewLaunchSchema.safeParse({
        title: 'Project',
        allowedRequestHeaders: Array(17).fill('x-project')
      }).success
    ).toBe(false)
    expect(
      runtimeViewLaunchSchema.safeParse({
        title: 'Project',
        webSocketProtocols: ['a\r\nInjected: value']
      }).success
    ).toBe(false)
    expect(
      runtimeViewLaunchSchema.safeParse({
        title: 'Project',
        webSocketProtocols: Array(9).fill('v1')
      }).success
    ).toBe(false)
  })
})
