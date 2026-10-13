import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as navigation from './settings-navigation'
import * as legacyNavigation from '../pages/settings/settings-navigation'
import * as provisioning from './notebook-provisioning'
import * as legacyProvisioning from '../pages/workspace/provisioning-view'
import { sessionPackageImportAvailable } from './session-package-capabilities'
import { sessionPackageImportAvailable as legacyPackageImportAvailable } from '../components/session-package-import-menu-model'
import { stageUploadFile, uploadFileChunks } from './upload-transfer'
import * as legacyUploads from '../pages/workspace/composer-upload-transfer'

const rendererRoot = resolve(__dirname, '..')
const foundations = [
  'settings-navigation.ts',
  'notebook-provisioning.ts',
  'session-package-capabilities.ts',
  'upload-transfer.ts'
]

describe('renderer foundation boundaries', () => {
  it.each(foundations)('%s has no reverse dependency on renderer composition', (file) => {
    const pending = [resolve(__dirname, file)]
    const visited = new Set<string>()
    while (pending.length) {
      const current = pending.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      const source = readFileSync(current, 'utf8')
      // Include type dependencies: a route type imported from a page still widens CI impact.
      for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
        const alias = ['@/', '@renderer/'].find((prefix) => fileName.startsWith(prefix))
        if (!fileName.startsWith('.') && !alias) continue
        const target = alias
          ? resolve(rendererRoot, fileName.slice(alias.length))
          : resolve(dirname(current), fileName)
        const rendererPath = relative(rendererRoot, target).replaceAll('\\', '/')
        if (rendererPath.startsWith('../')) continue
        expect(rendererPath, `${current} -> ${fileName}`).toMatch(/^lib\//)
        const resolved = ts.resolveModuleName(
          fileName,
          current,
          {
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            paths: {
              '@/*': [resolve(rendererRoot, '*')],
              '@renderer/*': [resolve(rendererRoot, '*')]
            }
          },
          ts.sys
        ).resolvedModule
        expect(resolved, `${current} -> ${fileName}`).toBeDefined()
        if (resolved) pending.push(resolved.resolvedFileName)
      }
    }
  })

  it('preserves the old facades without composing another implementation', () => {
    expect(legacyNavigation).toEqual(navigation)
    expect(legacyProvisioning).toEqual(provisioning)
    expect(legacyPackageImportAvailable).toBe(sessionPackageImportAvailable)
    expect(legacyUploads.stageComposerFile).toBe(stageUploadFile)
    expect(legacyUploads.uploadFileChunks).toBe(uploadFileChunks)
  })
})
