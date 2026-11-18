import { PPTX_EDIT_MAX_IMAGE_BASE64_CHARS } from '../../../../../shared/pptx-edit'

type PptxImageMime = 'image/png' | 'image/jpeg' | 'image/gif'

type PptxImageFile =
  | { kind: 'ready'; mime: PptxImageMime; dataBase64: string }
  | { kind: 'unsupported' }
  | { kind: 'too-large' }

const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif'])

// Base64 grows the payload by 4/3, so the raw limit follows from the operation's character cap.
const PPTX_IMAGE_MAX_BYTES = Math.floor((PPTX_EDIT_MAX_IMAGE_BASE64_CHARS * 3) / 4)

const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Image could not be read.'))
    reader.readAsDataURL(file)
  })

const readPptxImageFile = async (file: File): Promise<PptxImageFile> => {
  if (!IMAGE_MIMES.has(file.type)) return { kind: 'unsupported' }
  if (file.size > PPTX_IMAGE_MAX_BYTES) return { kind: 'too-large' }
  return { kind: 'ready', mime: file.type as PptxImageMime, dataBase64: await readAsBase64(file) }
}

export { PPTX_IMAGE_MAX_BYTES, readPptxImageFile }
export type { PptxImageFile }
