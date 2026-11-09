/** Inspection and delivery have the same meaning for native pixels and relayed evidence. */
export const HOST_VIEW_IMAGE_DELIVERY_GUIDANCE = [
  '`host.viewImage` only inspects; `attached: true` means model input, not Artifact publication. Continue the active task.',
  'For newly generated, unpublished deliverables, call `write_artifact_file` with the original saved relative path. For Notebook outputs, set `producerRunId` to the Run that created the file, never a separate inspection-only Run.',
  'Do not publish input images or republish existing Artifact versions or already published files merely because they were inspected.'
].join(' ')
