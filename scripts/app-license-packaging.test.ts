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

it('exposes the license in the DMG while retaining both drag-to-install items', async () => {
  const root = resolve(__dirname, '..')
  const config = load(await readFile(join(root, 'electron-builder.yml'), 'utf8')) as Configuration
  const contents = config.dmg?.contents ?? []
  expect(contents.filter((item) => !item.path)).toHaveLength(1)
  expect(contents).toContainEqual(expect.objectContaining({ type: 'link', path: '/Applications' }))
  const license = contents.find((item) => item.name === 'LICENSE.txt')
  expect(license?.type).toBe('file')
  expect(await readFile(join(root, license!.path!), 'utf8')).toBe(
    await readFile(join(root, 'LICENSE'), 'utf8')
  )
})

it('installs Debian copyright metadata through the package file manifest', async () => {
  const root = resolve(__dirname, '..')
  const config = load(await readFile(join(root, 'electron-builder.yml'), 'utf8')) as Configuration
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const destination = `/usr/share/doc/${metadata.name}/copyright`
  const mapping = config.deb?.fpm?.find((argument) => argument.endsWith(`=${destination}`))
  expect(mapping).toBeDefined()
  const copyright = await readFile(join(root, mapping!.split('=')[0]), 'utf8')
  expect(copyright).toContain('Copyright: 2026 AIPOCH')
  expect(copyright).toContain('License: Apache-2.0')
  expect(copyright).toContain('/usr/share/common-licenses/Apache-2.0')
})

it('uses the original license with informational NSIS copy and a normal Next button', async () => {
  const root = resolve(__dirname, '..')
  const config = load(await readFile(join(root, 'electron-builder.yml'), 'utf8')) as Configuration
  expect(config.nsis?.oneClick).toBe(false)
  expect(await readFile(join(root, config.nsis!.license!), 'utf8')).toBe(
    await readFile(join(root, 'LICENSE'), 'utf8')
  )
  const include = await readFile(join(root, config.nsis!.include!), 'utf8')
  expect(include).toContain('!include "${BUILD_RESOURCES_DIR}/installer.nsh"')
  expect(include).toContain('!macro customWelcomePage')
  expect(include).toContain('!define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"')
  for (const setting of [
    'MUI_PAGE_HEADER_TEXT',
    'MUI_PAGE_HEADER_SUBTEXT',
    'MUI_LICENSEPAGE_TEXT_TOP',
    'MUI_LICENSEPAGE_TEXT_BOTTOM'
  ]) {
    expect(include).toContain(`!define ${setting} `)
  }
  expect(include).not.toMatch(/!define MUI_LICENSEPAGE_(CHECKBOX|RADIOBUTTONS)\b/)
  expect(include).not.toMatch(/WriteReg|WriteINIStr/)
})
