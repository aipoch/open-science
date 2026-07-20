import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

it('keeps the generated web API map synchronized with preload', async () => {
  await expect(
    execFileAsync(process.execPath, [resolve('scripts/generate-web-api-map.mjs'), '--check'])
  ).resolves.toBeDefined()
})
