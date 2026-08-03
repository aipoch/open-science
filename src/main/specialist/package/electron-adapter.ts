import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  type SpecialistExportSaveResult,
  type SpecialistPackageReport,
  type SpecialistPackageReportSaveResult
} from '../../../shared/specialist-package'

type SpecialistExportDialog = {
  showSaveDialog: (options: {
    defaultPath: string
    filters: [{ name: 'ZIP archive'; extensions: ['zip'] }]
  }) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile: (path: string, bytes: Uint8Array) => Promise<unknown>
}

export const saveSpecialistExport = async (
  adapter: SpecialistExportDialog,
  archive: { fileName: string; archiveBytes: Uint8Array }
): Promise<SpecialistExportSaveResult> => {
  const selected = await adapter.showSaveDialog({
    defaultPath: archive.fileName,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
  })
  if (selected.canceled || !selected.filePath) return { saved: false }
  await adapter.writeFile(selected.filePath, archive.archiveBytes)
  return { saved: true }
}

type SpecialistArchiveDialog = {
  showOpenDialog: (options: {
    properties: ['openFile']
    filters: [{ name: 'Specialist ZIP'; extensions: ['zip'] }]
  }) => Promise<{ canceled: boolean; filePaths: string[] }>
  readFile: (path: string) => Promise<Uint8Array>
  getFileSize: (path: string) => Promise<number>
}

export const selectSpecialistArchive = async (
  adapter: SpecialistArchiveDialog
): Promise<
  { cancelled: true } | { bytes: Uint8Array } | { tooLarge: true; compressedBytes: number }
> => {
  const selected = await adapter.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Specialist ZIP', extensions: ['zip'] }]
  })
  if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true }
  const selectedPath = selected.filePaths[0]
  const compressedBytes = await adapter.getFileSize(selectedPath)
  if (compressedBytes > SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes) {
    return { tooLarge: true, compressedBytes }
  }
  return { bytes: new Uint8Array(await adapter.readFile(selectedPath)) }
}

type SpecialistPackageReportDialog = {
  showSaveDialog: (options: {
    defaultPath: string
    filters: [{ name: 'JSON report'; extensions: ['json'] }]
  }) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile: (path: string, contents: string) => Promise<unknown>
}

export const saveSpecialistPackageReport = async (
  adapter: SpecialistPackageReportDialog,
  report: SpecialistPackageReport
): Promise<SpecialistPackageReportSaveResult> => {
  const identity = report.summary
    ? `${report.summary.id}-${report.summary.version}`
    : 'specialist-package'
  const selected = await adapter.showSaveDialog({
    defaultPath: `${identity}-diagnostics.json`,
    filters: [{ name: 'JSON report', extensions: ['json'] }]
  })
  if (selected.canceled || !selected.filePath) return { saved: false }
  await adapter.writeFile(selected.filePath, `${JSON.stringify(report, null, 2)}\n`)
  return { saved: true }
}
