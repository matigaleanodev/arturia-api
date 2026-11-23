// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import SwaggerParser from '@apidevtools/swagger-parser'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const conversations = '/v1/scopes/{scopeId}/conversations'
const conversation = conversations + '/{conversationId}'
const turn = '/v1/scopes/{scopeId}/turns/{turnId}'
const contractId = 'urn:arturia:openapi'

function readContract(name) {
  const file = new URL('../contracts/' + name, import.meta.url)
  assert.ok(existsSync(file), 'Missing contract file: contracts/' + name)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function validator(options) {
  return addFormats(new Ajv2020({ allErrors: true, ...options }))
}

function openApiValidator(openapi) {
  const ajv = validator({ strict: false })
  ajv.addSchema(openapi, contractId)
  return ajv
}

function verify(ajv, schema, value, label) {
  const validate = ajv.compile(schema)
  assert.ok(validate(value), label + ': ' + ajv.errorsText(validate.errors))
}

function responseSchema(openapi, path, method, status) {
  const response = openapi.paths[path][method].responses[status]
  const resolved = response.$ref
    ? openapi.components.responses[response.$ref.split('/').at(-1)]
    : response
  return resolved.content['application/json'].schema
}

function verifyResponse(openapi, ajv, path, method, status, value, label) {
  const schema = responseSchema(openapi, path, method, status)
  verify(ajv, { $ref: contractId + schema.$ref }, value, label)
}

test('contract_rejects_missing_idempotency_key', () => {
  const openapi = readContract('openapi.json')
  const post = openapi.paths[conversation + '/turns'].post
  const header = post.parameters.find((parameter) => parameter.name === 'Idempotency-Key')
  assert.equal(header?.in, 'header')
  assert.equal(header.required, true)
  assert.equal(post.requestBody.required, true)
  const validate = validator().compile(header.schema)
  assert.equal(validate(undefined), false)
  assert.equal(validate(''), false)
  assert.equal(validate('fixture-submission'), true)
})

test('event_requires_sequence', () => {
  const schema = readContract('sse.schema.json')
  const validate = validator().compile(schema)
  const { seq, ...missingSequence } = {
    type: 'text', turnId: 'fixture-turn', seq: 1, text: 'Hola',
  }
  assert.equal(validate(missingSequence), false)
  assert.ok(validate({ ...missingSequence, seq }))
  for (const invalidSeq of [0, -1, 1.5, '1']) {
    assert.equal(validate({ ...missingSequence, seq: invalidSeq }), false)
  }
})

test('unknown_error_shape_rejected', () => {
  const openapi = readContract('openapi.json')
  const validate = openApiValidator(openapi).compile({
    $ref: contractId + '#/components/schemas/PublicError',
  })
  const error = { code: 'EXAMPLE_ERROR', message: 'Error sintético.', requestId: 'fixture-request' }
  assert.ok(validate(error))
  assert.equal(validate({ ...error, details: { message: 'internal' } }), false)
  for (const key of Object.keys(error)) {
    const missingField = { ...error }
    delete missingField[key]
    assert.equal(validate(missingField), false, key)
  }
})

test('openapi_documents_scoped_chat_and_read_only_stream', async () => {
  const openapi = readContract('openapi.json')
  await SwaggerParser.validate(structuredClone(openapi), { resolve: { external: false } })
  const bearer = openapi.components.securitySchemes.bearerAuth
  assert.equal(bearer.type, 'http')
  assert.equal(bearer.scheme.toLowerCase(), 'bearer')
  const operations = [
    [conversations, 'post', '201'],
    [conversations, 'get', '200'],
    [conversation, 'get', '200'],
    [conversation + '/turns', 'post', '202'],
    [turn, 'get', '200'],
    [turn + '/events', 'get', '200'],
  ]
  for (const [path, method, success] of operations) {
    const resource = openapi.paths[path]
    const operation = resource[method]
    assert.deepEqual(operation.security ?? openapi.security, [{ bearerAuth: [] }], method + ' ' + path)
    assert.ok(operation.responses[success], path)
    const parameters = [...resource.parameters, ...(operation.parameters ?? [])]
    for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
      const parameter = parameters.find((p) => p.in === 'path' && p.name === name)
      assert.equal(parameter?.required, true, name)
    }
    for (const code of ['400', '401', '403', '404', 'default']) {
      const schema = responseSchema(openapi, path, method, code)
      assert.equal(schema.$ref, '#/components/schemas/PublicError')
    }
  }
  const events = openapi.paths[turn + '/events']
  assert.deepEqual(Object.keys(events).sort(), ['get', 'parameters'])
  const after = events.get.parameters.find((parameter) => parameter.name === 'after')
  assert.equal(after.in, 'query')
  assert.equal(after.schema.default, 0)
  const validCursor = validator().compile(after.schema)
  assert.ok(validCursor(0))
  assert.ok(validCursor(2))
  assert.equal(validCursor(-1), false)
  assert.equal(validCursor(1.5), false)
  const content = events.get.responses['200'].content['text/event-stream']
  assert.equal(content.schema.type, 'string')
  assert.equal(content['x-event-schema'], './sse.schema.json')
})

test('turn_acceptance_requires_an_id_and_a_known_status', () => {
  const openapi = readContract('openapi.json')
  const schema = responseSchema(openapi, conversation + '/turns', 'post', '202')
  const validate = openApiValidator(openapi).compile({ $ref: contractId + schema.$ref })
  assert.ok(validate({ turnId: 'fixture-turn', status: 'queued' }))
  assert.equal(validate({ status: 'queued' }), false)
  assert.equal(validate({ turnId: 'fixture-turn' }), false)
  assert.equal(validate({ turnId: 'fixture-turn', status: 'pending' }), false)
})

test('http_fixtures_match_documented_operations', () => {
  const openapi = readContract('openapi.json')
  const fixture = readContract('fixtures/chat.json')
  const ajv = openApiValidator(openapi)
  const turnPost = conversation + '/turns'
  const requests = [
    [conversations, fixture.createConversation, 'createConversation'],
    [turnPost, fixture.acceptTurn, 'acceptTurn'],
    [turnPost, fixture.replayTurn, 'replayTurn'],
    [turnPost, fixture.idempotencyConflict, 'idempotencyConflict'],
  ]
  for (const [path, scenario, name] of requests) {
    const body = openapi.paths[path].post.requestBody.content['application/json'].schema
    verify(ajv, { $ref: contractId + body.$ref }, scenario.request, name + ' request')
  }
  for (const scenario of [fixture.acceptTurn, fixture.replayTurn, fixture.idempotencyConflict]) {
    const header = openapi.paths[turnPost].post.parameters.find((p) => p.in === 'header')
    verify(ajv, header.schema, scenario.headers['Idempotency-Key'], 'Idempotency-Key')
  }
  for (const [path, method, status, value, name] of [
    [conversations, 'post', '201', fixture.createConversation.response, 'createConversation'],
    [conversations, 'get', '200', fixture.listConversations, 'listConversations'],
    [conversation, 'get', '200', fixture.getConversation, 'getConversation'],
    [turnPost, 'post', '202', fixture.acceptTurn.response, 'acceptTurn'],
    [turnPost, 'post', '202', fixture.replayTurn.response, 'replayTurn'],
    [turnPost, 'post', '409', fixture.idempotencyConflict.response, 'idempotencyConflict'],
    [turn, 'get', '403', fixture.revokedPermission, 'revokedPermission'],
  ]) {
    verifyResponse(openapi, ajv, path, method, status, value, name)
  }
  const { scopeId, conversationId } = fixture.createConversation.response
  const detail = fixture.getConversation
  const listed = fixture.listConversations.conversations
  assert.equal(detail.scopeId, scopeId, 'conversation detail scope')
  assert.equal(detail.conversationId, conversationId, 'conversation detail ID')
  for (const item of listed) {
    assert.equal(item.scopeId, scopeId, 'listed conversation scope')
  }
  assert.ok(listed.some((item) => item.conversationId === conversationId), 'created conversation is listed')
  for (const entry of detail.turns) {
    assert.equal(entry.snapshot.scopeId, scopeId, 'conversation history scope')
    assert.equal(entry.snapshot.conversationId, conversationId, 'conversation history ID')
  }

  const statuses = ['queued', 'running', 'completed', 'incomplete', 'failed', 'cancelled', 'blocked']
  for (const status of statuses) {
    const snapshot = fixture.turnSnapshots[status]
    verifyResponse(openapi, ajv, turn, 'get', '200', snapshot, status)
    assert.equal(snapshot.status, status)
    assert.equal(snapshot.turnId, fixture.acceptTurn.response.turnId)
    assert.equal(snapshot.scopeId, scopeId)
    assert.equal(snapshot.conversationId, conversationId)
  }
  verify(ajv, { $ref: contractId + '#/components/schemas/TurnSnapshot' }, fixture.cancelTurn, 'cancelTurn')
  assert.equal(fixture.cancelTurn.status, 'cancelled')
  assert.deepEqual(fixture.replayTurn.headers, fixture.acceptTurn.headers)
  assert.deepEqual(fixture.replayTurn.request, fixture.acceptTurn.request)
  assert.equal(fixture.replayTurn.response.turnId, fixture.acceptTurn.response.turnId)
  assert.deepEqual(fixture.idempotencyConflict.headers, fixture.acceptTurn.headers)
  assert.notDeepEqual(fixture.idempotencyConflict.request, fixture.acceptTurn.request)
  assert.deepEqual(detail.turns[0].input, fixture.acceptTurn.request)
  assert.deepEqual(detail.turns[0].snapshot, fixture.turnSnapshots.completed)
})

test('sse_terminal_declares_cursor_and_fixtures_match_persisted_output', () => {
  const schema = readContract('sse.schema.json')
  const fixture = readContract('fixtures/chat.json')
  const ajv = validator()
  const validate = ajv.compile(schema)
  assert.equal(fixture.stream.heartbeat, ': keep-alive\n\n')
  const snapshot = fixture.turnSnapshots.completed
  const { events } = fixture.stream
  let lastSeq = 0
  let text = ''
  for (const [index, event] of events.entries()) {
    assert.ok(validate(event), ajv.errorsText(validate.errors))
    assert.equal(event.turnId, snapshot.turnId)
    if ('lastSeq' in event) {
      assert.equal(index, events.length - 1, 'terminal event must close the stream')
    }
    if (event.type === 'text') {
      assert.equal(event.seq, lastSeq + 1)
      lastSeq = event.seq
      text += event.text
    }
  }
  const terminal = events.at(-1)
  assert.equal(terminal?.type, 'status')
  assert.equal(terminal.status, snapshot.status)
  assert.equal(terminal.lastSeq, lastSeq)
  assert.equal(terminal.lastSeq, snapshot.lastSeq)
  assert.equal(text, snapshot.result?.text ?? '')
  for (const status of ['completed', 'incomplete', 'failed', 'cancelled', 'blocked']) {
    assert.equal(validate({ type: 'status', turnId: terminal.turnId, status }), false, status)
    const lastSeq = status === 'incomplete' ? 1 : 0
    assert.ok(validate({ type: 'status', turnId: terminal.turnId, status, lastSeq }), status)
  }
  assert.equal(validate({ type: 'heartbeat' }), false)
  assert.equal(validate({ ...terminal, lastSeq: -1 }), false)
  assert.equal(validate({ ...terminal, status: 'incomplete', lastSeq: 0 }), false)
  assert.equal(validate({ ...terminal, status: 'blocked' }), false)
  assert.equal(validate({ ...terminal, status: 'failed' }), false)
  assert.equal(validate({ ...terminal, extra: 'internal' }), false)
})

test('turn_payload_ownership_and_blocked_output_are_rejected', () => {
  const openapi = readContract('openapi.json')
  const fixture = readContract('fixtures/chat.json')
  const ajv = openApiValidator(openapi)
  const input = ajv.compile({ $ref: contractId + '#/components/schemas/TurnInput' })
  assert.equal(input({ ...fixture.acceptTurn.request, userId: 'fixture-other-user' }), false)
  assert.equal(input({ ...fixture.acceptTurn.request, scopeId: 'fixture-other-scope' }), false)
  const snapshot = ajv.compile({ $ref: contractId + '#/components/schemas/TurnSnapshot' })
  const { lastSeq, ...missingCursor } = fixture.turnSnapshots.completed
  assert.equal(snapshot(missingCursor), false)
  assert.equal(snapshot({ ...fixture.turnSnapshots.blocked, result: { text: 'Salida revocada' } }), false)
})

test('completed_turn_may_have_no_visible_text', () => {
  const openapi = readContract('openapi.json')
  const fixture = readContract('fixtures/chat.json')
  const validate = openApiValidator(openapi).compile({
    $ref: contractId + '#/components/schemas/TurnSnapshot',
  })
  const { result, ...snapshot } = fixture.turnSnapshots.completed
  assert.ok(result.text)
  assert.equal(validate(snapshot), false)
  assert.ok(validate({ ...snapshot, lastSeq: 0 }))
})
