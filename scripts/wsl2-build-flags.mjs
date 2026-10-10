/* eslint-disable @typescript-eslint/explicit-function-return-type */
/** @param {string} platform @param {string | undefined} rollbackValue */
export const resolveWsl2BashPreviewBuildEnabled = (platform, rollbackValue) =>
  platform === 'win32' && rollbackValue !== '0'

/**
 * Both desktop and Node owners compile the same policy. Runtime environment variables cannot
 * reopen a production bundle; only the explicit development build accepts the existing opt-in.
 * @param {string} platform
 * @param {boolean} development
 * @param {Record<string, string | undefined>} environment
 */
export const wsl2BuildDefines = (platform, development, environment) => ({
  __OPEN_SCIENCE_WSL2_BASH_PREVIEW__: String(
    resolveWsl2BashPreviewBuildEnabled(platform, environment.OPEN_SCIENCE_BUILD_WSL2_BASH_PREVIEW)
  ),
  __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__: String(
    development && environment.OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW === '1'
  )
})
