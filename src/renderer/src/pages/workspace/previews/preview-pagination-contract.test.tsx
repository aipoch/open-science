// @vitest-environment jsdom
import { mkdtemp, open, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedFileReadLease } from '../../../../../main/managed-file-versions/service'
import type {
  AcquireManagedPreviewRequest,
  ReleaseManagedPreviewRequest,
  ReadManagedPreviewRangeRequest
} from '../../../../../shared/preview-resources'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'
import { ManagedPreviewResources } from '../../../../../main/managed-preview-resources'
import { createManagedPreviewOwnerRegistry } from '../../../../../main/managed-preview-ipc'
import { createManagedPreviewProtocolHandler } from '../../../../../main/managed-preview-protocol'
import { ApplicationCallerLeaseRegistry } from '../../../../../main/caller-lifecycle'
import { createElectronCallerContext } from '../../../../../main/caller-context'
import { usePreviewFileContent, PREVIEW_TEXT_MAX_BYTES } from './usePreviewFileContent'
import { PreviewTextContent } from './renderers/TextPreview'
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), unhandle: vi.fn() }
}))
let directory: string | undefined,
  root: Root | undefined,
  container: HTMLDivElement | undefined,
  cleanup: undefined | (() => void)
afterEach(async () => {
  await act(async () => root?.unmount())
  await cleanup?.()
  container?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (directory) await rm(directory, { recursive: true, force: true })
  root = undefined
  cleanup = undefined
  directory = undefined
})
const setup = async (
  size: number
): Promise<{
  path: string
  resources: ManagedPreviewResources
  owners: ReturnType<typeof createManagedPreviewOwnerRegistry>
  caller: ReturnType<ApplicationCallerLeaseRegistry['acquire']>
}> => {
  directory = await mkdtemp(join(tmpdir(), 'preview-contract-'))
  const path = join(directory, 'report.txt')
  await writeFile(path, Buffer.alloc(size, 65))
  const handles: Awaited<ReturnType<typeof open>>[] = []
  const openLease = async (): Promise<ManagedFileReadLease> => {
    const handle = await open(path, 'r')
    handles.push(handle)
    const snapshot = await handle.stat({ bigint: true })
    let closed = false
    // The resource owner consumes only byte-lease operations; version catalog metadata is outside this boundary.
    return {
      path,
      size: Number(snapshot.size),
      versionToken: 1,
      snapshot,
      read: handle.read.bind(handle),
      readRange: async (begin: number, end: number) => {
        const b = Buffer.alloc(end - begin)
        await handle.read(b, 0, b.length, begin)
        return b
      },
      verifyUnchanged: async () => {
        const now = await handle.stat({ bigint: true })
        expect(now.size).toBe(snapshot.size)
        expect(now.mtimeNs).toBe(snapshot.mtimeNs)
      },
      close: async () => {
        if (closed) return
        closed = true
        await handle.close()
      }
    } as unknown as ManagedFileReadLease
  }
  const resources = new ManagedPreviewResources({
    resolvePath: async () => path,
    openLatestManagedFile: openLease,
    openManagedFileVersion: openLease,
    openNotebookInput: openLease
  })
  const lifecycle = new ApplicationCallerLeaseRegistry()
  const caller = lifecycle.acquire(createElectronCallerContext(9))
  const owners = createManagedPreviewOwnerRegistry(resources)
  const acquire = vi.fn((r: AcquireManagedPreviewRequest) => owners.acquire(caller.lease, r))
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    createManagedPreviewProtocolHandler(resources, async (filePath, request) => {
      const bytes = await readFile(filePath)
      const range = request.headers.get('range')!.match(/^bytes=(\d+)-(\d+)$/)!
      const begin = Number(range[1]),
        end = Math.min(bytes.length, Number(range[2]) + 1)
      return new Response(bytes.subarray(begin, end), {
        status: 206,
        headers: { 'Content-Range': `bytes ${begin}-${end - 1}/${bytes.length}` }
      })
    })(new Request(String(input), init))
  )
  window.api = {
    previewResources: {
      acquire,
      release: async (r: ReleaseManagedPreviewRequest) => owners.release(caller.lease, r),
      readRange: (r: ReadManagedPreviewRangeRequest) => owners.readRange(caller.lease, r)
    }
  } as unknown as Window['api']
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  cleanup = async () => {
    caller.release()
    await Promise.all(handles.map((h) => h.close().catch(() => {})))
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  return { path, resources, owners, caller }
}
const Probe = ({
  path,
  source = 'artifact',
  maxBytes,
  maxFileBytes
}: {
  path: string
  source?: PreviewFileSource
  maxBytes?: number
  maxFileBytes?: number
}): React.JSX.Element => {
  const result = usePreviewFileContent({
    path,
    source,
    projectId: 'p',
    managedFileId: 'f',
    selectedVersionId: 'old',
    maxBytes,
    maxFileBytes
  })
  return result.status === 'ready' ? (
    <button onClick={result.pagination.nextPage} disabled={!result.pagination.hasNext}>
      {result.preview.content}
    </button>
  ) : (
    <div>{result.status}</div>
  )
}
const settle = async (expected?: string | (() => boolean)): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    if (
      typeof expected === 'function' ? expected() : !expected || container!.textContent === expected
    ) {
      return
    }
  }
}
it.each(['artifact', 'upload', 'notebook-input', 'local'] as const)(
  'reads bounded pages of a larger %s file',
  async (source) => {
    const env = await setup(8)
    await act(async () => root!.render(<Probe path={env.path} source={source} maxBytes={4} />))
    await settle('AAAA')
    expect(container!.textContent).toBe('AAAA')
    expect(container!.querySelector('button')?.disabled).toBe(false)
    await act(async () => container!.querySelector('button')!.click())
    await settle('AAAA')
    expect(container!.textContent).toBe('AAAA')
    expect(container!.querySelector('button')?.disabled).toBe(true)
  }
)
it('text above 1 MiB exposes bounded page navigation', async () => {
  const env = await setup(PREVIEW_TEXT_MAX_BYTES + 1)
  await act(async () =>
    root!.render(
      <PreviewTextContent
        path={env.path}
        name="report.txt"
        source="artifact"
        projectId="p"
        managedFileId="f"
        selectedVersionId="old"
      />
    )
  )
  await settle(() => container!.querySelector('[aria-label="Next preview page"]') !== null)
  expect(container!.querySelector('[aria-label="Next preview page"]')).not.toBeNull()
})
it('same resource and protocol can serve bounded pages when no whole-file admission cap is requested', async () => {
  const env = await setup(8)
  const resource = await env.owners.acquire(env.caller.lease, {
    source: 'artifact',
    projectId: 'p',
    fileId: 'f',
    versionId: 'old'
  })
  const handler = createManagedPreviewProtocolHandler(env.resources)
  const first = await handler(new Request(resource.url, { headers: { Range: 'bytes=0-3' } })),
    second = await handler(new Request(resource.url, { headers: { Range: 'bytes=4-7' } }))
  expect(await first.text()).toBe('AAAA')
  expect(await second.text()).toBe('AAAA')
  env.owners.release(env.caller.lease, { resourceId: resource.id })
})

it('retains an explicit full-file admission cap independently of the page size', async () => {
  const env = await setup(8)
  await act(async () => root!.render(<Probe path={env.path} maxBytes={4} maxFileBytes={8} />))
  await settle('AAAA')
  expect(container!.textContent).toBe('AAAA')
  await act(async () => root!.render(<Probe path={env.path} maxBytes={4} maxFileBytes={7} />))
  await settle('error')
  expect(container!.textContent).toBe('error')
})
