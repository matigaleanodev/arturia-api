// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import type { Actor } from '../identity/actor.js'
import type { Chat } from './turns.js'
import { ChatError } from './turns.types.js'

type Request = { actor?: Actor; scopeId: string; requestId?: string } & (
  | { operation: 'createConversation'; body?: unknown }
  | { operation: 'listConversations' }
  | { operation: 'getConversation'; conversationId: string }
  | { operation: 'cancelTurn'; turnId: string; body?: unknown }
  | { operation: 'getTurn'; turnId: string }
  | { operation: 'acceptTurn'; conversationId: string; idempotencyKey?: string; body: unknown }
)
function invalid(): never { throw new ChatError(400, 'INVALID_REQUEST', 'La solicitud es inválida.') }
function objectBody(body: unknown, field: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== field)) invalid()
  return body as Record<string, unknown>
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value.length) invalid()
  return value
}
// `report` receives unexpected failures for operational logging; the response stays generic.
export async function chatHttp(chat: Chat, request: Request,
  report?: (error: unknown) => void): Promise<{ status: number; body: Record<string, unknown> }> {
  const { actor, scopeId } = request
  try {
    if (!actor) throw new ChatError(401, 'UNAUTHENTICATED', 'Se requiere una sesión válida.')
    nonempty(scopeId)
    switch (request.operation) {
      case 'createConversation': {
        const { title } = objectBody(request.body === undefined ? {} : request.body, 'title')
        const summary = await chat.createConversation(actor, scopeId, title === undefined ? {} : { title: nonempty(title) })
        return { status: 201, body: { ...summary } }
      }
      case 'listConversations': return { status: 200, body: await chat.listConversations(actor, scopeId) }
      case 'getConversation': return { status: 200, body: await chat.getConversation(actor, scopeId, nonempty(request.conversationId)) }
      case 'getTurn': return { status: 200, body: { ...await chat.getTurn(actor, scopeId, nonempty(request.turnId)) } }
      case 'cancelTurn': {
        if (request.body != null) invalid()
        return { status: 200, body: { ...await chat.cancelTurn(actor, scopeId, nonempty(request.turnId)) } }
      }
      case 'acceptTurn': {
        const text = nonempty(objectBody(request.body, 'text').text)
        const { turnId, status } = await chat.acceptTurn(actor, scopeId, nonempty(request.conversationId), nonempty(request.idempotencyKey), { text })
        return { status: 202, body: { turnId, status } }
      }
    }
  } catch (error) {
    if (!(error instanceof ChatError)) report?.(error)
    const fault = error instanceof ChatError ? error : new ChatError(500, 'INTERNAL_ERROR', 'No se pudo completar la solicitud.')
    return { status: fault.status, body: { code: fault.code, message: fault.message, requestId: request.requestId ?? randomUUID() } }
  }
}
