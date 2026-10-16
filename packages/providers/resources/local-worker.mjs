import { createInterface } from 'node:readline'
import * as runtime from './local-runtime.mjs'
import { createLocalTextGenerator } from './local.mjs'
let generator
let directory
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
try {
  for await (const line of lines) {
    let request
    try {
      if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Request limit exceeded.')
      request = JSON.parse(line)
      if (typeof request.directory !== 'string' || !request.directory)
        throw new Error('A model directory is required.')
      if (directory && directory !== request.directory) throw new Error('Model revision changed.')
      if (!generator) {
        directory = request.directory
        generator = createLocalTextGenerator(runtime, directory)
      }
      const result = await generator.run(request)
      process.stdout.write(JSON.stringify({ id: request.id, ...result }) + '\n')
    } catch {
      process.stdout.write(JSON.stringify({ id: request?.id, error: 'inference-failed' }) + '\n')
    }
  }
} finally {
  await generator?.dispose()
}
