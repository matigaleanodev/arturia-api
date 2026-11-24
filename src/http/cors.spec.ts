// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { ALLOWED_ORIGIN_PATTERN, CORS_ORIGIN_VARIABLE, corsHeaders, isAllowedOrigin, readAllowedOrigin } from './cors.js'

const origin = 'https://d111111abcdef8.cloudfront.net'

test('allowed_origin_is_a_single_exact_https_origin', () => {
  for (const valid of [origin, 'https://app.example.com', 'https://app.example.com:8443']) expect(isAllowedOrigin(valid), valid).toBe(true)
  for (const invalid of ['*', 'null', '', ' ' + origin, origin + '/', origin + '/path', 'http://app.example.com',
    'https://localhost', 'https://*.cloudfront.net', `${origin},https://evil.example.com`, `${origin} https://evil.example.com`,
    'https://APP.example.com', 'https://user@app.example.com', 'https://app.example.com:99999', undefined, 42]) {
    expect(isAllowedOrigin(invalid), String(invalid)).toBe(false)
  }
  // The CloudFormation pattern is matched against the whole value.
  const full = new RegExp(`^(?:${ALLOWED_ORIGIN_PATTERN})$`)
  expect(full.test(origin)).toBe(true)
  expect(full.test('*')).toBe(false)
})

test('cors_headers_name_only_the_configured_origin', () => {
  expect(corsHeaders(origin)).toEqual({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' })
  expect(() => corsHeaders('*')).toThrow()
  expect(readAllowedOrigin({ [CORS_ORIGIN_VARIABLE]: origin })).toBe(origin)
  for (const value of [undefined, '*', 'http://app.example.com']) expect(readAllowedOrigin({ [CORS_ORIGIN_VARIABLE]: value })).toBeUndefined()
})
