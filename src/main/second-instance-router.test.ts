import { describe, expect, it, vi } from 'vitest'

import { routeSecondInstance } from './second-instance-router'

const makeDeps = (): {
  ensureWebService: ReturnType<
    typeof vi.fn<(port: number, opts: { attached: boolean }) => Promise<unknown>>
  >
  showMainWindow: ReturnType<typeof vi.fn<() => void>>
  onError: ReturnType<typeof vi.fn<(error: unknown) => void>>
} => ({
  ensureWebService: vi
    .fn<(port: number, opts: { attached: boolean }) => Promise<unknown>>()
    .mockResolvedValue({ port: 44100, url: 'http://127.0.0.1:44100/' }),
  showMainWindow: vi.fn<() => void>(),
  onError: vi.fn<(error: unknown) => void>()
})

describe('routeSecondInstance', () => {
  it('starts the web service (attached) with the requested port for a --serve=PORT launch', () => {
    const deps = makeDeps()
    routeSecondInstance(['/app', '.', '--open-science-headless', '--serve=52020'], deps)

    expect(deps.ensureWebService).toHaveBeenCalledWith(52020, { attached: true })
    expect(deps.showMainWindow).not.toHaveBeenCalled()
  })

  it('starts the web service on the default port for bare --serve / --open-science-headless', () => {
    const serve = makeDeps()
    routeSecondInstance(['/app', '.', '--serve'], serve)
    expect(serve.ensureWebService).toHaveBeenCalledWith(44100, { attached: true })

    const headless = makeDeps()
    routeSecondInstance(['/app', '.', '--open-science-headless'], headless)
    expect(headless.ensureWebService).toHaveBeenCalledWith(44100, { attached: true })
    expect(headless.showMainWindow).not.toHaveBeenCalled()
  })

  it('surfaces the window and does not serve for a plain re-launch (double-click)', () => {
    const deps = makeDeps()
    routeSecondInstance(['/app', '.'], deps)

    expect(deps.showMainWindow).toHaveBeenCalledTimes(1)
    expect(deps.ensureWebService).not.toHaveBeenCalled()
  })

  it('decides purely on argv, ignoring any OPEN_SCIENCE_WEB_PORT in the primary env', () => {
    const previous = process.env.OPEN_SCIENCE_WEB_PORT
    process.env.OPEN_SCIENCE_WEB_PORT = '55555'
    try {
      const deps = makeDeps()
      routeSecondInstance(['/app', '.'], deps)
      // No --serve in argv -> a plain re-launch, even though the primary's env has a web port set.
      expect(deps.showMainWindow).toHaveBeenCalledTimes(1)
      expect(deps.ensureWebService).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.OPEN_SCIENCE_WEB_PORT
      else process.env.OPEN_SCIENCE_WEB_PORT = previous
    }
  })

  it('routes an on-demand start failure to onError instead of throwing into the OS event', async () => {
    const deps = makeDeps()
    const failure = new Error('port in use')
    deps.ensureWebService.mockRejectedValueOnce(failure)

    routeSecondInstance(['/app', '.', '--serve=44100'], deps)
    // The rejection is handled on the microtask queue; let it settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(deps.onError).toHaveBeenCalledWith(failure)
  })
})
