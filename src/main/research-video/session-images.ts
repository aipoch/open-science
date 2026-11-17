import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'
import { SAFE_SEGMENT_PATTERN } from '../artifacts/storage-layout'
import { readVideoSourceFile } from '@aipoch/research-film'
import type { ResearchVideoSessionSource } from './session-source'

/** Validate branch-owned images; supplying a destination also stages their referenced Versions. */
export async function stageResearchVideoSessionImages(
  source: ResearchVideoSessionSource,
  session: PersistedChatSession,
  dataRoot: string,
  destination: string | undefined,
  signal: AbortSignal,
  checksums?: string[]
): Promise<ResearchVideoSessionSource> {
  if (!SAFE_SEGMENT_PATTERN.test(session.projectId)) throw new Error('Invalid research Project')
  const root = join(dataRoot, 'artifacts', session.projectId)
  const artifacts = new Map((session.artifacts ?? []).map((artifact) => [artifact.id, artifact]))
  const visible = new Map<string, PersistedArtifact>()
  const copied = new Map<string, string>()
  const result = structuredClone(source)
  let total = 0
  if (result.replay) {
    for (const event of result.replay.events) {
      const artifact = event.artifactId ? artifacts.get(event.artifactId) : undefined
      if (
        !artifact ||
        !artifact.name ||
        artifact.kind !== 'managed-file' ||
        !/\.(png|jpe?g|webp|svg|csv|tsv|md|txt|json|py|r|js|ts|log)$/i.test(artifact.name)
      )
        continue
      if (!/\.(png|jpe?g|webp|svg)$/i.test(artifact.name)) {
        signal.throwIfAborted()
        const bytes = await readVideoSourceFile(
          root,
          relative(root, artifact.path).split(sep).join('/')
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        })
        if (!bytes) {
          result.replay.omissions.push(`File unavailable: ${artifact.name}`)
          continue
        }
        const checksum = createHash('sha256').update(bytes).digest('hex')
        if (artifact.sha256 && artifact.sha256 !== checksum)
          throw new Error('Research file content changed.')
        checksums?.push(checksum)
        total += bytes.length
        if (total > 100 * 1024 * 1024) throw new Error('Research files exceed 100 MiB')
        event.previewText = bytes.toString('utf8', 0, Math.min(bytes.length, 48000)).slice(0, 12000)
        if (Buffer.byteLength(event.previewText) < bytes.length)
          result.replay.omissions.push(`File preview excerpt: ${artifact.name}`)
        continue
      }
      let staged = copied.get(artifact.id)
      if (!staged) {
        signal.throwIfAborted()
        const bytes = await readVideoSourceFile(
          root,
          relative(root, artifact.path).split(sep).join('/')
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        })
        if (!bytes) {
          result.replay.omissions.push(`Image unavailable: ${artifact.name}`)
          continue
        }
        const checksum = createHash('sha256').update(bytes).digest('hex')
        if (artifact.sha256 && artifact.sha256 !== checksum)
          throw new Error('Research image content changed.')
        checksums?.push(checksum)
        total += bytes.length
        if (total > 100 * 1024 * 1024) throw new Error('Research images exceed 100 MiB')
        staged = `${createHash('sha256').update(artifact.id).digest('hex')}${extname(artifact.name).toLowerCase()}`
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(join(destination, staged), bytes, { flag: 'wx', signal })
        }
        copied.set(artifact.id, staged)
      }
      event.image = staged
    }
    return result
  }
  for (const message of result.messages) {
    for (const id of message.artifactIds) {
      const artifact = artifacts.get(id)
      if (artifact?.name) visible.set(artifact.name, artifact)
    }
    for (const match of message.md.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      signal.throwIfAborted()
      const name = match[2].replace(/^files\//, '')
      const artifact = visible.get(name)
      if (
        name !== basename(name) ||
        !/\.(png|jpe?g|webp|svg)$/i.test(name) ||
        !artifact ||
        artifact.kind !== 'managed-file'
      )
        throw new Error(`Research image is not an available managed Artifact: ${name}`)
      let staged = copied.get(artifact.id)
      if (!staged) {
        const bytes = await readVideoSourceFile(
          root,
          relative(root, artifact.path).split(sep).join('/')
        )
        const checksum = createHash('sha256').update(bytes).digest('hex')
        checksums?.push(checksum)
        if (artifact.sha256 && artifact.sha256 !== checksum)
          throw new Error(`Research image content changed: ${name}`)
        total += bytes.length
        if (total > 100 * 1024 * 1024) throw new Error('Research images exceed 100 MiB')
        staged = `${createHash('sha256').update(artifact.id).digest('hex')}${extname(name).toLowerCase()}`
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(join(destination, staged), bytes, { flag: 'wx', signal })
        }
        copied.set(artifact.id, staged)
      }
      message.md = message.md.replaceAll(match[0], `![${match[1]}](files/${staged})`)
    }
  }
  return result
}
