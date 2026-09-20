type PlanContextFilePlatformStrategy = Readonly<{
  publishedMode: number
}>

const planContextFilePlatformStrategy = (
  platform: NodeJS.Platform
): PlanContextFilePlatformStrategy => ({
  // Windows replacement requires the published destination to remain writable. POSIX can expose
  // the same generated file as read-only while replacing it atomically through the directory.
  publishedMode: platform === 'win32' ? 0o600 : 0o444
})

export { planContextFilePlatformStrategy }
