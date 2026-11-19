import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import {
  prepareFilmSessionApp,
  readVideoSourceFile,
  type FilmAuthoringCheckpoint,
  type ResearchVideoSessionSource,
  type SessionAppDescription
} from '@aipoch/research-film'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { SAFE_SEGMENT_PATTERN } from '../artifacts/storage-layout'
import { waitForFilmStep } from './wait'

/** Only managed archive Versions referenced on the selected branch can supply a live app. */
export async function stageFilmSessionApp(
  source: ResearchVideoSessionSource,
  session: Pick<PersistedChatSession, 'projectId' | 'artifacts'>,
  dataRoot: string,
  job: string,
  checkpoint: FilmAuthoringCheckpoint,
  signal: AbortSignal,
  confirm: (app: SessionAppDescription, signal: AbortSignal) => Promise<boolean>
): Promise<'drawn' | undefined> {
  const visible = new Set(source.messages.flatMap((m) => m.artifactIds))
  const candidates = (session.artifacts ?? [])
    .filter(
      (a) => a.kind === 'managed-file' && visible.has(a.id) && a.name && /\.zip$/i.test(a.name)
    )
    .reverse()
  if (!candidates.length) return
  if (!SAFE_SEGMENT_PATTERN.test(session.projectId)) throw new Error('Invalid research Project')
  const root = join(dataRoot, 'artifacts', session.projectId)
  let fallback: 'drawn' | undefined
  for (const artifact of candidates) {
    signal.throwIfAborted()
    const name = basename(artifact.name!).slice(0, 160)
    let app
    try {
      const bytes = await readVideoSourceFile(
        root,
        relative(root, artifact.path).split(sep).join('/')
      )
      if (artifact.sha256 && createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('The app archive changed.')
      app = await prepareFilmSessionApp(bytes, name, signal)
    } catch {
      signal.throwIfAborted()
      fallback = 'drawn'
      continue
    }
    if (!app) continue
    const digest = createHash('sha256').update(app.code).digest('hex')
    const key = 'session-app-consent:' + artifact.id + ':' + digest
    let decision = await checkpoint.read(key)
    if (decision !== 'yes' && decision !== 'no') {
      // Closing the dialog or losing its window selects the illustrated version.
      const allowed = await waitForFilmStep(signal, () => confirm(app.description, signal)).catch(
        () => false
      )
      signal.throwIfAborted()
      decision = allowed ? 'yes' : 'no'
      await checkpoint.save(key, decision)
    }
    if (decision === 'no') return 'drawn'
    signal.throwIfAborted()
    await mkdir(join(job, 'libs'), { recursive: true, mode: 0o700 })
    await writeFile(join(job, 'libs', 'app.js'), app.code, { flag: 'wx', mode: 0o600, signal })
    source.sessionApp = app.description
    source.provenance.sessionAppSha256 = digest
    return
  }
  return fallback
}
