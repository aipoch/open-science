import { runInNewContext } from 'node:vm'
import { strToU8, zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { bundleSessionApp } from './session-app-bundle.js'

function archive(module: string, extras: Record<string, string> = {}): Uint8Array {
  const files = {
    'index.html':
      '<script type="importmap">{"imports":{"sim":"./vendor/sim.js"}}</script><script src="./js/page.js" type="module"></script>',
    'js/page.js': 'import {frame} from "./scene.js"; throw Error("Page UI should never run");',
    'js/scene.js': module,
    'vendor/sim.js': 'export const double=(x)=>2*x;',
    ...extras
  }
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([path, code]) => ['demo/' + path, strToU8(code)]))
  )
}
it('bundles the offline simulation, including live exports, and leaves its page and clock out', () => {
  const app = bundleSessionApp(
    archive(
      'import {double} from "sim"; export let ticks=0; export function frame(t){ ticks++; return double(t) }'
    ),
    'demo.zip'
  )!
  expect(app.description).toMatchObject({ name: 'demo.zip', modules: 2, packages: ['sim'] })
  expect(app.description.api.join(' ')).toContain('function frame(t)')
  const context = {
    window: {} as {
      APP?: {
        frame(t: number): number
        packages: { sim: { double(t: number): number } }
        modules: Record<string, { ticks: number }>
      }
    }
  }
  // These are test-authored modules. The production host only compiles archive code.
  runInNewContext(app.code, context)
  expect(context.window.APP!.frame(3)).toBe(6)
  expect(context.window.APP!.modules['js/scene.js'].ticks).toBe(1)
  expect(context.window.APP!.packages.sim.double(4)).toBe(8)
})
it.each([
  'import("x")',
  'import.meta.url',
  'await Promise.resolve(4)',
  'export {x} from "https://example.test/library.js"',
  'export {x} from "./scene.js"'
])('falls back on unsupported offline module syntax: %s', (code) => {
  expect(() => bundleSessionApp(archive(code), 'demo.zip')).toThrow()
})
it('describes all entry imports even when one was compiled through another', () => {
  const app = bundleSessionApp(
    archive('import {orbit} from "./orbit.js"; export const frame=orbit;', {
      'js/page.js': 'import "./scene.js"; import "./orbit.js";',
      'js/orbit.js': 'export function orbit({ position, velocity }) {return position + velocity}'
    }),
    'demo.zip'
  )!
  expect(app.description.api).toContain('js/orbit.js: function orbit({ position, velocity })')
})
it('ignores research archives without a module entry', () => {
  expect(
    bundleSessionApp(zipSync({ 'paper/data.csv': strToU8('value\n3') }), 'data.zip')
  ).toBeUndefined()
})
