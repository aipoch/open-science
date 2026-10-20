export const saveRuntimeDiagnostics = (text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'open-science-runtime-diagnostics.txt'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
