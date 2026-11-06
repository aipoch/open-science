import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import {
  createResearchVideoGenerator,
  createResearchFilmAuthor,
  generateResearchFilm
} from '@aipoch/research-film'
import { researchFilmResources } from '@aipoch/research-film/resources'
import { ResearchVideoPlaybackClock } from '@aipoch/research-film/contracts'

const require = createRequire(import.meta.url)
assert.equal(typeof require('@aipoch/research-film').generateResearchFilm, 'function')
assert.equal(typeof ResearchVideoPlaybackClock, 'function')
const root = await mkdtemp(join(tmpdir(), 'research-film-consumer-'))
let worker
try {
  const resources = researchFilmResources()
  assert.match(await readFile(join(resources.authoringDirectory, 'KIT.md'), 'utf8'), /k\.ctx/)
  assert.match(await readFile(join(resources.stageDirectory, 'index.html'), 'utf8'), /html/)
  const source = {
    sessionTitle: 'Evidence',
    project: 'test',
    messages: [
      { i: 0, id: 'm', role: 'assistant', md: 'Evidence remains uncertain.', artifactIds: [] }
    ],
    provenance: { projectId: 'p', sessionId: 's', sourceClaimsIndependentlyVerified: false }
  }
  const spec = {
    version: 1,
    case: 'evidence',
    title: 'Evidence',
    session: 'session.json',
    scenes: [
      {
        id: 'hook',
        role: 'hook',
        msg: 0,
        lines: [{ caption: 'Evidence remains uncertain.' }],
        panels: [
          { type: 'title', text: 'Evidence' },
          { type: 'animation', script: 'anims/hook.js', size: 'band' }
        ]
      }
    ]
  }
  await writeFile(join(root, 'session.json'), JSON.stringify(source))
  const stages = []
  const author = createResearchFilmAuthor(async (_source, _prompt, payload) =>
    payload.path ? 'k.ctx.fillRect(0, 0, 20, 20);' : JSON.stringify(spec)
  )
  // Exercise the real packaged generation worker and resource loader with deterministic speech.
  // Native model/download behavior is separately checked by the host and native acceptance run.
  const result = await generateResearchFilm({
    source,
    directory: root,
    author,
    modelDirectory: 'unused',
    modelRevision: 'test',
    engineDirectory: resources.stageDirectory,
    signal: AbortSignal.timeout(30_000),
    onProgress: (value) => stages.push(value.phase),
    generate: async (input) => {
      const scratch = join(root, 'scratch')
      await mkdir(scratch)
      worker = new Worker(resources.workerPath, {
        workerData: { ...input, speechConcurrency: 1, temporaryDirectory: scratch }
      })
      return new Promise((resolve, reject) => {
        worker.once('error', reject)
        worker.once('exit', (code) => reject(new Error('Worker exited before result: ' + code)))
        worker.on('message', (message) => {
          if (message.kind === 'synthesize') {
            const samples = new Float32Array(24000)
            worker.postMessage(
              { kind: 'speech-result', lane: message.lane, audio: { samples, sampleRate: 24000 } },
              [samples.buffer]
            )
          } else if (message.kind === 'measure-duration')
            worker.postMessage({ kind: 'speech-duration', lane: message.lane, duration: 1 })
          else if (message.kind === 'error') reject(new Error(message.message))
          else if (message.kind === 'result') resolve(message.result)
        })
      })
    }
  })
  assert.equal(result.title, 'Evidence')
  assert.ok(result.duration > 0)
  assert.ok((await readFile(result.sourcePath)).length > 1000)
  assert.match(await readFile(result.playerPath, 'utf8'), /open-science-research-video/)
  assert.deepEqual(stages.slice(0, 2), ['writing', 'loading'])
  await worker.terminate()
  worker = undefined
  // Also run the public default worker factory, proving it resolves without Vite or host paths.
  const temporaryRoot = join(root, 'jobs')
  await mkdir(temporaryRoot)
  const generate = createResearchVideoGenerator({ temporaryRoot })
  await assert.rejects(
    generate(
      {
        specPath: join(root, 'missing.json'),
        modelDirectory: 'unused',
        engineDirectory: resources.stageDirectory,
        outputDirectory: join(root, 'failed-output')
      },
      AbortSignal.timeout(10_000)
    ),
    /ENOENT/
  )
  assert.deepEqual(await readdir(temporaryRoot), [])
} finally {
  await worker?.terminate()
  await rm(root, { recursive: true, force: true })
}
