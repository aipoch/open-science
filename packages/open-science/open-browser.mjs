/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'

export const openBrowser = (url) => {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8_000, windowsHide: true }, (error) => resolve(!error))
  })
}
