import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Configuration } from 'app-builder-lib'
import { copyFiles, getFileMatchers } from 'app-builder-lib/out/fileMatcher'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

it.each(['mac', 'win', 'linux'] as const)(
  'copies the original license outside app.asar for %s',
  async (platform) => {
    const root = resolve(__dirname, '..')
    const config = load(await readFile(join(root, 'electron-builder.yml'), 'utf8')) as Configuration
    const destination = await mkdtemp(join(tmpdir(), 'open-science-license-'))

    try {
      const matchers = getFileMatchers(config, 'extraResources', destination, {
        defaultSrc: root,
        macroExpander: (value) => value,
        customBuildOptions: config[platform] ?? {},
        globalOutDir: join(root, 'dist')
      })
      const licenses = matchers?.filter((matcher) => matcher.from === join(root, 'LICENSE'))
      expect(licenses).toHaveLength(1)
      await copyFiles(licenses)
      expect(await readFile(join(destination, 'LICENSE.txt'), 'utf8')).toBe(
        await readFile(join(root, 'LICENSE'), 'utf8')
      )
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  }
)
