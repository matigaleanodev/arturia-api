// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

export interface TurnInput { readonly text: string }
export interface ConversationInput { readonly title?: string }
export interface ConversationSummary extends ConversationInput {
  readonly scopeId: string
  readonly conversationId: string
  readonly createdAt: string
}
export type TurnStatus = 'queued' | 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'blocked'
export interface PublicError { readonly code: string; readonly message: string; readonly requestId: string }
export interface TurnSnapshot {
  readonly scopeId: string
  readonly conversationId: string
  readonly turnId: string
  readonly status: TurnStatus
  readonly lastSeq: number
  readonly result?: { readonly text: string }
  readonly error?: PublicError
}
export interface TurnReference { readonly userId: string; readonly scopeId: string; readonly turnId: string }
export class ChatError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export const notFound = () => new ChatError(404, 'NOT_FOUND', 'No se encontró el recurso.')
export const forbidden = () => new ChatError(403, 'PERMISSION_REVOKED', 'El acceso no está permitido.')
