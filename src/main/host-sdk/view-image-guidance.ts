/** Inspection and delivery have the same meaning for native pixels and relayed evidence. */
export const HOST_VIEW_IMAGE_DELIVERY_GUIDANCE = [
  '`attached: true` means model input, not Artifact publication.',
  'If asked to generate and inspect an image, deliver the new image: unless the user opts out or it is already published, you MUST call `write_artifact_file` in this turn before your final answer.',
  'Use the original saved relative path. For Notebook outputs, set `producerRunId` to the Run that created the file, never a separate inspection-only Run.',
  'Do not publish inputs, intermediate files or existing Artifact versions merely because they were inspected.'
].join(' ')
