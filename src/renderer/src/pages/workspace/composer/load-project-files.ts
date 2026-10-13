import type { ProjectFileItem } from '../../../../../shared/project-files'

const PROJECT_FILE_PAGE_SIZE = 100

export const loadAllProjectFiles = async (
  projectId: string,
  isCurrent: () => boolean = () => true
): Promise<ProjectFileItem[]> => {
  const files: ProjectFileItem[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    if (!isCurrent()) throw new Error('Project file read was cancelled.')
    const page = await window.api.projectFiles.listFiles({
      projectId,
      collection: { kind: 'all' },
      limit: PROJECT_FILE_PAGE_SIZE,
      ...(cursor ? { cursor } : {})
    })
    if (!isCurrent()) throw new Error('Project file read was cancelled.')
    files.push(...page.items)
    cursor = page.nextCursor
    if (cursor && seenCursors.has(cursor)) {
      throw new Error('Project Files returned a repeated file cursor.')
    }
    if (cursor) seenCursors.add(cursor)
  } while (cursor)

  return files
}
