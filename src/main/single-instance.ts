import { app } from 'electron'

// Acquires the OS-level single-instance lock. Returns false when another instance already holds it
// (this process is a secondary launch and the caller should quit); returns true for the primary
// instance. On the primary, a 'second-instance' listener forwards the secondary launch's argv and
// working directory so the caller can focus/route the existing window instead of opening a new one.
export const acquireSingleInstanceLock = (opts: {
  onSecondInstance: (argv: string[], cwd: string) => void
}): boolean => {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', (_event, argv, workingDirectory) => {
    opts.onSecondInstance(argv, workingDirectory)
  })
  return true
}
