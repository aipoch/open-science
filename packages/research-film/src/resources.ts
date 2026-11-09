import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Resolve from this installed package, independent of the host working directory. */
export function researchFilmResources(): {
  stageDirectory: string
  authoringDirectory: string
  workerPath: string
} {
  const directory = dirname(fileURLToPath(import.meta.url))
  return {
    stageDirectory: join(directory, '../resources/stage'),
    authoringDirectory: join(directory, '../resources/authoring'),
    workerPath: join(directory, 'generation-worker.js')
  }
}
