import type { Annotation } from '../../../../shared/annotations'

import type { ComposerDoc } from './composer/composer-doc'

type EditedMessageSendResult =
  { ok: true; disposition: 'sent' | 'queued' } | { ok: false; displayMessage?: string }

type SendEditedMessage = (
  messageId: string,
  doc: ComposerDoc,
  annotations: Annotation[]
) => EditedMessageSendResult | Promise<EditedMessageSendResult>

export type { EditedMessageSendResult, SendEditedMessage }
