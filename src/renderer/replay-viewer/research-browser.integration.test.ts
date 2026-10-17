import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { it } from 'vitest'
import { ResearchReplayHttpHost } from '../../main/research-replay/http-host'
import {
  ResearchReplayService,
  type ResearchReplayDependencies
} from '../../main/research-replay/service'
import { createReplayViewerAssetReader } from '../../main/replay-viewer/assets'
import { createTaskCallerContext } from '../../main/caller-context'
import type { ReplaySourceData } from '../src/lib/replay/source'
import { indexReplayRun } from '../src/lib/replay/run-index'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import { recordedBrowserPayloadSchema } from '../../shared/browser-recording'

// Optional acceptance against an already exported/imported research. Reads saved bytes only.
// Supply RESEARCH_REPLAY_SOURCE_FIXTURE, RESEARCH_REPLAY_RECORDING_FIXTURE and RESEARCH_REPLAY_DATA_ROOT.
it.skipIf(process.env.RUN_RESEARCH_REPLAY_BROWSER !== '1')(
  'production research viewer unifies saved conversations, Notebook, game footage and references',
  async () => {
    const sourcePath = process.env.RESEARCH_REPLAY_SOURCE_FIXTURE!,
      recordingPath = process.env.RESEARCH_REPLAY_RECORDING_FIXTURE!,
      dataRoot = process.env.RESEARCH_REPLAY_DATA_ROOT!
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as ReplaySourceData
    const fullRuns = source.runs as NotebookRunRecord[]
    const payload = recordedBrowserPayloadSchema.parse(
      JSON.parse(await readFile(recordingPath, 'utf8'))
    )
    const target = { projectId: source.session.projectId, sessionId: source.session.id }
    const artifactByVersion = new Map(
      source.session.artifacts?.map((item) => [item.versionId, item])
    )
    const inputs = new Map<string, NotebookRunInputFile>()
    for (const resource of source.resources) {
      if (
        !resource.versionId ||
        !resource.artifactId ||
        !resource.checksum ||
        resource.size === undefined
      )
        continue
      inputs.set(resource.versionId, {
        sourceKind: 'artifact-version',
        sourceProjectId: target.projectId,
        sourceSessionId: target.sessionId,
        sourceFileId: resource.artifactId,
        inputFileVersionId: resource.versionId,
        sourceVersionNumber: resource.versionNumber ?? 1,
        filename: resource.name,
        sizeBytes: resource.size,
        checksum: resource.checksum,
        storageKey: resource.versionId,
        association: 'turn-attached'
      })
    }
    const savedBytes = async (versionId: string): Promise<Buffer> => {
      const artifact = artifactByVersion.get(versionId),
        input = inputs.get(versionId)
      if (!artifact?.path?.startsWith('$DATA/') || !input)
        throw new Error('Saved fixture version unavailable')
      const bytes = await readFile(join(dataRoot, artifact.path.slice(6)))
      expect(bytes.byteLength).toBe(input.sizeBytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.checksum)
      return bytes
    }
    const mediaVersions = new Set(payload.media.map((item) => item.versionId))
    let mediaReads = 0
    const unsupported = async (): Promise<never> => {
      throw new Error('Unsupported fixture recording')
    }
    const dependencies: ResearchReplayDependencies = {
      reader: {
        sessions: { loadOne: async () => source.session },
        notebook: {
          runIndex: async () => fullRuns.map(indexReplayRun),
          getReference: async () => null,
          state: unsupported
        },
        artifacts: {
          getLineage: async (request) => ({
            artifactId: request.artifactId,
            filename:
              source.resources.find((resource) => resource.artifactId === request.artifactId)
                ?.name ?? 'recorded-file',
            originSession: { sessionId: target.sessionId, state: 'active' as const },
            versions: source.resources
              .filter((resource) => resource.artifactId === request.artifactId)
              .map((resource) => ({
                ...resource,
                artifactId: request.artifactId,
                versionId: resource.versionId!,
                checksum: resource.checksum!,
                size: resource.size ?? 0,
                mtimeMs: resource.createdAt ?? 0,
                state: 'finalized' as const,
                createdAt: new Date(resource.createdAt ?? 0).toISOString(),
                versionNumber: resource.versionNumber ?? 1
              }))
          })
        }
      },
      recordings: {
        read: unsupported,
        readProject: unsupported,
        readMedia: unsupported,
        readProjectMedia: unsupported,
        readBrowser: async () => payload,
        readBrowserMedia: unsupported,
        selectBrowserMoment: async (_target, offsetMs) => {
          const segment = payload.recording.segments.find(
              (item) => offsetMs >= item.startMs && offsetMs < item.endMs
            )!,
            media = payload.media.find((item) => item.mediaKey === segment.mediaKey)!,
            declared = payload.recording.media.find((item) => item.mediaKey === segment.mediaKey)!
          return {
            kind: 'recorded-project-moment',
            selectionId: 'recorded-moment',
            selectedAt: Date.now(),
            receiving: payload.receiving,
            indexChecksum: payload.indexChecksum,
            recordingId: payload.recording.recordingId,
            offsetMs,
            segmentOffsetMs: offsetMs - segment.startMs,
            segmentId: segment.segmentId,
            mediaKey: segment.mediaKey,
            resource: {
              projectId: target.projectId,
              sessionId: target.sessionId,
              artifactId: media.artifactId,
              versionId: media.versionId,
              name: declared.name,
              mimeType: declared.mimeType,
              checksum: media.checksum,
              sizeBytes: media.sizeBytes
            }
          }
        },
        selectFile: unsupported
      },
      immutable: {
        resolveVersion: async (request) => inputs.get(request.inputFileVersionId),
        openContent: async (input) => {
          const bytes = await savedBytes(input.inputFileVersionId)
          // The research viewer reads the selected immutable Version directly from its
          // verified snapshot; the full-recording reader must not run for each video segment.
          if (mediaVersions.has(input.inputFileVersionId)) mediaReads++
          return {
            readRange: async (offset: number, length: number) =>
              bytes.subarray(offset, offset + length),
            verifyUnchanged: async () => undefined,
            close: async () => undefined
          } as never
        }
      },
      authorize: async (request) => {
        expect(request).toEqual(target)
      },
      readRun: async (_target, runId) => fullRuns.find((run) => run.runId === runId)
    }
    const service = new ResearchReplayService(dependencies),
      host = new ResearchReplayHttpHost(
        service,
        createReplayViewerAssetReader(resolve('out/replay-viewer'))
      )
    const browser = await chromium.launch({ headless: true }),
      caller = createTaskCallerContext({ clientId: 'research-browser-acceptance' })
    const evidenceDir = process.env.RESEARCH_REPLAY_EVIDENCE_DIR
    if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
    try {
      const access = await host.open(target, caller),
        page = await browser.newPage({ viewport: { width: 1000, height: 900 }, locale: 'en-US' }),
        errors: string[] = [],
        requests: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname.startsWith('/api/')) requests.push(url.pathname)
      })
      await page.goto(access.url)
      await expect(page.getByTestId('research-replay-viewer')).toBeVisible()
      const doc = await service.document(access.viewerId, caller),
        branch = doc.document.branches.find((item) => item.id === doc.document.defaultBranchId)!
      const slider = page.getByRole('slider', { name: 'Replay progress' }),
        origin = branch.steps[0].recordedAt!,
        firstOffset = payload.recording.startedAt + payload.recording.segments[0].startMs - origin
      await expect(slider).toHaveAttribute('aria-valuemax', String(branch.durationMs))
      await expect(slider).toHaveAttribute('aria-valuenow', '0')
      await expect(page.getByRole('tab', { name: 'Project replay', exact: true })).toBeVisible()
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, '00-context.png') })
      await page.getByRole('tab', { name: 'Project replay', exact: true }).click()
      await expect(
        page.getByText('The project recording has not started yet.', { exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Jump to recorded footage', exact: true }).click()
      await expect(slider).toHaveAttribute('aria-valuenow', String(firstOffset))
      const video = page.getByLabel('Recorded webpage', { exact: true })
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      await expect(page.getByRole('slider')).toHaveCount(1)
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, '01-footage.png') })
      await expect(page.getByRole('combobox', { name: 'Playback speed' })).toContainText('2×')
      await page.getByRole('button', { name: 'Play replay', exact: true }).click()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.playbackRate))
        .toBe(2)
      await expect
        .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
        .toBeGreaterThan(firstOffset + 1000)
      await page.getByRole('button', { name: 'Pause replay', exact: true }).click()
      const paused = Number(await slider.getAttribute('aria-valuenow'))
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(true)
      await page.getByRole('tab', { name: 'Results', exact: true }).click()
      await expect(slider).toHaveAttribute('aria-valuenow', String(paused))
      await page.getByRole('combobox', { name: 'Result visibility' }).selectOption('all')
      await expect(
        page.getByText('Showing results from the entire research, including later records.', {
          exact: true
        })
      ).toBeVisible()
      await page.getByRole('tab', { name: 'Project replay', exact: true }).click()
      await expect(slider).toHaveAttribute('aria-valuenow', String(paused))
      await expect(video).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Ask about this moment', exact: true })
      ).toBeEnabled()
      await page.getByRole('button', { name: 'Ask about this moment', exact: true }).click()
      await page.getByText('Saved reference details', { exact: true }).click()
      const reference = page.getByRole('textbox', { name: 'Recorded moment reference' })
      await expect(reference).toBeVisible()
      const selected = JSON.parse(await reference.inputValue()),
        saved = await service.selection(access.viewerId, caller, selected.selectionId)
      expect(saved?.moment?.resource.versionId).toBeTruthy()
      expect(
        Math.abs((saved?.position.recordedAt ?? 0) - origin - (saved?.position.timeMs ?? 0))
      ).toBeLessThan(1)
      await slider.focus()
      await slider.press('ArrowRight')
      await expect(slider).toHaveAttribute(
        'aria-valuenow',
        String(Math.round(Math.min(branch.durationMs, paused + 5000)))
      )
      expect(JSON.parse(await reference.inputValue())).toEqual(selected)
      const track = page.getByTestId('replay-progress-track')
      const box = (await track.boundingBox())!
      const dragTo = Math.min(branch.durationMs - 1000, firstOffset + 15000)
      await page.mouse.move(
        box.x + (box.width * paused) / branch.durationMs,
        box.y + box.height / 2
      )
      await page.mouse.down()
      await page.mouse.move(
        box.x + (box.width * dragTo) / branch.durationMs,
        box.y + box.height / 2,
        { steps: 4 }
      )
      await page.mouse.up()
      const dragged = Number(await slider.getAttribute('aria-valuenow'))
      expect(Math.abs(dragged - dragTo)).toBeLessThan(300)
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      expect(JSON.parse(await reference.inputValue())).toEqual(selected)
      await page.reload()
      await expect(page.getByTestId('research-replay-viewer')).toBeVisible()
      await expect(slider).toHaveAttribute('aria-valuenow', String(dragged))
      await page.getByText('Saved reference details', { exact: true }).click()
      const afterReload = JSON.parse(
        await page.getByRole('textbox', { name: 'Recorded moment reference' }).inputValue()
      )
      expect(afterReload).toEqual(selected)
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      await expect(
        page.getByRole('button', { name: 'Ask about this moment', exact: true })
      ).toBeEnabled()
      await page.getByText('Saved reference details', { exact: true }).click()
      for (const width of [360, 480, 720, 1200]) {
        await page.setViewportSize({ width, height: 800 })
        const footer = page.getByTestId('replay-question-footer')
        await expect(footer).toBeVisible()
        const layout = await page.evaluate(() => {
          const footer = document
            .querySelector('[data-testid="replay-question-footer"]')!
            .getBoundingClientRect()
          const stage = document
            .querySelector('[data-testid="recorded-media-scroll"]')!
            .getBoundingClientRect()
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            footerBottom: footer.bottom,
            stageHeight: stage.height,
            height: innerHeight
          }
        })
        expect(layout.overflow).toBe(false)
        expect(layout.footerBottom).toBeLessThanOrEqual(layout.height + 1)
        expect(layout.stageHeight).toBeGreaterThan(120)
        await expect(slider).toHaveAttribute('aria-valuenow', String(dragged))
        if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `width-${width}.png`) })
      }
      await page.getByRole('button', { name: 'Enter full screen', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')))
        .toBe('replay-panel')
      await page.getByTestId('replay-information-trigger').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      expect(
        await page
          .getByRole('dialog')
          .evaluate((element) => document.fullscreenElement?.contains(element))
      ).toBe(true)
      await page.keyboard.press('Escape')
      if (await page.getByRole('button', { name: 'Exit full screen', exact: true }).count())
        await page.getByRole('button', { name: 'Exit full screen', exact: true }).click()
      await expect(slider).toHaveAttribute('aria-valuenow', String(dragged))
      if (evidenceDir) {
        await page.screenshot({ path: join(evidenceDir, '02-reference.png') })
        await writeFile(
          join(evidenceDir, 'evidence.json'),
          JSON.stringify(
            {
              durationMs: branch.durationMs,
              firstFootageMs: firstOffset,
              pausedMs: paused,
              draggedMs: dragged,
              selection: {
                stepId: saved?.position.stepId,
                recordedAt: saved?.position.recordedAt,
                offsetMs: saved?.moment?.offsetMs,
                versionId: saved?.moment?.resource.versionId
              },
              mediaReads,
              errors,
              requestPaths: [...new Set(requests)]
            },
            null,
            2
          )
        )
      }
      expect(mediaReads).toBeGreaterThan(0)
      expect(errors).toEqual([])
      expect(
        requests.every((path) => path === '/api/context' || path.startsWith('/api/research/'))
      ).toBe(true)
    } finally {
      await browser.close()
      host.close()
    }
  },
  60000
)
