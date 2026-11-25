// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { ModelPolicyDenied } from './provider.js'

type Source = { kind: string; origin: string; integration: string; category: string }
export interface ModelGrant {
  enabled?: boolean
  origins?: string[]
  categories?: string[]
  integrations?: string[]
}

export const directUserMessage: Readonly<Source> = { kind: 'chat', origin: 'direct', integration: 'manual', category: 'chat' }
const credentials = /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-)?)[\w-]{8,}|\bBearer\s+\S+/iu
const credentialAssignment = /(?:^|[^\p{L}\p{N}_-])(?:[a-z\d]+[_-])*(?:api[_ -]?key|secret[_-]access[_-]key|password|passwd|secret|token|contrase[nñ]a)["']?\s*[:=]\s*\S+/iu
const excludedSource = /(?:^|[\s._:/-])(?:bank(?:ing)?|banco|bancari[oa]s?|secrets?|secretos?|credentials?|credencial(?:es)?)(?=$|[\s._:/-])/iu

// Provenance comes from the persisted server-side message, never from instructions in its text.
export interface ModelContext {
  message: Record<string, unknown>
  grant: ModelGrant
  access?: { origins?: Record<string, { kind: string; integration: string }>; categories?: string[]; integrations?: string[] }
}

export function safeModelText({ message, grant, access }: ModelContext): string {
  const sources = message.modelSources
  const allowed = (values: unknown, value: unknown) =>
    Array.isArray(values) && typeof value === 'string' && value.length > 0 && values.includes(value)
  const readableSource = (s: Source) => {
    if (s.origin === directUserMessage.origin) return s.kind === directUserMessage.kind && s.integration === directUserMessage.integration &&
      (s.category === directUserMessage.category || allowed(access?.categories, s.category))
    const origin = access?.origins && Object.hasOwn(access.origins, s.origin) ? access.origins[s.origin] : undefined
    return origin && ['repository', 'memory'].includes(origin.kind) && s.kind === origin.kind &&
      s.integration === origin.integration && allowed(access?.categories, s.category) &&
      allowed(access?.integrations, s.integration)
  }
  if (grant.enabled !== true || !Array.isArray(sources) || !sources.length || !sources.every(source =>
    source && [source.kind, source.origin, source.category, source.integration].every(value =>
      typeof value === 'string' && !excludedSource.test(value.normalize('NFKC'))) && readableSource(source) &&
    allowed(grant.origins, source.origin) && allowed(grant.categories, source.category) &&
    allowed(grant.integrations, source.integration))) throw new ModelPolicyDenied('Model source denied')
  if (typeof message.text !== 'string') throw new ModelPolicyDenied('Model text unavailable')
  const text = message.text.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  const screeningText = text.normalize('NFKC')
  const identifiedBank = /(?:^|\n)[^\S\n]*(?:origen|fuente|source|origin)[^\S\n]*:[^\S\n]*(?:bank(?:ing)?|banco|bancari[oa]s?)\b/iu
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
      credentials.test(screeningText) || credentialAssignment.test(screeningText) || identifiedBank.test(screeningText)) throw new ModelPolicyDenied('Model content denied')
  return text
}
