import { describe, expect, it, vi } from 'vitest'
import { createCallerContext } from '../caller-context'
import {
  DesktopObservationFrameRegistry,
  type DesktopObservationFrame
} from './desktop-frame-registry'

const viewerOrigin = 'http://viewer-one.localhost:12345'
const runtimeOrigin = 'http://rv-one.localhost:12346'
const viewerGrant = 'a'.repeat(64)
const runtimeGrant = 'b'.repeat(64)
const viewerUrl = `${viewerOrigin}/__open_science_viewer?grant=${viewerGrant}`
const runtimeUrl = `${runtimeOrigin}/__open_science_view?grant=${runtimeGrant}`
const frame = (
  id: number,
  url: string,
  parent: DesktopObservationFrame | null
): DesktopObservationFrame => ({ frameTreeNodeId: id, url, parent })
function fixture(): {
  registry: DesktopObservationFrameRegistry
  main: DesktopObservationFrame
  viewer: DesktopObservationFrame
  project: DesktopObservationFrame
  viewerRegistration: ReturnType<DesktopObservationFrameRegistry['registerViewer']>
  runtimeRegistration: ReturnType<DesktopObservationFrameRegistry['registerRuntime']>
  setCurrent(value: boolean): void
  navigate(url: string, target?: DesktopObservationFrame, owner?: number): boolean
  authenticate(): void
} {
  const registry = new DesktopObservationFrameRegistry()
  let current = true
  const expiresAt = Date.now() + 60000
  const caller = createCallerContext({
    clientId: '17',
    lifecycleClientId: 'electron:17',
    leaseId: 'electron:17',
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human',
    isAuthorizationCurrent: () => current
  })
  const main = frame(1, 'file:///app/index.html', null)
  const viewer = frame(2, `${viewerOrigin}/`, main)
  const project = frame(3, `${runtimeOrigin}/`, viewer)
  const viewerRegistration = registry.registerViewer({
    origin: viewerOrigin,
    caller,
    expiresAt,
    assertCurrent: () => undefined
  })
  const runtimeRegistration = registry.registerRuntime({
    origin: runtimeOrigin,
    parents: [viewerOrigin, 'file:'],
    expiresAt,
    assertCurrent: () => undefined,
    allowsPath: (path) => path === '/' || path === '/route?x=1'
  })
  viewerRegistration.issueGrant(viewerUrl, expiresAt)
  runtimeRegistration.issueGrant(runtimeUrl, expiresAt)
  const navigate = (url: string, target = viewer, owner = 17): boolean =>
    registry.allows({ url, webContentsId: owner, frame: target, mainFrame: main })
  return {
    registry,
    main,
    viewer,
    project,
    viewerRegistration,
    runtimeRegistration,
    setCurrent: (value): void => {
      current = value
    },
    navigate,
    authenticate: (): void => {
      expect(navigate(viewerUrl)).toBe(true)
      viewerRegistration.authenticateGrant(viewerGrant)
      expect(navigate(`${viewerOrigin}/`)).toBe(true)
      expect(navigate(runtimeUrl, project)).toBe(true)
      runtimeRegistration.authenticateGrant(runtimeGrant)
      expect(navigate(`${runtimeOrigin}/`, project)).toBe(true)
    }
  }
}

describe('desktop observation frame registry', () => {
  it('requires both real bootstrap success and an exact admitted frame for redirect/reload', () => {
    const h = fixture()
    expect(h.navigate(`${viewerOrigin}/`)).toBe(false)
    expect(h.navigate(runtimeUrl, h.project)).toBe(false)
    expect(h.navigate(viewerUrl)).toBe(true)
    expect(h.navigate(`${viewerOrigin}/`)).toBe(false)
    h.viewerRegistration.authenticateGrant(viewerGrant)
    expect(h.navigate(`${viewerOrigin}/`)).toBe(true)
    expect(h.navigate(viewerUrl)).toBe(false)
    expect(h.navigate(`${viewerOrigin}/`, frame(20, 'about:blank', h.main))).toBe(false)
    expect(h.navigate(runtimeUrl, h.project)).toBe(true)
    expect(h.navigate(`${runtimeOrigin}/`, h.project)).toBe(false)
    h.runtimeRegistration.authenticateGrant(runtimeGrant)
    expect(h.navigate(`${runtimeOrigin}/route?x=1`, h.project)).toBe(true)
    expect(h.navigate(`${runtimeOrigin}/private`, h.project)).toBe(false)
    expect(h.navigate(`${viewerOrigin}/api/context`)).toBe(false)
  })

  it('denies arbitrary loopback, another owner and incorrect parent chains', () => {
    const h = fixture()
    expect(h.navigate('http://localhost:12345/')).toBe(false)
    expect(h.navigate('http://viewer-unknown.localhost:12345/')).toBe(false)
    expect(h.navigate(viewerUrl, h.viewer, 18)).toBe(false)
    expect(h.navigate(viewerUrl, h.main)).toBe(false)
    expect(h.navigate(viewerUrl, frame(5, 'about:blank', h.viewer))).toBe(false)
    h.authenticate()
    expect(h.navigate(runtimeUrl, frame(6, 'about:blank', h.main))).toBe(false)
    expect(h.navigate(runtimeUrl, frame(7, 'about:blank', h.project))).toBe(false)
    const otherViewer = frame(8, 'http://viewer-other.localhost:12349/', h.main)
    expect(h.navigate(runtimeUrl, frame(9, 'about:blank', otherViewer))).toBe(false)
    expect(h.navigate(`${runtimeOrigin}/`, h.project, 18)).toBe(false)
    expect(h.navigate('https://example.com/', h.project)).toBe(false)
  })

  it('binds a pending single-use grant to the first sibling frame without rejecting repeated events for that frame', () => {
    const h = fixture()
    const sibling = frame(20, 'about:blank', h.main)
    expect(h.navigate(viewerUrl)).toBe(true)
    expect(h.navigate(viewerUrl)).toBe(true)
    expect(h.navigate(viewerUrl, sibling)).toBe(false)
    h.viewerRegistration.authenticateGrant(viewerGrant)
    expect(h.navigate(`${viewerOrigin}/`)).toBe(true)
    expect(h.navigate(`${viewerOrigin}/`, sibling)).toBe(false)
    const projectSibling = frame(21, 'about:blank', h.viewer)
    expect(h.navigate(runtimeUrl, h.project)).toBe(true)
    expect(h.navigate(runtimeUrl, projectSibling)).toBe(false)
    h.runtimeRegistration.authenticateGrant(runtimeGrant)
    expect(h.navigate(`${runtimeOrigin}/`, h.project)).toBe(true)
    expect(h.navigate(`${runtimeOrigin}/`, projectSibling)).toBe(false)
  })

  it('pins the actual parent and app file entry across redirects, without blocking hash routes', () => {
    const h = fixture()
    h.authenticate()
    const replacedMain = frame(1, 'file:///other/index.html', null)
    expect(
      h.registry.allows({
        url: `${viewerOrigin}/`,
        webContentsId: 17,
        frame: frame(2, `${viewerOrigin}/`, replacedMain),
        mainFrame: replacedMain
      })
    ).toBe(false)
    const hashMain = frame(1, 'file:///app/index.html#/session', null)
    expect(
      h.registry.allows({
        url: `${viewerOrigin}/`,
        webContentsId: 17,
        frame: frame(2, `${viewerOrigin}/`, hashMain),
        mainFrame: hashMain
      })
    ).toBe(true)
    expect(h.navigate(`${runtimeOrigin}/`, { ...h.project, detached: true })).toBe(false)
    expect(h.navigate(`${runtimeOrigin}/`, { ...h.project, isDestroyed: () => true })).toBe(false)
  })

  it.each(['lease', 'viewer-close', 'runtime-close', 'expiry'] as const)(
    'synchronously rejects expired authority: %s',
    (reason) => {
      const h = fixture()
      h.authenticate()
      if (reason === 'lease') h.setCurrent(false)
      if (reason === 'viewer-close') h.viewerRegistration.close()
      if (reason === 'runtime-close') h.runtimeRegistration.close()
      const now =
        reason === 'expiry' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001) : undefined
      try {
        expect(h.navigate(`${runtimeOrigin}/`, h.project)).toBe(false)
        if (reason !== 'runtime-close') expect(h.navigate(`${viewerOrigin}/`)).toBe(false)
      } finally {
        now?.mockRestore()
      }
    }
  )

  it('does not accept unknown, expired, duplicated or cross-origin bootstrap grants', () => {
    const h = fixture()
    expect(h.navigate(`${viewerOrigin}/__open_science_viewer?grant=${'c'.repeat(64)}`)).toBe(false)
    expect(h.navigate(`${viewerUrl}&grant=${viewerGrant}`)).toBe(false)
    expect(h.navigate(`${viewerUrl}#fragment`)).toBe(false)
    expect(() => h.viewerRegistration.issueGrant(runtimeUrl, Date.now() + 1000)).toThrow()
    expect(() => h.viewerRegistration.issueGrant(viewerUrl, Date.now() - 1)).toThrow()
    h.viewerRegistration.authenticateGrant(viewerGrant)
    // HTTP authentication without an admitted frame does not authorize a subsequently created one.
    expect(h.navigate(`${viewerOrigin}/`)).toBe(false)
  })

  it('never treats a task caller or arbitrary HTTP origin as an Electron grant issuer', () => {
    const registry = new DesktopObservationFrameRegistry()
    const caller = createCallerContext({
      clientId: '17',
      lifecycleClientId: 'task',
      leaseId: 'task',
      surface: 'task',
      location: 'local',
      principalKind: 'automation',
      actionOrigin: 'automation'
    })
    expect(() =>
      registry.registerViewer({
        caller,
        origin: viewerOrigin,
        expiresAt: Date.now() + 10000,
        assertCurrent: () => undefined
      })
    ).toThrow()
    expect(() =>
      registry.registerRuntime({
        origin: 'http://localhost:12345',
        parents: [viewerOrigin],
        expiresAt: Date.now() + 10000,
        assertCurrent: () => undefined,
        allowsPath: () => true
      })
    ).toThrow()
  })
})
