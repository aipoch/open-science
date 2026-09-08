import { describe, expect, it, vi, type Mock } from 'vitest'
import { createProjectFilesHandlers, type ProjectFilesQueryRepository } from './ipc'
import type { SearchFileOpener } from './content-search'
import type { ProjectFileItem, SearchArtifactsRequest } from '../../shared/project-files'

const file = (index: number): ProjectFileItem => ({
  id: `upload:${index}`,
  source: 'upload',
  sourceFileId: `file-${index}`,
  sourceVersionId: `version-${index}`,
  projectId: 'project',
  sessionId: 'session',
  name: `notes-${index}.md`,
  path: `upload-version:version-${index}`,
  size: 10,
  sortAtMs: index
})
const request: SearchArtifactsRequest = {
  primaryProjectIds: ['project'],
  otherProjectIds: [],
  source: 'upload',
  filenameContains: 'needle',
  searchContent: true,
  primaryLimit: 10,
  otherLimit: 0
}
const setup = (
  items: ProjectFileItem[],
  content: (item: ProjectFileItem) => string
): {
  handlers: ReturnType<typeof createProjectFilesHandlers>
  open: Mock<SearchFileOpener>
  close: Mock<() => Promise<void>>
  repository: ProjectFilesQueryRepository
} => {
  const close = vi.fn(async () => {})
  const open = vi.fn(async (item: ProjectFileItem) => {
    const bytes = Buffer.from(content(item))
    return {
      size: bytes.length,
      read: async (target: Uint8Array, offset: number, length: number, position: number) => {
        const part = bytes.subarray(position, position + length)
        target.set(part, offset)
        return { bytesRead: part.length }
      },
      verifyUnchanged: vi.fn(async () => {}),
      close
    }
  })
  const repository = {
    searchArtifacts: vi.fn(async (input: SearchArtifactsRequest) => ({
      primary: {
        items: items.filter(
          (item) => !input.filenameContains || item.name.includes(input.filenameContains)
        ),
        totalCount: items.length
      },
      other: [],
      isIndexComplete: true
    }))
  } as unknown as ProjectFilesQueryRepository
  const handlers = createProjectFilesHandlers(
    repository,
    { repairProjectFiles: vi.fn() },
    { waitForProjectOperations: vi.fn(), recoverPendingDeletions: vi.fn() },
    open
  )
  return { handlers, open, close, repository }
}

describe('global file content search', () => {
  it('reuses content locations beyond 256 files while rechecking catalog membership', async () => {
    const items = Array.from({ length: 300 }, (_, index) => file(index))
    const { handlers, open } = setup(items, () => 'needle')
    const first = await handlers.searchArtifacts(request)
    expect(first.primary.totalCount).toBe(300)
    expect(open).toHaveBeenCalledTimes(300)
    items.splice(0, 1)
    const second = await handlers.searchArtifacts({
      ...request,
      primaryCursor: first.primary.nextCursor
    })
    expect(second.primary.totalCount).toBe(299)
    expect(second.primary.items).toHaveLength(10)
    expect(open).toHaveBeenCalledTimes(300)
    const changed = { ...items[0]!, sourceVersionId: 'new-version' }
    items[0] = changed
    await handlers.searchArtifacts(request)
    expect(open).toHaveBeenCalledTimes(301)
  })

  it('finds text-only matches and returns a location for the preview', async () => {
    const { handlers, close } = setup([file(1)], () => '# Heading\nA needle in the body.')
    const result = await handlers.searchArtifacts(request)
    expect(result.primary.items).toHaveLength(1)
    expect(result.primary.items[0]?.contentMatch).toEqual({ offset: 0, startingLineNumber: 1 })
    expect(close).toHaveBeenCalledOnce()
  })
  it('searches beyond the initial preview page and across read boundaries', async () => {
    const { handlers } = setup([file(1)], () => 'A line\n'.repeat(160000) + 'needle')
    const result = await handlers.searchArtifacts(request)
    expect(result.primary.items).toHaveLength(1)
    expect(result.primary.items[0]!.contentMatch!.offset).toBeGreaterThan(1024 * 1024)
  })
  it('pages text matches ten at a time and binds the cursor to the query', async () => {
    const { handlers } = setup(
      Array.from({ length: 23 }, (_, index) => file(index)),
      () => 'needle'
    )
    const first = await handlers.searchArtifacts(request)
    expect(first.primary.totalCount).toBe(23)
    expect(first.primary.items).toHaveLength(10)
    const second = await handlers.searchArtifacts({
      ...request,
      primaryCursor: first.primary.nextCursor
    })
    expect(second.primary.items).toHaveLength(10)
    expect(
      new Set([...first.primary.items, ...second.primary.items].map((item) => item.id)).size
    ).toBe(20)
    await expect(
      handlers.searchArtifacts({
        ...request,
        filenameContains: 'changed',
        primaryCursor: first.primary.nextCursor
      })
    ).rejects.toThrow(/cursor/i)
  })
  it('skips binary formats and unreadable files while keeping filename matches', async () => {
    const { handlers, open } = setup(
      [{ ...file(1), name: 'figure.png' }, { ...file(2), name: 'needle.pdf' }, file(3)],
      () => 'needle'
    )
    open.mockRejectedValueOnce(new Error('File unavailable'))
    const result = await handlers.searchArtifacts(request)
    expect(result.primary.items.map((item) => item.name)).toEqual(['needle.pdf'])
    expect(open).toHaveBeenCalledTimes(1)
  })
})
