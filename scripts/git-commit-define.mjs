/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'

/** Short commit for trace release labels, or '' when the build is not inside a checkout. */
export const gitCommitBuildDefine = () => {
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    // Source archives and packaged rebuilds have no repository. The release label omits the commit.
  }
  return {
    __OPEN_SCIENCE_GIT_COMMIT__: JSON.stringify(/^[0-9a-f]{7,40}$/.test(commit) ? commit : '')
  }
}
