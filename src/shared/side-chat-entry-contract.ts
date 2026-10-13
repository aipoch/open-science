export type SideChatEntry =
  | Readonly<{ id: string; kind: 'message'; role: 'user' | 'assistant'; text: string }>
  | Readonly<{ id: string; kind: 'tool'; title: string; status?: string }>
