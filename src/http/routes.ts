// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Single source of the v0.1 routes, shared by the Lambda adapter and the API Gateway composition.

const scope = '/v1/scopes/{scopeId}'

export const HTTP_ROUTES = [
  { method: 'POST', path: `${scope}/conversations`, operation: 'createConversation' },
  { method: 'GET', path: `${scope}/conversations`, operation: 'listConversations' },
  { method: 'GET', path: `${scope}/conversations/{conversationId}`, operation: 'getConversation' },
  { method: 'POST', path: `${scope}/conversations/{conversationId}/turns`, operation: 'acceptTurn' },
  { method: 'GET', path: `${scope}/turns/{turnId}`, operation: 'getTurn' },
  { method: 'POST', path: `${scope}/turns/{turnId}/cancel`, operation: 'cancelTurn' },
] as const

export const STREAM_ROUTE = { method: 'GET', path: `${scope}/turns/{turnId}/events` } as const

/** Route whose accepted turns feed the worker queue; it gets its own throttle. */
export const TURN_ROUTE = HTTP_ROUTES.find(route => route.operation === 'acceptTurn')!
