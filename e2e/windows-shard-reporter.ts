import type { Reporter } from '@playwright/test/reporter'

// Windows Electron cases run serially on each desktop. Interleave independent cases across
// runners so a contiguous block of slow conversation tests cannot monopolize one shard.
// Use Playwright's public preprocessing API; keep --shard metadata for blob report merging.
export default class WindowsShardReporter implements Reporter {
  async preprocess({
    config,
    suite,
    testRun
  }: Parameters<NonNullable<Reporter['preprocess']>>[0]): Promise<void> {
    if (!config.shard || !config.fullyParallel) return
    // Browser configuration inherits the reporter list but uses a named Chromium project.
    if (config.projects.some((project) => project.name !== '')) return

    const { current, total } = config.shard
    testRun.skipSharding()
    suite.allTests().forEach((test, index) => {
      if (index % total !== current - 1) testRun.exclude(test)
    })
  }

  printsToStdio(): boolean {
    return false
  }
}
