import { BrowserWindow } from 'electron'

type PrintWindow = Pick<BrowserWindow, 'loadFile' | 'destroy'> & {
  webContents: Pick<Electron.WebContents, 'executeJavaScript' | 'printToPDF'>
}

// The runtime owns the generated HTML and atomic destination publication. Only this desktop
// operation owns Chromium, including the deadline and window cleanup for every terminal outcome.
export async function printConversationPdf(
  request: { htmlPath: string; timeoutMs: number; timeoutMessage: string },
  createWindow: () => PrintWindow = () =>
    new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    }),
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted()
  const window = createWindow()
  let abort: (() => void) | undefined
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error('PDF generation cancelled.'))
      signal?.addEventListener('abort', abort, { once: true })
    })
    return await Promise.race([
      aborted,
      (async () => {
        await window.loadFile(request.htmlPath)
        if (finished) throw new Error('PDF generation already ended.')
        await window.webContents.executeJavaScript(
          'document.fonts ? document.fonts.ready.then(() => true) : true'
        )
        if (finished) throw new Error('PDF generation already ended.')
        return window.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 }
        })
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(request.timeoutMessage)), request.timeoutMs)
      })
    ])
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
    finished = true
    clearTimeout(timer)
    window.destroy()
  }
}
