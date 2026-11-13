import { parseFragment } from 'parse5'
import { researchVideoFilename } from '../../shared/research-video-presentation'
import type {
  ResearchVideoProgress,
  ResearchVideoExportResult
} from '@aipoch/research-film/contracts'
import type { LocalModelSnapshot } from '../../shared/local-models'
import type { createVideoExportTools } from '@aipoch/research-film'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { ManagedPreviewOwnerRegistry } from '../managed-preview-owner-registry'
import type { ApplicationCallerLease } from '../application-command-router'
import { callerLeaseOwnershipKey } from '../caller-lifecycle'
import { desktopFileInteraction } from '../desktop-interaction'
import { currentDesktopCaller, withDesktopCaller } from '../desktop-native-contract'
import { publishUserFile } from '../user-file-publisher'

const requestSchema = z.object({ resourceId: z.string().min(1).max(200) })
export function createResearchVideoExportControl(
  previews: Pick<ManagedPreviewOwnerRegistry, 'readRange'>,
  tools?: ReturnType<typeof createVideoExportTools<LocalModelSnapshot>>
): {
  export(
    lease: ApplicationCallerLease,
    request: { resourceId: string },
    callerId?: string
  ): Promise<ResearchVideoExportResult>
  progress(
    lease: ApplicationCallerLease,
    request: { resourceId: string }
  ): Promise<ResearchVideoProgress | null>
  cancel(lease: ApplicationCallerLease, request: { resourceId: string }): void
  close(): Promise<void>
} {
  const active = new Map<
    string,
    {
      id: string
      controller: AbortController
      done: Promise<void>
      progress: ResearchVideoProgress
      htmlPath?: string
    }
  >()
  return {
    async progress(lease, rawRequest) {
      const { resourceId } = requestSchema.parse(rawRequest)
      const current = active.get(callerLeaseOwnershipKey(lease))
      if (lease.signal.aborted || !lease.isCurrent() || current?.id !== resourceId) return null
      const native = current.htmlPath
        ? await desktopFileInteraction().researchVideoProgress?.({ htmlPath: current.htmlPath })
        : undefined
      if (active.get(callerLeaseOwnershipKey(lease)) !== current) return null
      return { ...(native ?? current.progress), startedAt: current.progress.startedAt }
    },
    async export(lease, rawRequest, callerId) {
      const { resourceId } = requestSchema.parse(rawRequest)
      const key = callerLeaseOwnershipKey(lease)
      if (active.has(key)) throw new Error('A research video export is already running')
      const controller = new AbortController()
      const signal = AbortSignal.any([lease.signal, controller.signal])
      let settle!: () => void
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      const current = {
        id: resourceId,
        controller,
        done,
        progress: { phase: 'preparing', startedAt: Date.now() } as ResearchVideoProgress,
        htmlPath: undefined as string | undefined
      }
      active.set(key, current)
      let directory: string | undefined
      let releaseTools: (() => void) | undefined
      try {
        const { total } = await previews.readRange(lease, { resourceId, begin: 0, end: 1 })
        if (total > 200 * 1024 * 1024) throw new Error('Research video player exceeds 200 MiB')
        const read = async (begin: number, end: number): Promise<Uint8Array> => {
          signal.throwIfAborted()
          const chunk = await previews.readRange(lease, { resourceId, begin, end })
          if (chunk.total !== total || chunk.data.byteLength !== end - begin)
            throw new Error('Research video source changed')
          return chunk.data
        }
        const prefix = await read(0, Math.min(total, 4096))
        const header = Buffer.from(prefix).toString()
        if (!header.includes('<meta name="open-science-research-video" content="1">'))
          throw new Error('Not a supported research video player')
        const desktop = desktopFileInteraction()
        if (!desktop.renderResearchVideo) throw new Error('MP4 export requires the desktop app')
        if (!tools) throw new Error('Video export components are unavailable')
        if (!(await tools.available(signal)))
          return {
            canceled: false,
            needsInstallation: { downloadBytes: (await tools.snapshot()).downloadBytes }
          }
        const titleNode = parseFragment(header).childNodes.find(
          (node) => 'tagName' in node && node.tagName === 'title'
        )
        const title =
          titleNode && 'childNodes' in titleNode
            ? titleNode.childNodes.flatMap((node) => ('value' in node ? [node.value] : [])).join('')
            : ''
        const selected = await desktop.chooseSavePath(
          {
            defaultPath: researchVideoFilename(title, 'mp4'),
            filters: [{ name: 'MP4', extensions: ['mp4'] }]
          },
          callerId
        )
        signal.throwIfAborted()
        if (selected.canceled || !selected.filePath) return { canceled: true }
        directory = await mkdtemp(join(tmpdir(), 'research-video-export-'))
        const htmlPath = join(directory, 'player.html')
        async function* playerBytes(): AsyncGenerator<Uint8Array> {
          yield prefix
          for (let begin = prefix.byteLength; begin < total; begin += 1024 * 1024) {
            yield await read(begin, Math.min(total, begin + 1024 * 1024))
          }
        }
        await pipeline(playerBytes(), createWriteStream(htmlPath, { flags: 'wx' }), { signal })
        const encoders = await tools.acquire(directory, signal)
        releaseTools = encoders.release
        current.htmlPath = htmlPath
        const caller = currentDesktopCaller()
        const render = (): Promise<string> =>
          desktop.renderResearchVideo!(
            { htmlPath, encoderPath: encoders.encoderPath, probePath: encoders.probePath },
            signal
          )
        const output = await (caller ? withDesktopCaller({ ...caller, signal }, render) : render())
        signal.throwIfAborted()
        current.htmlPath = undefined
        current.progress = { phase: 'publishing', startedAt: current.progress.startedAt }
        await publishUserFile(selected.filePath, (temporary) => copyFile(output, temporary), {
          signal
        })
        return { canceled: false }
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true })
        } finally {
          releaseTools?.()
          active.delete(key)
          settle()
        }
      }
    },
    cancel(lease, rawRequest) {
      const { resourceId } = requestSchema.parse(rawRequest)
      const current = active.get(callerLeaseOwnershipKey(lease))
      if (current?.id === resourceId) current.controller.abort(new Error('Video export cancelled'))
    },
    async close() {
      const running = [...active.values()]
      for (const current of running) current.controller.abort(new Error('Application is closing'))
      await Promise.all(running.map((current) => current.done))
    }
  }
}
