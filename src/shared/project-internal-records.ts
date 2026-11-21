// Reserved application records are available through Notebook/Artifact owners, never as ordinary
// project inputs or working-file outputs. Treat case variants conservatively across host volumes.
export function isProjectInternalRecordPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((part) => part.toLowerCase() === '.open-science')
}
