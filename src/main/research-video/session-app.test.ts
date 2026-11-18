import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { expect, it, vi } from 'vitest'
import type { ResearchVideoSessionSource } from '@aipoch/research-film'
import { stageFilmSessionApp } from './session-app'
import { filmAuthoringCheckpoint } from './checkpoint'

it('stages the exact offline module graph only after consent for a visible managed version', async () => {
  const data = await mkdtemp(join(tmpdir(), 'film-session-app-'))
  try {
    const art = join(data, 'artifacts', 'p')
    const job = join(data, 'pending')
    await mkdir(art, { recursive: true })
    await mkdir(job)
    const path = join(art, 'orbit.zip')
    const bytes = zipSync({
      'index.html': strToU8('<script src="./page.js" type="module"></script>'),
      'page.js': strToU8('import {position} from "./orbit.js"; throw Error("page wiring");'),
      'orbit.js': strToU8('export function position(t) { return 2*t }')
    })
    await writeFile(path, bytes)
    const artifact = {
      id: 'a',
      kind: 'managed-file' as const,
      path,
      name: 'orbit.zip',
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    const source: ResearchVideoSessionSource = {
      project: 'p',
      sessionTitle: 'Orbit',
      messages: [
        { i: 0, id: 'm', role: 'agent', md: 'The model doubles its input.', artifactIds: [] }
      ],
      provenance: { projectId: 'p', sessionId: 's', sourceClaimsIndependentlyVerified: false }
    }
    const checkpoint = filmAuthoringCheckpoint(job, () => {})
    const signal = new AbortController().signal
    const confirm = vi.fn().mockResolvedValue(false)
    const stage = (): ReturnType<typeof stageFilmSessionApp> =>
      stageFilmSessionApp(
        source,
        { projectId: 'p', artifacts: [artifact] },
        data,
        job,
        checkpoint,
        signal,
        confirm
      )
    expect(await stage()).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
    source.messages[0].artifactIds.push('a')
    await writeFile(path, 'changed contents')
    expect(await stage()).toBe('drawn')
    expect(confirm).not.toHaveBeenCalled()
    await writeFile(path, bytes)
    expect(await stage()).toBe('drawn')
    expect(await stage()).toBe('drawn')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(source.sessionApp).toBeUndefined()
    await expect(readFile(join(job, 'libs', 'app.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    // A different Version requires a new decision even if its display name and data match.
    artifact.id = 'b'
    source.messages[0].artifactIds = ['b']
    confirm.mockResolvedValue(true)
    expect(await stage()).toBeUndefined()
    const code = await readFile(join(job, 'libs', 'app.js'))
    expect(source.provenance.sessionAppSha256).toEqual(
      createHash('sha256').update(code).digest('hex')
    )
    expect(code.toString()).not.toContain('page wiring')
    expect(source.sessionApp).toMatchObject({ modules: 1, api: ['orbit.js: function position(t)'] })
    expect(confirm).toHaveBeenCalledTimes(2)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})
