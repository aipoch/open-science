import { createHash } from 'node:crypto'
import type { CallerContext } from '../caller-context'

/** Supplied only by the window's real WebFrameMain tree, never renderer message data. */
export type DesktopObservationFrame = {
  readonly frameTreeNodeId: number
  readonly url: string
  readonly parent: DesktopObservationFrame | null
  readonly detached?: boolean
  isDestroyed?(): boolean
}
export type DesktopObservationNavigation = {
  url: string
  webContentsId: number
  frame: DesktopObservationFrame | null | undefined
  mainFrame: DesktopObservationFrame
}
export type DesktopObservationRegistration = {
  issueGrant(url: string, expiresAt: number): void
  authenticateGrant(grant: string): void
  close(): void
}
type FrameBinding = {
  frame: DesktopObservationFrame
  mainId: number
  mainEntry: string
  parentId: number
  grant?: string
  authenticated: boolean
}
type Entry = {
  origin: string
  bootstrap: string
  expiresAt: number
  assertCurrent(): void
  grants: Map<string, { expiresAt: number; frameId?: number }>
  frames: Map<number, FrameBinding>
  ownerId?: number
  parents?: readonly string[]
  allowsPath?(path: string): boolean
}
const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex')
const validFrame = (frame: DesktopObservationFrame): boolean =>
  Number.isSafeInteger(frame.frameTreeNodeId) &&
  frame.frameTreeNodeId >= 0 &&
  !frame.detached &&
  !frame.isDestroyed?.()
function parse(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.username || url.password ? undefined : url
  } catch {
    return undefined
  }
}
function appEntry(value: string): string | undefined {
  const url = parse(value)
  return url?.protocol === 'file:' ? `${url.protocol}//${url.host}${url.pathname}` : undefined
}
function registeredOrigin(value: string, kind: 'viewer' | 'rv'): string {
  const url = parse(value)
  if (
    !url ||
    url.origin !== value ||
    url.protocol !== 'http:' ||
    !url.port ||
    !new RegExp(`^${kind}-[a-zA-Z0-9-]+\\.localhost$`).test(url.hostname)
  )
    throw new Error('Invalid observation frame origin.')
  return value
}

/** Navigation admission only. The HTTP owners still validate every grant, cookie and request. */
export class DesktopObservationFrameRegistry {
  private readonly viewers = new Map<string, Entry>()
  private readonly runtimes = new Map<string, Entry>()

  registerViewer(options: {
    origin: string
    caller: CallerContext
    expiresAt: number
    assertCurrent(): void
  }): DesktopObservationRegistration {
    const ownerId = Number(options.caller.clientId)
    if (
      options.caller.surface !== 'electron' ||
      options.caller.location !== 'local' ||
      !Number.isSafeInteger(ownerId) ||
      ownerId <= 0 ||
      String(ownerId) !== options.caller.clientId
    )
      throw new Error('Desktop observations require an exact Electron owner.')
    const caller = options.caller
    const assertCurrent = (): void => {
      if (!caller.isAuthorizationCurrent()) throw new Error('Observation owner lease ended.')
      options.assertCurrent()
    }
    return this.register(this.viewers, {
      origin: registeredOrigin(options.origin, 'viewer'),
      ownerId,
      bootstrap: '/__open_science_viewer',
      expiresAt: options.expiresAt,
      assertCurrent,
      grants: new Map(),
      frames: new Map()
    })
  }

  registerRuntime(options: {
    origin: string
    parents: readonly string[]
    expiresAt: number
    assertCurrent(): void
    allowsPath(path: string): boolean
  }): DesktopObservationRegistration {
    return this.register(this.runtimes, {
      origin: registeredOrigin(options.origin, 'rv'),
      bootstrap: '/__open_science_view',
      parents: Object.freeze([...options.parents]),
      expiresAt: options.expiresAt,
      assertCurrent: options.assertCurrent,
      allowsPath: options.allowsPath,
      grants: new Map(),
      frames: new Map()
    })
  }

  private register(entries: Map<string, Entry>, entry: Entry): DesktopObservationRegistration {
    if (entries.has(entry.origin) || entries.size >= 128 || entry.expiresAt <= Date.now())
      throw new Error('Observation frame registration is unavailable.')
    entry.assertCurrent()
    entries.set(entry.origin, entry)
    const current = (): boolean => {
      if (entries.get(entry.origin) !== entry || Date.now() >= entry.expiresAt) return false
      try {
        entry.assertCurrent()
        return true
      } catch {
        return false
      }
    }
    return {
      issueGrant: (value, expiresAt): void => {
        if (!current()) throw new Error('Observation frame registration ended.')
        const url = parse(value)
        const grant = url?.searchParams.get('grant')
        if (
          !url ||
          url.origin !== entry.origin ||
          url.pathname !== entry.bootstrap ||
          url.hash ||
          [...url.searchParams.keys()].length !== 1 ||
          !grant ||
          !/^[a-f0-9]{64}$/.test(grant) ||
          expiresAt <= Date.now()
        )
          throw new Error('Invalid observation navigation grant.')
        for (const [key, grant] of entry.grants) {
          if (grant.expiresAt <= Date.now()) entry.grants.delete(key)
        }
        if (entry.grants.size >= 8) throw new Error('Too many observation navigation grants.')
        const key = digest(grant)
        if (entry.grants.has(key)) throw new Error('Observation navigation grant already issued.')
        entry.grants.set(key, { expiresAt: Math.min(expiresAt, entry.expiresAt) })
      },
      authenticateGrant: (grant): void => {
        if (!current()) return
        const key = digest(grant)
        const admitted = entry.grants.get(key)
        entry.grants.delete(key)
        if (!admitted || admitted.expiresAt <= Date.now() || admitted.frameId === undefined) return
        const frame = entry.frames.get(admitted.frameId)
        if (frame?.grant === key) {
          frame.authenticated = true
          delete frame.grant
        }
      },
      close: (): void => {
        if (entries.get(entry.origin) === entry) entries.delete(entry.origin)
        entry.grants.clear()
        entry.frames.clear()
      }
    }
  }

  allows(input: DesktopObservationNavigation): boolean {
    try {
      const { frame, mainFrame, webContentsId } = input
      const url = parse(input.url)
      const entry = url && (this.viewers.get(url.origin) ?? this.runtimes.get(url.origin))
      const mainEntry = appEntry(mainFrame.url)
      if (
        !url ||
        !entry ||
        !frame ||
        !validFrame(frame) ||
        !validFrame(mainFrame) ||
        !mainEntry ||
        mainFrame.parent !== null ||
        frame.frameTreeNodeId === mainFrame.frameTreeNodeId ||
        Date.now() >= entry.expiresAt
      )
        return false
      entry.assertCurrent()
      const parent = frame.parent
      if (!parent || !validFrame(parent)) return false
      if (entry.ownerId !== undefined) {
        if (
          entry.ownerId !== webContentsId ||
          parent.frameTreeNodeId !== mainFrame.frameTreeNodeId ||
          parent.parent !== null ||
          appEntry(parent.url) !== mainEntry
        )
          return false
      } else {
        const viewerOrigin = parse(parent.url)?.origin
        const viewer = viewerOrigin ? this.viewers.get(viewerOrigin) : undefined
        const viewerFrame = viewer?.frames.get(parent.frameTreeNodeId)
        if (
          !viewer ||
          viewer.ownerId !== webContentsId ||
          Date.now() >= viewer.expiresAt ||
          !viewerFrame?.authenticated ||
          viewerFrame.mainId !== mainFrame.frameTreeNodeId ||
          viewerFrame.mainEntry !== mainEntry ||
          !parent.parent ||
          !validFrame(parent.parent) ||
          parent.parent.frameTreeNodeId !== mainFrame.frameTreeNodeId ||
          parent.parent.parent !== null ||
          appEntry(parent.parent.url) !== mainEntry ||
          !entry.parents?.includes(viewer.origin)
        )
          return false
        viewer.assertCurrent()
      }
      for (const [id, binding] of entry.frames) {
        if (!validFrame(binding.frame)) entry.frames.delete(id)
      }
      if (url.pathname === entry.bootstrap) {
        const grant = url.searchParams.get('grant')
        if (!grant || url.hash || [...url.searchParams.keys()].length !== 1) return false
        const key = digest(grant)
        const admitted = entry.grants.get(key)
        if (
          !admitted ||
          admitted.expiresAt <= Date.now() ||
          (admitted.frameId !== undefined && admitted.frameId !== frame.frameTreeNodeId)
        )
          return false
        const previous = entry.frames.get(frame.frameTreeNodeId)
        if (!previous && entry.frames.size >= 8) return false
        admitted.frameId = frame.frameTreeNodeId
        entry.frames.set(frame.frameTreeNodeId, {
          frame,
          mainId: mainFrame.frameTreeNodeId,
          mainEntry,
          parentId: parent.frameTreeNodeId,
          grant: key,
          authenticated: false
        })
        return true
      }
      const binding = entry.frames.get(frame.frameTreeNodeId)
      return (
        !!binding?.authenticated &&
        binding.mainId === mainFrame.frameTreeNodeId &&
        binding.mainEntry === mainEntry &&
        binding.parentId === parent.frameTreeNodeId &&
        (entry.allowsPath ? entry.allowsPath(url.pathname + url.search) : url.pathname === '/')
      )
    } catch {
      return false
    }
  }
}

export const desktopObservationFrameRegistry = new DesktopObservationFrameRegistry()
