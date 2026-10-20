import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build, normalizePath } from 'vite'
import { runInNewContext } from 'node:vm'
import type { UserConfig } from 'electron-vite'
import { describe, expect, it } from 'vitest'

import config from '../electron.vite.config'
import webConfig from '../vite.web.config'

const resolveConfig = config as (input: { command: 'build' | 'serve'; mode: string }) => UserConfig
const resolvedConfig = resolveConfig({ command: 'build', mode: 'production' })

describe('electron-vite main process dependencies', () => {
  it('bundles the source-only Notebook network sandbox package', () => {
    expect(resolvedConfig).toMatchObject({
      main: {
        build: {
          externalizeDeps: { exclude: ['@aipoch/notebook-network-sandbox'] }
        }
      },
      renderer: {
        server: { host: '127.0.0.1' }
      }
    })
  })
})

describe('electron-vite renderer dependency optimization', () => {
  it('scans HTML and lazy Worker entries only during development', () => {
    const dev = resolveConfig({ command: 'serve', mode: 'development' })
    expect(dev.renderer?.optimizeDeps).toEqual({
      force: true,
      include: [
        '@aipoch/connector-mcp-client/oauth-redirect',
        '@aipoch/compute',
        '@aipoch/diagnostics',
        '@aipoch/providers',
        '@aipoch/providers/errors',
        '@aipoch/providers/transport',
        '@aipoch/skills/document',
        '@aipoch/notebook-analysis/contracts',
        '@aipoch/environment/contracts',
        '@aipoch/specialists',
        '@aipoch/reproducibility/contracts',
        '@aipoch/reproducibility/comparison',
        '@aipoch/reproducibility/execution-context'
      ],
      entries: [
        '*.html',
        'src/**/*.worker.ts',
        'src/**/*-worker.ts',
        normalizePath(
          createRequire(import.meta.url).resolve(
            '@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker'
          )
        )
      ]
    })
    expect(webConfig.optimizeDeps?.include).toContain('@aipoch/compute')
    expect(webConfig.optimizeDeps?.include).toEqual(
      expect.arrayContaining([
        '@aipoch/providers',
        '@aipoch/providers/errors',
        '@aipoch/providers/transport'
      ])
    )
    expect(resolvedConfig.renderer?.optimizeDeps).toBeUndefined()
    expect(dev.renderer?.build).toEqual(resolvedConfig.renderer?.build)
    expect(dev.renderer?.worker).toEqual(resolvedConfig.renderer?.worker)
  })
})

describe('linked Compute package browser consumption', () => {
  it.each(['renderer', 'preload', 'web'] as const)(
    'bundles the public API with the %s production CJS policy',
    async (surface) => {
      const entry = resolve('compute-browser-contract.js')
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'compute-browser-contract',
            resolveId: (id) => (normalizePath(id) === normalizePath(entry) ? entry : undefined),
            load: (id) =>
              normalizePath(id) === normalizePath(entry)
                ? `
          import { parseHostConnectionPort, isHostConnectionPortValid, computeProviderId } from '@aipoch/compute'
          export const actual = [parseHostConnectionPort(' 2222 '), isHostConnectionPortValid('0'), computeProviderId('cluster')]
        `
                : undefined
          }
        ],
        build: {
          write: false,
          minify: false,
          commonjsOptions: (surface === 'web' ? webConfig : resolvedConfig[surface])?.build
            ?.commonjsOptions,
          lib: { entry, name: 'ComputeContract', formats: ['iife'] }
        }
      })
      const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) =>
        'output' in output ? output.output : []
      )
      const chunk = outputs.find((output) => output.type === 'chunk')
      expect(chunk).toBeDefined()
      // A browser-like realm has no require, process or Node globals; execute the actual bundle.
      expect(runInNewContext(chunk!.code + '; ComputeContract.actual')).toEqual([
        2222,
        false,
        'ssh:cluster'
      ])
    }
  )
})

describe('linked Reproducibility package browser consumption', () => {
  it.each(['renderer', 'web'] as const)(
    'bundles the public API with the %s production CJS policy',
    async (surface) => {
      const entry = resolve('reproducibility-browser-contract.js')
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'reproducibility-browser-contract',
            resolveId: (id) => (normalizePath(id) === normalizePath(entry) ? entry : undefined),
            load: (id) =>
              normalizePath(id) === normalizePath(entry)
                ? `
          import { outputComparisonPolicySchema as contractPolicy } from '@aipoch/reproducibility/contracts'
          import { outputComparisonPolicySchema } from '@aipoch/reproducibility/comparison'
          import { notebookExecutionContextSchema } from '@aipoch/reproducibility/execution-context'
          export const actual = [contractPolicy === outputComparisonPolicySchema, outputComparisonPolicySchema.safeParse({}).success, notebookExecutionContextSchema.safeParse({}).success]
        `
                : undefined
          }
        ],
        build: {
          write: false,
          minify: false,
          commonjsOptions: (surface === 'web' ? webConfig : resolvedConfig[surface])?.build
            ?.commonjsOptions,
          lib: { entry, name: 'ReproducibilityContract', formats: ['iife'] }
        }
      })
      const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) =>
        'output' in output ? output.output : []
      )
      const chunk = outputs.find((output) => output.type === 'chunk')
      expect(chunk).toBeDefined()
      // A browser-like realm has no require, process or Node globals; execute the actual bundle.
      expect(runInNewContext(chunk!.code + '; ReproducibilityContract.actual')).toEqual([
        true,
        false,
        false
      ])
    }
  )
})

describe('linked Providers package browser consumption', () => {
  it.each(['renderer', 'web'] as const)(
    'bundles the public API with the %s production CJS policy',
    async (surface) => {
      const entry = resolve('providers-browser-contract.js')
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'providers-browser-contract',
            resolveId: (id) => (normalizePath(id) === normalizePath(entry) ? entry : undefined),
            load: (id) =>
              normalizePath(id) === normalizePath(entry)
                ? `
          import { getOfficialVendor, getVendorModelReasoningCapability } from '@aipoch/providers'
          export const actual = [getOfficialVendor('openai').id, getVendorModelReasoningCapability('openai', 'gpt-6.1-sol').values[2]]
        `
                : undefined
          }
        ],
        build: {
          write: false,
          minify: false,
          commonjsOptions: (surface === 'web' ? webConfig : resolvedConfig[surface])?.build
            ?.commonjsOptions,
          lib: { entry, name: 'ProvidersContract', formats: ['iife'] }
        }
      })
      const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) =>
        'output' in output ? output.output : []
      )
      const chunk = outputs.find((output) => output.type === 'chunk')
      expect(chunk).toBeDefined()
      // A browser-like realm has no require, process or Node globals; execute the actual bundle.
      expect(runInNewContext(chunk!.code + '; ProvidersContract.actual')).toEqual([
        'openai',
        'high'
      ])
    }
  )
})
