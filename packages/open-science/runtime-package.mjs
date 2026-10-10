/* eslint-disable @typescript-eslint/explicit-function-return-type */

// This is the published native support set, shared by packing and runtime discovery.
export const runtimeTargets = [
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { id: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { id: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { id: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { id: 'win32-x64', os: 'win32', cpu: 'x64' }
]
export const runtimePackageName = (target) => `@aipoch/open-science-${target.id}`
export function currentRuntimeTarget(platform = process.platform, arch = process.arch) {
  const target = runtimeTargets.find((item) => item.os === platform && item.cpu === arch)
  if (!target || (platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime))
    throw new Error(
      `Open-Science has no native npm package for ${platform}/${arch}. Linux requires glibc.`
    )
  return target
}
