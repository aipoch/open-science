/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook adapter. */
const path = require('node:path')
const { pathToFileURL } = require('node:url')

module.exports = async (resources, target) => {
  const { verifyPackagedNativeComponents } = await import(
    pathToFileURL(path.join(__dirname, '../scripts/native-components.mjs')).href
  )
  return verifyPackagedNativeComponents(resources, target)
}
