import { createContext, useContext } from 'react'
import type { ImageModelSettingsSnapshot } from '../../../../../shared/image-model-settings'
import type {
  ImageTask,
  ImageTaskList,
  ImageTaskStart,
  ImageTaskStartResult,
  ImageTaskIdentity
} from '../../../../../shared/image-task'
import type { ImageEditorDraft } from './image-editor-state'

export type ImageEditorRuntime = {
  tasks: readonly ImageTask[]
  observationErrors?: ReadonlySet<string>
  observationFailures?: ReadonlySet<string>
  checkTask?(scope: ImageTaskIdentity): Promise<ImageTask | undefined>
  startTask(input: ImageTaskStart): Promise<ImageTaskStartResult>
  cancelTask(input: ImageTaskIdentity): Promise<void>
  reloadTasks(request: ImageTaskList): Promise<ImageTask[]>
}
type ImageEditingContextValue = ImageEditorRuntime & {
  drafts: ReadonlyMap<string, ImageEditorDraft>
  update(
    key: string,
    update: (draft: ImageEditorDraft | undefined) => ImageEditorDraft | undefined
  ): void
  settings?: ImageModelSettingsSnapshot
  settingsError: boolean
  reloadSettings(): Promise<void>
}
export const ImageEditingContext = createContext<ImageEditingContextValue | undefined>(undefined)

export const useImageEditing = (): ImageEditingContextValue | undefined =>
  useContext(ImageEditingContext)
