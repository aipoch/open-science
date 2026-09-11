// Build the existing opt-in development preview without launching Electron or changing release gates.
// This output is for the Windows setup conversation test, not for packaging or distribution.
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'

if (process.platform !== 'win32') {
  throw new Error('The WSL setup conversation development build requires Windows.')
}

process.env.OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW = '1'
const development = await resolveConfig({}, 'serve', 'development')
const production = await resolveConfig({}, 'build', 'production')
if (!development.config?.main || !development.config.preload || !production.config?.renderer) {
  throw new Error('The Electron application build configuration is incomplete.')
}

await build(development.config.main)
await build(development.config.preload)
await build(production.config.renderer)
