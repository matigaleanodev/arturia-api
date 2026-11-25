// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { expect, test, vi } from 'vitest'
import { ConfigError } from '../config/runtime.js'
import {
  CredentialUnavailable, PROVIDER_SECRET_NAME, createProviderCredentials, isProviderSecretArn,
} from './provider-secret.js'

const arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}-AbCdEf`
// Synthetic values: they only have the shape of a key and are never valid anywhere.
const openaiKey = 'sk-synthetic-openai-0123456789abcdef'
const anthropicKey = 'sk-ant-synthetic-0123456789abcdef'
const good = JSON.stringify({ openai: openaiKey, anthropic: anthropicKey })

type Send = (command: GetSecretValueCommand, options?: { abortSignal?: AbortSignal }) => Promise<unknown>
const client = (send: Send) => ({ send: vi.fn(send) as unknown as Parameters<typeof createProviderCredentials>[0]["client"]["send"] & ReturnType<typeof vi.fn> })
const secret = (SecretString: unknown) => async () => ({ SecretString })

test('isProviderSecretArn accepts only the full ARN of the fixed secret name', () => {
  expect(isProviderSecretArn(arn)).toBe(true)
  for (const bad of [
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}`, // partial ARN without the suffix
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}-AbCde`,
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}-AbCdEfG`,
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:other/providers-AbCdEf`,
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}-AbCdE!`,
    `arn:aws-us-gov:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}-AbCdEf`,
    `arn:aws:secretsmanager:us-east-1:12345:secret:${PROVIDER_SECRET_NAME}-AbCdEf`,
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:${PROVIDER_SECRET_NAME}-AbCdEf\n`,
    ` ${arn}`, '', 'arturia', undefined, 42,
  ]) expect(isProviderSecretArn(bad), String(bad)).toBe(false)
})

test('an invalid ARN is a configuration error that names the variable and never the value', () => {
  const bad = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:private-name-AbCdEf'
  try {
    createProviderCredentials({ secretArn: bad, client: client(secret(good)) })
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variables).toEqual(['ARTURIA_PROVIDER_SECRET_ARN'])
    expect(String(error)).not.toContain('private-name')
  }
})

test('reads one secret by its exact ARN and returns the key of the requested provider', async () => {
  const sm = client(secret(good))
  const credentials = createProviderCredentials({ secretArn: arn, client: sm })
  await expect(credentials.get('openai')).resolves.toBe(openaiKey)
  await expect(credentials.get('anthropic')).resolves.toBe(anthropicKey)
  expect(sm.send).toHaveBeenCalledTimes(1)
  const [command] = sm.send.mock.calls[0]
  expect(command).toBeInstanceOf(GetSecretValueCommand)
  expect(command.input).toEqual({ SecretId: arn })
})

test('the value is cached only within a short TTL and read again afterwards', async () => {
  let now = 1_000_000
  const sm = client(secret(good))
  const credentials = createProviderCredentials({ secretArn: arn, client: sm, now: () => now, ttlMs: 60_000 })
  await credentials.get('openai')
  now += 59_999
  await credentials.get('openai')
  expect(sm.send).toHaveBeenCalledTimes(1)
  now += 1
  await credentials.get('openai')
  expect(sm.send).toHaveBeenCalledTimes(2)
})

test('the TTL is bounded: zero, negative, fractional and long lifetimes are configuration errors', () => {
  for (const ttlMs of [0, -1, 1.5, Number.NaN, 15 * 60_000 + 1]) {
    expect(() => createProviderCredentials({ secretArn: arn, client: client(secret(good)), ttlMs }), String(ttlMs)).toThrow(RangeError)
  }
})

test('concurrent reads share one request and a failure is never cached', async () => {
  let calls = 0
  const sm = client(async () => {
    calls++
    if (calls === 1) throw new Error(`transport failure with ${openaiKey}`)
    return { SecretString: good }
  })
  const credentials = createProviderCredentials({ secretArn: arn, client: sm })
  const settled = await Promise.allSettled([credentials.get('openai'), credentials.get('anthropic')])
  expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected'])
  expect(calls).toBe(1)
  await expect(credentials.get('openai')).resolves.toBe(openaiKey)
  expect(calls).toBe(2)
})

test('invalidate drops the cached value so a rotated key is read on the next use', async () => {
  const values = [JSON.stringify({ openai: 'sk-synthetic-before-0123456789' }), JSON.stringify({ openai: 'sk-synthetic-after--0123456789' })]
  const sm = client(async () => ({ SecretString: values.shift() }))
  const credentials = createProviderCredentials({ secretArn: arn, client: sm })
  await expect(credentials.get('openai')).resolves.toBe('sk-synthetic-before-0123456789')
  credentials.invalidate()
  await expect(credentials.get('openai')).resolves.toBe('sk-synthetic-after--0123456789')
})

test.each([
  ['binary secret', async () => ({ SecretBinary: new Uint8Array([1, 2, 3]) })],
  ['missing value', async () => ({})],
  ['not JSON', secret('not json')],
  ['JSON array', secret('["sk-synthetic-0123456789abcdef"]')],
  ['JSON null', secret('null')],
  ['non-string key', secret(JSON.stringify({ openai: 12345678901234567890 }))],
  ['missing provider key', secret(JSON.stringify({ anthropic: anthropicKey }))],
  ['unexpected extra key', secret(JSON.stringify({ openai: openaiKey, other: openaiKey }))],
  ['key with a space', secret(JSON.stringify({ openai: 'sk-synthetic 0123456789abcdef' }))],
  ['key with a newline', secret(JSON.stringify({ openai: 'sk-synthetic-0123456789abcdef\nx-injected: 1' }))],
  ['key with non-ASCII text', secret(JSON.stringify({ openai: 'sk-sintético-0123456789abcdef' }))],
  ['key too short', secret(JSON.stringify({ openai: 'short' }))],
  ['key too long', secret(JSON.stringify({ openai: 'k'.repeat(513) }))],
  ['empty object', secret('{}')],
])('fails closed with a constant message for %s', async (_name, send) => {
  const credentials = createProviderCredentials({ secretArn: arn, client: client(send as Send) })
  const error = await credentials.get('openai').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CredentialUnavailable)
  expect((error as Error).message).toBe('Provider credential unavailable')
})

test('an unknown provider is refused without reading the secret', async () => {
  const sm = client(secret(good))
  const credentials = createProviderCredentials({ secretArn: arn, client: sm })
  await expect(credentials.get('mistral' as never)).rejects.toBeInstanceOf(CredentialUnavailable)
  expect(sm.send).not.toHaveBeenCalled()
})

test('forwards the abort signal to the SDK request and stops waiting when it fires', async () => {
  const controller = new AbortController()
  const sm = client((_command, options) => new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const credentials = createProviderCredentials({ secretArn: arn, client: sm })
  const pending = credentials.get('openai', controller.signal)
  controller.abort()
  await expect(pending).rejects.toBeInstanceOf(CredentialUnavailable)
  expect(sm.send.mock.calls[0][1]?.abortSignal).toBeDefined()
})

test('secret_never_logged: no failure or success path writes a key to the console or into an error', async () => {
  const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}))
  const writes = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')]
  writes.forEach(spy => spy.mockImplementation(() => true))
  const secrets = [openaiKey, anthropicKey]
  const attempts = [
    secret(good), secret(`{"openai": "${openaiKey}", "oops": `), secret(JSON.stringify({ openai: `${openaiKey} spaced` })),
    async () => { throw Object.assign(new Error(`AccessDenied for ${openaiKey}`), { $metadata: { requestId: openaiKey } }) },
  ]
  const messages: string[] = []
  for (const send of attempts) {
    const credentials = createProviderCredentials({ secretArn: arn, client: client(send as Send) })
    try { await credentials.get('openai') } catch (error) {
      messages.push(String(error), JSON.stringify(error, Object.getOwnPropertyNames(error)), String((error as Error).stack))
    }
  }
  const output = [...sinks, ...writes].flatMap(spy => spy.mock.calls.flat().map(String)).concat(messages).join('\n')
  for (const key of secrets) expect(output).not.toContain(key)
  vi.restoreAllMocks()
})
