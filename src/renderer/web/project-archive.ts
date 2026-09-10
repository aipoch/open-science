import { zipSync } from 'fflate'
import type {
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveProjectArtifactFailure
} from '../../shared/file-save'
import type { ArtifactPreviewResult } from '../../shared/artifacts'
import type {
  ManagedPreviewResource,
  ManagedPreviewRangeResult
} from '../../shared/preview-resources'

// Browser downloads use the same authoritative readers as desktop exports. Hidden reads are
// explicit, bounded chunks; ordinary preview resources never gain hidden access.
export const saveWebProjectArchive = async (
  request: SaveProjectArtifactsRequest,
  invoke: (channel: string, args: unknown[]) => Promise<unknown>,
  download: (blob: Blob, name: string) => void,
  maxBytes: number
): Promise<SaveProjectArtifactsResult> => {
  const entries: Record<string, Uint8Array> = Object.create(null)
  const failures: SaveProjectArtifactFailure[] = []
  const includedFiles: Array<SaveProjectArtifactsRequest['files'][number] & { size: number }> = []
  let totalBytes = 0
  for (const file of request.files) {
    let resource: ManagedPreviewResource | undefined
    try {
      let bytes: Uint8Array
      if (file.hidden) {
        if (file.source !== 'artifact') throw new Error('Only artifacts can be hidden.')
        const parts: Uint8Array[] = []
        let offset = 0
        let size: number | undefined
        do {
          const part = (await invoke('project-files:read-hidden-artifact', [
            {
              projectId: request.projectId,
              fileId: file.fileId,
              versionId: file.versionId,
              encoding: 'base64',
              offset
            }
          ])) as ArtifactPreviewResult
          if (part.size + totalBytes > maxBytes)
            throw new Error('Archive exceeds the Web download size limit.')
          if (size !== undefined && size !== part.size)
            throw new Error('File changed during download.')
          size = part.size
          const chunk = Uint8Array.from(atob(part.content), (character) => character.charCodeAt(0))
          if (chunk.length === 0 && offset < size)
            throw new Error('Incomplete hidden file download.')
          parts.push(chunk)
          offset += chunk.length
        } while (offset < size)
        bytes = new Uint8Array(size)
        let position = 0
        for (const part of parts) {
          bytes.set(part, position)
          position += part.length
        }
      } else {
        resource = (await invoke('preview-resources:acquire', [
          {
            source: file.source,
            projectId: request.projectId,
            fileId: file.fileId,
            versionId: file.versionId
          }
        ])) as ManagedPreviewResource
        if (resource.size + totalBytes > maxBytes)
          throw new Error('Archive exceeds the Web download size limit.')
        bytes = new Uint8Array(resource.size)
        for (let begin = 0; begin < resource.size; begin += 1024 * 1024) {
          const part = (await invoke('preview-resources:read-range', [
            { resourceId: resource.id, begin, end: Math.min(begin + 1024 * 1024, resource.size) }
          ])) as ManagedPreviewRangeResult
          if (part.data.length !== part.end - part.begin || part.begin !== begin)
            throw new Error('Incomplete file download.')
          bytes.set(part.data, begin)
        }
      }
      const folder = file.hidden ? 'hidden' : file.source === 'upload' ? 'uploads' : 'generated'
      const name =
        file.suggestedName
          .split(/[\\/]/)
          .pop()
          ?.split('')
          .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
          .join('') || 'file'
      let key = `${folder}/${name === '.' || name === '..' ? 'file' : name}`
      for (let suffix = 2; entries[key]; suffix++) key = `${folder}/${suffix}-${name}`
      entries[key] = bytes
      totalBytes += bytes.length
      includedFiles.push({ ...file, size: bytes.length })
    } catch (error) {
      failures.push({ ...file, message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (resource)
        await invoke('preview-resources:release', [{ resourceId: resource.id }]).catch(
          () => undefined
        )
    }
  }
  if (Object.keys(entries).length) {
    const zip = zipSync(entries, { level: 0 })
    // Re-admit every member after all reads and ZIP assembly, before making it downloadable.
    for (const file of includedFiles) {
      if (file.hidden) {
        await invoke('project-files:read-hidden-artifact', [
          {
            projectId: request.projectId,
            fileId: file.fileId,
            versionId: file.versionId,
            encoding: 'base64',
            offset: file.size
          }
        ])
      } else {
        const lease = (await invoke('preview-resources:acquire', [
          {
            source: file.source,
            projectId: request.projectId,
            fileId: file.fileId,
            versionId: file.versionId
          }
        ])) as ManagedPreviewResource
        await invoke('preview-resources:release', [{ resourceId: lease.id }])
      }
    }
    download(
      new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
      `${request.suggestedArchiveName.replace(/\.zip$/i, '')}.zip`
    )
  }
  return { saved: true, ...(failures.length ? { failures } : {}) }
}
