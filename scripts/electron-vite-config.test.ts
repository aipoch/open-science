import { MessageChannel, MessagePort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { build, normalizePath, type PluginOption } from 'vite'
import { runInNewContext } from 'node:vm'
import type { UserConfig } from 'electron-vite'
import { describe, expect, it } from 'vitest'

import browserTestConfig from '../e2e/vite.browser-test.config'
import config from '../electron.vite.config'
import webConfig from '../vite.web.config'

const resolveConfig = config as (input: { command: 'build' | 'serve'; mode: string }) => UserConfig
const resolvedConfig = resolveConfig({ command: 'build', mode: 'production' })

describe('electron-vite main process dependencies', () => {
  it('bundles the Notebook sandbox and portable film export entry', () => {
    expect(resolvedConfig).toMatchObject({
      main: {
        build: {
          externalizeDeps: {
            exclude: ['@aipoch/notebook-network-sandbox', '@aipoch/research-film', 'tar']
          }
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

describe('DOCX rich-editor codec browser bundle', () => {
  it('aliases mammoth to its self-contained browser bundle across renderer, web, and browser-test configs', () => {
    const expectedMammothBrowser = createRequire(import.meta.url).resolve(
      'mammoth/mammoth.browser.js'
    )
    expect(resolvedConfig.renderer?.resolve?.alias).toMatchObject({
      mammoth: expectedMammothBrowser
    })
    expect(webConfig.resolve?.alias).toMatchObject({
      mammoth: expectedMammothBrowser
    })
    const browserBuild = browserTestConfig({ command: 'build', mode: 'production' })
    expect(browserBuild.resolve?.alias).toMatchObject({
      mammoth: expectedMammothBrowser
    })
  })

  it.each(['renderer', 'web'] as const)(
    'round-trips DOCX markdown and embedded PNG media inside a Node-free %s browser bundle',
    async (surface) => {
      const targetConfig = surface === 'web' ? webConfig : resolvedConfig.renderer!
      const plugins = (targetConfig.plugins ?? []).filter((plugin): plugin is PluginOption => {
        if (!plugin || typeof plugin !== 'object' || !('name' in plugin)) return true
        return plugin.name !== 'electron-vite:dev-build-watch'
      })

      const result = await build({
        configFile: false,
        logLevel: 'silent',
        define: {
          'process.env.NODE_ENV': '"production"'
        },
        resolve: targetConfig.resolve,
        plugins,
        build: {
          write: false,
          minify: false,
          commonjsOptions: targetConfig.build?.commonjsOptions,
          lib: {
            entry: resolve('src/renderer/src/pages/workspace/markdown-document/docx-codec.ts'),
            name: 'DocxCodecBundle',
            formats: ['iife']
          }
        }
      })

      const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) =>
        'output' in output ? output.output : []
      )
      const chunk = outputs.find((output) => output.type === 'chunk')
      expect(chunk).toBeDefined()
      expect(chunk!.code).not.toContain(
        'DOMParser.parseFromString: the provided mimeType "\' + mimeType + \'" is not valid.'
      )

      const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://app.local/',
        runScripts: 'outside-only'
      })
      const openChannels: MessageChannel[] = []
      class TrackedMessageChannel extends MessageChannel {
        constructor() {
          super()
          openChannels.push(this)
        }
      }

      try {
        // JSDOM's WindowProxy postMessage sets event.source !== Window; let setimmediate use MessageChannel/setTimeout.
        Object.defineProperty(dom.window, 'postMessage', { value: undefined, configurable: true })
        Object.assign(dom.window, {
          MessageChannel: TrackedMessageChannel,
          MessagePort,
          TextEncoder,
          TextDecoder,
          structuredClone
        })
        expect(dom.window.eval('typeof Buffer')).toBe('undefined')
        expect(dom.window.eval('typeof process')).toBe('undefined')
        expect(dom.window.eval('typeof require')).toBe('undefined')

        dom.window.eval(chunk!.code)
        const bundle = (
          dom.window as unknown as {
            DocxCodecBundle: {
              convertMarkdownToDocxBytes: (markdown: string) => Promise<Uint8Array>
              convertDocxBytesToMarkdown: (bytes: Uint8Array) => Promise<string>
            }
          }
        ).DocxCodecBundle

        const onePixelPng =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        const source = [
          '# Bundled Report',
          '',
          'Paragraph with **bold**, *italic*, `code`, and [link](https://example.com).',
          '',
          `![Embedded chart](${onePixelPng})`
        ].join('\n')

        const docxBytes = await bundle.convertMarkdownToDocxBytes(source)
        expect(docxBytes.byteLength).toBeGreaterThan(1000)

        const roundTripped = await bundle.convertDocxBytesToMarkdown(docxBytes)
        expect(roundTripped).toContain('# Bundled Report')
        expect(roundTripped).toContain('**bold**')
        expect(roundTripped).toContain('[link](https://example.com)')
        expect(roundTripped).toContain(`![Embedded chart](${onePixelPng})`)
      } finally {
        for (const channel of openChannels) {
          channel.port1.close()
          channel.port2.close()
        }
        dom.window.close()
      }
    },
    30000
  )
})
