import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: false,
    getPath: vi.fn(() => '/Users/tester')
  }
}))

vi.mock('electron', () => ({ app: appMock }))

const { resolveStorageRoot } = await import('./storage-root')

beforeEach(() => {
  appMock.isPackaged = false
  appMock.getPath.mockClear()
  appMock.getPath.mockReturnValue('/Users/tester')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveStorageRoot', () => {
  it('uses the normal development directory by default', () => {
    expect(resolveStorageRoot()).toBe('/Users/tester/.open-science-project')
  })

  it('uses an absolute development preview override without changing HOME', () => {
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', '/tmp/open-science-preview/storage')

    expect(resolveStorageRoot()).toBe('/tmp/open-science-preview/storage')
    expect(appMock.getPath).not.toHaveBeenCalled()
  })

  it('rejects an ambiguous relative preview override', () => {
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', 'preview/storage')

    expect(() => resolveStorageRoot()).toThrow('must be an absolute path')
  })

  it('ignores the preview override in packaged builds', () => {
    appMock.isPackaged = true
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', '/tmp/ignored')

    expect(resolveStorageRoot()).toBe('/Users/tester/.open-science')
  })
})
