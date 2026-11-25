// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { GetParameterCommand } from '@aws-sdk/client-ssm'
import { expect, test, vi } from 'vitest'
import { ConfigError } from '../config/runtime.js'
import {
  CredentialUnavailable, PROVIDER_PARAMETER_PREFIX, createProviderCredentials as create, isProviderParameterPrefix, providerParameterName,
} from './provider-secret.js'

// The runtime default enables OpenAI only. These tests keep covering the Anthropic path with both enabled.
const createProviderCredentials = (options: Parameters<typeof create>[0]) => create({ providers: ['openai', 'anthropic'], ...options })

// Synthetic values: they only have the shape of a key and are never valid anywhere.
const openaiKey = 'sk-synthetic-openai-0123456789abcdef'
const anthropicKey = 'sk-ant-synthetic-0123456789abcdef'

type Send = (command: GetParameterCommand, options?: { abortSignal?: AbortSignal }) => Promise<unknown>
const client = (send: Send) => ({ send: vi.fn(send) as unknown as Parameters<typeof createProviderCredentials>[0]['client']['send'] & ReturnType<typeof vi.fn> })
const parameter = (Value: unknown, Type: unknown = 'SecureString') => async () => ({ Parameter: { Type, Value } })
const byName = (values: Record<string, string>): Send => async command => ({
  Parameter: { Type: 'SecureString', Value: values[command.input.Name as string] } })
const both = byName({ [providerParameterName('openai')]: openaiKey, [providerParameterName('anthropic')]: anthropicKey })

test('the parameter name is one fixed path per provider and only the exact prefix is accepted', () => {
  expect(PROVIDER_PARAMETER_PREFIX).toBe('/arturia/pilot/providers')
  expect(providerParameterName('openai')).toBe('/arturia/pilot/providers/openai/api-key')
  expect(isProviderParameterPrefix(PROVIDER_PARAMETER_PREFIX)).toBe(true)
  for (const bad of [`${PROVIDER_PARAMETER_PREFIX}/`, `${PROVIDER_PARAMETER_PREFIX}/openai/api-key`, '/arturia/pilot/other',
    '/arturia/pilot/providers2', 'arturia/pilot/providers', ` ${PROVIDER_PARAMETER_PREFIX}`, `${PROVIDER_PARAMETER_PREFIX}\n`,
    // The previous reference: an ARN of Secrets Manager is no longer a valid reference.
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:arturia-pilot/providers-AbCdEf', '', undefined, 42,
  ]) expect(isProviderParameterPrefix(bad), String(bad)).toBe(false)
})

test('an invalid prefix is a configuration error that names the variable and never the value', () => {
  try {
    createProviderCredentials({ parameterPrefix: '/private-team/secret-path', client: client(parameter(openaiKey)) })
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variables).toEqual(['ARTURIA_PROVIDER_PARAMETER_PREFIX'])
    expect(String(error)).not.toContain('private-team')
  }
})

test('reads one SecureString parameter by its exact name, decrypted, and returns the key of the requested provider', async () => {
  const ssm = client(both)
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  await expect(credentials.get('openai')).resolves.toBe(openaiKey)
  expect(ssm.send).toHaveBeenCalledTimes(1)
  const [command] = ssm.send.mock.calls[0]
  expect(command).toBeInstanceOf(GetParameterCommand)
  expect(command.input).toEqual({ Name: '/arturia/pilot/providers/openai/api-key', WithDecryption: true })
})

test('each provider has its own parameter and is read only when it is used', async () => {
  const ssm = client(both)
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  await expect(credentials.get('anthropic')).resolves.toBe(anthropicKey)
  expect(ssm.send.mock.calls.map(([command]) => command.input.Name)).toEqual(['/arturia/pilot/providers/anthropic/api-key'])
  await expect(credentials.get('openai')).resolves.toBe(openaiKey)
  expect(ssm.send).toHaveBeenCalledTimes(2)
})

test('the value is cached only within a short TTL and read again afterwards', async () => {
  let now = 1_000_000
  const ssm = client(both)
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm, now: () => now, ttlMs: 60_000 })
  await credentials.get('openai')
  now += 59_999
  await credentials.get('openai')
  expect(ssm.send).toHaveBeenCalledTimes(1)
  now += 1
  await credentials.get('openai')
  expect(ssm.send).toHaveBeenCalledTimes(2)
})

test('the TTL is bounded: zero, negative, fractional and long lifetimes are configuration errors', () => {
  for (const ttlMs of [0, -1, 1.5, Number.NaN, 15 * 60_000 + 1]) {
    expect(() => createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: client(both), ttlMs }), String(ttlMs)).toThrow(RangeError)
  }
})

test('concurrent reads of one provider share one request and a failure is never cached', async () => {
  let calls = 0
  const ssm = client(async command => {
    calls++
    if (calls === 1) throw new Error(`transport failure with ${openaiKey}`)
    return both(command)
  })
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  const settled = await Promise.allSettled([credentials.get('openai'), credentials.get('openai')])
  expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected'])
  expect(calls).toBe(1)
  await expect(credentials.get('openai')).resolves.toBe(openaiKey)
  expect(calls).toBe(2)
})

test('invalidate drops the cached value so a rotated key is read on the next use', async () => {
  const values = ['sk-synthetic-before-0123456789', 'sk-synthetic-after--0123456789']
  const ssm = client(async () => ({ Parameter: { Type: 'SecureString', Value: values.shift() } }))
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  await expect(credentials.get('openai')).resolves.toBe('sk-synthetic-before-0123456789')
  credentials.invalidate()
  await expect(credentials.get('openai')).resolves.toBe('sk-synthetic-after--0123456789')
})

test.each([
  ['missing parameter', async () => ({})],
  ['missing value', async () => ({ Parameter: { Type: 'SecureString' } })],
  ['plain String parameter', parameter(openaiKey, 'String')],
  ['StringList parameter', parameter(openaiKey, 'StringList')],
  ['parameter without a type', async () => ({ Parameter: { Value: openaiKey } })],
  ['non-string value', parameter(12345678901234567890)],
  ['JSON object pasted from the previous secret format', parameter(JSON.stringify({ openai: openaiKey }))],
  ['quoted key', parameter(`"${openaiKey}"`)],
  ['key with a space', parameter('sk-synthetic 0123456789abcdef')],
  ['key with a trailing newline', parameter(`${openaiKey}\n`)],
  ['key with a header injection', parameter('sk-synthetic-0123456789abcdef\r\nx-injected: 1')],
  ['key with non-ASCII text', parameter('sk-sintético-0123456789abcdef')],
  ['key too short', parameter('short')],
  ['key too long', parameter('k'.repeat(513))],
  ['empty value', parameter('')],
])('fails closed with a constant message for %s', async (_name, send) => {
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: client(send as Send) })
  const error = await credentials.get('openai').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CredentialUnavailable)
  expect((error as Error).message).toBe('Provider credential unavailable')
})

test('a missing parameter, as the SDK reports it, is the same constant failure', async () => {
  const notFound = Object.assign(new Error('ParameterNotFound: /arturia/pilot/providers/openai/api-key'), { name: 'ParameterNotFound' })
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: client(async () => { throw notFound }) })
  const error = await credentials.get('openai').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CredentialUnavailable)
  expect(String(error)).not.toContain('/arturia')
})

test('an unknown provider is refused without reading anything', async () => {
  const ssm = client(both)
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  await expect(credentials.get('mistral' as never)).rejects.toBeInstanceOf(CredentialUnavailable)
  expect(ssm.send).not.toHaveBeenCalled()
})

test('a disabled provider has no parameter: Anthropic is refused without reading and OpenAI still works', async () => {
  const ssm = client(both)
  const credentials = create({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  await expect(credentials.get('anthropic')).rejects.toBeInstanceOf(CredentialUnavailable)
  expect(ssm.send).not.toHaveBeenCalled()
  await expect(credentials.get('openai')).resolves.toBe(openaiKey)
  expect(ssm.send.mock.calls.map(([command]) => command.input.Name)).toEqual(['/arturia/pilot/providers/openai/api-key'])
})

test('forwards the abort signal to the SDK request and stops waiting when it fires', async () => {
  const controller = new AbortController()
  const ssm = client((_command, options) => new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: ssm })
  const pending = credentials.get('openai', controller.signal)
  controller.abort()
  await expect(pending).rejects.toBeInstanceOf(CredentialUnavailable)
  expect(ssm.send.mock.calls[0][1]?.abortSignal).toBeDefined()
})

test('secret_never_logged: no failure or success path writes a key to the console or into an error', async () => {
  const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}))
  const writes = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')]
  writes.forEach(spy => spy.mockImplementation(() => true))
  const attempts: Send[] = [
    both, parameter(`${openaiKey} spaced`), parameter(JSON.stringify({ openai: openaiKey })), parameter(openaiKey, 'String'),
    async () => { throw Object.assign(new Error(`AccessDenied for ${openaiKey}`), { $metadata: { requestId: openaiKey } }) },
  ]
  const messages: string[] = []
  for (const send of attempts) {
    const credentials = createProviderCredentials({ parameterPrefix: PROVIDER_PARAMETER_PREFIX, client: client(send) })
    try { await credentials.get('openai') } catch (error) {
      messages.push(String(error), JSON.stringify(error, Object.getOwnPropertyNames(error)), String((error as Error).stack))
    }
  }
  const output = [...sinks, ...writes].flatMap(spy => spy.mock.calls.flat().map(String)).concat(messages).join('\n')
  for (const key of [openaiKey, anthropicKey]) expect(output).not.toContain(key)
  vi.restoreAllMocks()
})
