// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

export type LogLevel = 'info' | 'warn' | 'error'
export interface LogFields {
  readonly requestId?: string
  readonly turnId?: string
  readonly attemptId?: string
  readonly messageId?: string
  readonly status?: number
  readonly variables?: readonly string[]
  /** Only the error class name is recorded; messages and stacks can echo prompts or tokens. */
  readonly error?: unknown
}
export type Log = (level: LogLevel, code: string, fields?: LogFields) => void

// Turn, attempt, API Gateway request and SQS message IDs are UUIDs. Anything else is omitted,
// so a malformed or user-influenced value never reaches the logs.
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const id = (value: unknown) => typeof value === 'string' && identifier.test(value) ? value : undefined

/** Structured allowlist logger: codes and identifiers only, never message text, prompts or secrets. */
export function createLog(write: (line: string) => void = line => console.log(line)): Log {
  return (level, code, fields = {}) => {
    const { error, status, variables } = fields
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : undefined
    write(JSON.stringify({
      level,
      code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INVALID_LOG_CODE',
      requestId: id(fields.requestId), turnId: id(fields.turnId), attemptId: id(fields.attemptId), messageId: id(fields.messageId),
      status: Number.isSafeInteger(status) ? status : undefined,
      variables: variables?.filter(variable => /^[A-Z][A-Z0-9_]{0,63}$/.test(variable)),
      errorType: error === undefined ? undefined : name ?? 'Unknown',
    }))
  }
}
