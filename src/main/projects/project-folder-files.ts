import { constants, type BigIntStats, type Stats } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ArtifactPreviewResult } from '../../shared/artifacts'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import { isProjectInternalRecordPath } from '../../shared/project-internal-records'
import type { Project } from '../../shared/projects'
import type {
  ListProjectFolderRequest,
  ProjectFolderListing,
  PublishedArtifactAlias,
  ReadProjectFolderPreviewRequest
} from '../../shared/project-folder-files'
import { getProjectRecordRoot, sameProjectFolderSpelling } from '../storage/data-location-identity'
import { readBoundedManagedFilePreviewLease } from '../managed-file-preview'
import { readExactRange, type ManagedPreviewTrustedLease } from '../managed-preview-resources'

export type FindPublishedArtifactCopies = (
  projectId: string,
  folderRoot: string,
  storageRoot: string,
  candidates: { path: string; info: Stats }[]
) => Promise<Map<string, PublishedArtifactAlias[]>>

type Candidate = { name: string; isDirectory: boolean }
const projectPathSeparator = process.platform === 'win32' ? /[\\/]/ : /\//
const isHiddenProjectPath = (path: string): boolean =>
  path.split(projectPathSeparator).some((part) => part !== '.' && part.startsWith('.'))
const isVisibleProjectEntry = (name: string): boolean =>
  !isHiddenProjectPath(name) && !isProjectInternalRecordPath(name)
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const rank = (entry: Candidate): number =>
  entry.name === 'node_modules' ? 2 : entry.isDirectory ? 0 : 1
const compare = (left: Candidate, right: Candidate): number =>
  rank(left) - rank(right) ||
  collator.compare(left.name, right.name) ||
  (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

// realpath has already captured the filesystem's canonical spelling. Comparing exact ancestor
// names avoids win32.relative's unconditional case folding on case-sensitive directories.
const isPhysicalDescendant = (root: string, target: string): boolean => {
  for (let current = target; ; current = dirname(current)) {
    if (current === root) return true
    if (dirname(current) === current) return false
  }
}

// A bounded max heap keeps only the next page while streaming this one directory. Directory
// size never turns into an index, recursive traversal, or an unbounded collection of stat calls.
const offer = (heap: Candidate[], entry: Candidate, capacity: number): void => {
  if (heap.length < capacity) {
    heap.push(entry)
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1
      if (compare(heap[index], heap[parent]) <= 0) break
      ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
      index = parent
    }
    return
  }
  if (compare(entry, heap[0]) >= 0) return
  heap[0] = entry
  for (let index = 0; ;) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const child = right < heap.length && compare(heap[right], heap[left]) > 0 ? right : left
    if (compare(heap[child], heap[index]) <= 0) break
    ;[heap[index], heap[child]] = [heap[child], heap[index]]
    index = child
  }
}

// This authority accepts Project identity and relative paths only. A saved canonical binding is
// checked again per request; replacing its directory with a link cannot rebind remote Web access.
export class ProjectFolderFiles {
  constructor(
    private readonly getProject: (id: string) => Promise<Project | null>,
    private readonly recordStorageRoot: () => string | undefined = () => undefined,
    private readonly findPublishedArtifactCopies?: FindPublishedArtifactCopies
  ) {}

  private assertRecordBinding(projectId: string, root: string): void {
    const storageRoot = this.recordStorageRoot()
    const recordRoot = storageRoot && getProjectRecordRoot(storageRoot, projectId)
    if (recordRoot && dirname(recordRoot) !== root)
      throw new Error('Project research records are bound to another folder.')
  }

  private async within<T>(projectId: string, operation: (root: string) => Promise<T>): Promise<T> {
    const project = await this.getProject(projectId)
    const root = project?.rootPath
    if (!root)
      throw new ApplicationCommandError(
        'project-folder-unavailable',
        'The Project has no bound folder.'
      )
    try {
      const canonical = await realpath(root)
      if (!sameProjectFolderSpelling(root, canonical))
        throw new Error('The bound folder now points to another location.')
      if (!(await stat(canonical)).isDirectory())
        throw new Error('The bound path is not a directory.')
      this.assertRecordBinding(projectId, canonical)
      return await operation(canonical)
    } catch (error) {
      if (error instanceof ApplicationCommandError) throw error
      const missing = await stat(root).then(
        () => false,
        (cause: NodeJS.ErrnoException) => cause.code === 'ENOENT'
      )
      throw new ApplicationCommandError(
        missing ? 'project-folder-not-found' : 'project-folder-unavailable',
        `Folder: ${root}\n${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async target(root: string, relativePath: string): Promise<string> {
    if (
      isProjectInternalRecordPath(relativePath) ||
      isAbsolute(relativePath) ||
      relativePath.split(projectPathSeparator).includes('..')
    )
      throw new Error('The folder-relative path must not be absolute or contain parent traversal.')
    const path = await realpath(`${root}${sep}${relativePath}`)
    if (!isPhysicalDescendant(root, path) || isProjectInternalRecordPath(relative(root, path)))
      throw new Error('The requested path leaves the Project folder.')
    return path
  }

  // Browsing and search share a visibility rule for requested paths and resolved symlink targets.
  // Explicit references and execution still use the ordinary Project folder authority.
  private async discoveryTarget(root: string, relativePath: string): Promise<string> {
    if (isHiddenProjectPath(relativePath)) throw new Error('Hidden Project folder path.')
    const path = await this.target(root, relativePath)
    if (isHiddenProjectPath(relative(root, path))) throw new Error('Hidden Project folder path.')
    return path
  }

  listFolder(request: ListProjectFolderRequest): Promise<ProjectFolderListing> {
    if (request.searchDescendants) return this.searchFiles(request)
    return this.within(request.projectId, async (root) => {
      const directory = await this.discoveryTarget(root, request.relativePath)
      const directoryIdentity = await stat(directory)
      const relativePath = relative(root, directory)
      let after: Candidate | undefined
      if (request.cursor) {
        const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'))
        if (
          cursor.projectId !== request.projectId ||
          cursor.relativePath !== relativePath ||
          cursor.query !== (request.query ?? '') ||
          typeof cursor.name !== 'string' ||
          typeof cursor.isDirectory !== 'boolean'
        )
          throw new Error('Invalid Project folder cursor.')
        after = { name: cursor.name, isDirectory: cursor.isDirectory }
      }
      const heap: Candidate[] = []
      let totalCount = 0
      const query = request.query?.toLocaleLowerCase() ?? ''
      for await (const entry of await opendir(directory)) {
        if (!isVisibleProjectEntry(entry.name)) continue
        if (query && !entry.name.toLocaleLowerCase().includes(query)) continue
        let isDirectory = entry.isDirectory()
        if (entry.isSymbolicLink()) {
          try {
            const path = await this.discoveryTarget(
              root,
              relative(root, resolve(directory, entry.name))
            )
            isDirectory = (await stat(path)).isDirectory()
          } catch {
            continue
          }
        } else if (!isDirectory && !entry.isFile()) continue
        const candidate = { name: entry.name, isDirectory }
        totalCount += 1
        if (!after || compare(candidate, after) > 0) offer(heap, candidate, request.limit + 1)
      }
      heap.sort(compare)
      const hasMore = heap.length > request.limit
      const page = heap.slice(0, request.limit)
      const entries: ProjectFolderListing['entries'] = []
      for (let offset = 0; offset < page.length; offset += 16) {
        const batch = await Promise.all(
          page.slice(offset, offset + 16).map(async (entry) => {
            try {
              const target = await this.discoveryTarget(
                root,
                relative(root, resolve(directory, entry.name))
              )
              const info = await stat(target)
              if (!info.isDirectory() && !info.isFile()) return undefined
              return {
                name: entry.name,
                isDirectory: info.isDirectory(),
                size: info.isDirectory() ? 0 : info.size,
                mtimeMs: Math.round(info.mtimeMs)
              }
            } catch {
              return undefined
            }
          })
        )
        entries.push(
          ...batch.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        )
      }
      if ((await this.discoveryTarget(root, request.relativePath)) !== directory)
        throw new Error('The listed directory path changed.')
      const currentDirectory = await stat(directory)
      if (
        currentDirectory.dev !== directoryIdentity.dev ||
        currentDirectory.ino !== directoryIdentity.ino
      )
        throw new Error('The listed directory changed.')
      const last = page.at(-1)
      return {
        path: directory,
        relativePath,
        entries,
        totalCount,
        ...(hasMore && last
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({
                  projectId: request.projectId,
                  relativePath,
                  query: request.query ?? '',
                  ...last
                })
              ).toString('base64url')
            }
          : {})
      }
    })
  }

  // Queries are disposable, bounded walks. No recursive index or background watcher is created.
  // A path-qualified query lets users search directly inside a deep or very large directory.
  private searchFiles(request: ListProjectFolderRequest): Promise<ProjectFolderListing> {
    return this.within(request.projectId, async (root) => {
      const directory = await this.discoveryTarget(root, request.relativePath)
      const storageRoot = this.recordStorageRoot()
      const findPublishedCopies =
        request.excludePublishedArtifactCopies && storageRoot
          ? this.findPublishedArtifactCopies
          : undefined
      const candidates: {
        path: string
        info: Stats
        entry: ProjectFolderListing['entries'][number]
      }[] = []
      // Leave room for excluded aliases while keeping Project records reads to one batch.
      const candidateLimit = findPublishedCopies ? request.limit * 2 : request.limit
      const exactCandidate =
        findPublishedCopies &&
        request.relativePath &&
        request.query &&
        !projectPathSeparator.test(request.query)
          ? await this.discoveryTarget(root, `${request.relativePath}/${request.query}`)
              .then(async (path) => ({ path, info: await stat(path) }))
              .catch(() => undefined)
          : undefined
      const pending = [directory]
      const visited = new Set<string>()
      const deadline = Date.now() + 250
      let examined = 0
      let truncated = false
      const query = (request.query ?? '').toLocaleLowerCase()
      outer: while (pending.length) {
        if (visited.size >= 100 || Date.now() > deadline) {
          truncated = true
          break
        }
        const current = pending.shift()!
        if (visited.has(current)) continue
        visited.add(current)
        try {
          for await (const entry of await opendir(current)) {
            if (++examined > 10000 || Date.now() > deadline) {
              truncated = true
              break outer
            }
            if (!isVisibleProjectEntry(entry.name)) continue
            // Symlink directories are not traversed; file resolution verifies containment again.
            if (entry.isDirectory()) {
              if (!['node_modules', 'venv', '__pycache__'].includes(entry.name))
                pending.push(resolve(current, entry.name))
              continue
            }
            if (
              (!entry.isFile() && !entry.isSymbolicLink()) ||
              !entry.name.toLocaleLowerCase().includes(query)
            )
              continue
            try {
              const relativePath = relative(root, resolve(current, entry.name))
              const target = await this.discoveryTarget(root, relativePath)
              const info = await stat(target)
              if (!info.isFile()) continue
              candidates.push({
                path: target,
                info,
                entry: {
                  name: entry.name,
                  relativePath: relativePath.split(sep).join('/'),
                  isDirectory: false,
                  size: info.size,
                  mtimeMs: Math.round(info.mtimeMs)
                }
              })
              if (candidates.length >= candidateLimit) {
                truncated = true
                break outer
              }
            } catch {
              /* An unavailable or escaping entry conveys no capability. */
            }
          }
        } catch {
          if (current === directory) throw new Error('The Project folder could not be searched.')
        }
      }
      const copies =
        storageRoot &&
        (await findPublishedCopies?.(request.projectId, root, storageRoot, [
          ...(exactCandidate?.info.isFile() ? [exactCandidate] : []),
          ...candidates
        ]).catch(() => undefined))
      const publishedArtifacts =
        exactCandidate && copies
          ? copies.get(exactCandidate.path)?.slice(0, request.limit)
          : undefined
      const live = candidates.filter(({ path }) => !copies || !copies.has(path))
      const entries = live.slice(0, request.limit).map(({ entry }) => entry)
      return {
        path: directory,
        relativePath: request.relativePath,
        entries,
        totalCount: entries.length,
        truncated: truncated || live.length > request.limit,
        ...(publishedArtifacts?.length ? { publishedArtifacts } : {})
      }
    })
  }

  resolveFile(projectId: string, relativePath: string): Promise<string> {
    return this.within(projectId, async (root) => {
      const path = await this.target(root, relativePath)
      if (!(await stat(path)).isFile()) throw new Error('The requested path is not a regular file.')
      return path
    })
  }

  openPreview({
    projectId,
    relativePath
  }: Pick<
    ReadProjectFolderPreviewRequest,
    'projectId' | 'relativePath'
  >): Promise<ManagedPreviewTrustedLease> {
    return this.within(projectId, (root) => this.openPreviewLease(root, projectId, relativePath))
  }

  private async openPreviewLease(
    root: string,
    projectId: string,
    relativePath: string
  ): Promise<ManagedPreviewTrustedLease> {
    const path = await this.target(root, relativePath)
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const snapshot = await file.stat({ bigint: true })
      if (!snapshot.isFile() || snapshot.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('The requested path is not a previewable regular file.')
      const size = Number(snapshot.size)
      const matches = (current: BigIntStats): boolean =>
        current.isFile() &&
        current.dev === snapshot.dev &&
        current.ino === snapshot.ino &&
        current.size === snapshot.size &&
        current.mtimeNs === snapshot.mtimeNs &&
        current.ctimeNs === snapshot.ctimeNs
      const verifyUnchanged = async (): Promise<void> => {
        this.assertRecordBinding(projectId, root)
        const savedRoot = (await this.getProject(projectId))?.rootPath
        if (
          !savedRoot ||
          !sameProjectFolderSpelling(savedRoot, root) ||
          (await this.target(root, relativePath)) !== path ||
          !matches(await stat(path, { bigint: true })) ||
          !matches(await file.stat({ bigint: true }))
        )
          throw new Error('Managed preview file changed.')
      }
      await verifyUnchanged()
      const read = file.read.bind(file)
      return {
        path,
        size,
        snapshot,
        versionToken: Number(snapshot.mtimeNs / 1_000_000n),
        read,
        async readRange(begin, end) {
          if (
            !Number.isSafeInteger(begin) ||
            !Number.isSafeInteger(end) ||
            begin < 0 ||
            end < begin ||
            end > size
          )
            throw new Error('Invalid Project folder preview range.')
          await verifyUnchanged()
          const bytes = Buffer.alloc(end - begin)
          await readExactRange({ read }, bytes, begin)
          await verifyUnchanged()
          return bytes
        },
        verifyUnchanged,
        close: () => file.close()
      }
    } catch (error) {
      await file.close()
      throw error
    }
  }

  readFolderPreview(request: ReadProjectFolderPreviewRequest): Promise<ArtifactPreviewResult> {
    return this.within(request.projectId, async (root) => {
      const lease = await this.openPreviewLease(root, request.projectId, request.relativePath)
      try {
        return await readBoundedManagedFilePreviewLease(
          lease,
          { ...request, path: lease.path },
          'Invalid preview encoding.'
        )
      } finally {
        await lease.close()
      }
    })
  }
}
