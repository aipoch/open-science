export function resolveWsl2BashPreviewBuildEnabled(
  platform: NodeJS.Platform,
  rollbackValue: string | undefined
): boolean

export function wsl2BuildDefines(
  platform: NodeJS.Platform,
  development: boolean,
  environment: NodeJS.ProcessEnv
): {
  __OPEN_SCIENCE_WSL2_BASH_PREVIEW__: string
  __OPEN_SCIENCE_WSL2_BASH_DEVELOPMENT_PREVIEW__: string
}
