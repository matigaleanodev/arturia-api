// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { fixtureA, fixtureB } from '../support/fixtures.js'
import { TestQueue } from '../support/test-queue.js'

const first = { ...fixtureA, turnId: 'fixture-turn-a' }
const second = { ...fixtureB, turnId: 'fixture-turn-b' }

test('the local queue permits duplicate and out-of-order deliveries', () => {
  const queue = new TestQueue()
  queue.send(first)
  queue.send(second)
  queue.send(first)

  expect([queue.take(1), queue.take(), queue.take(), queue.take()]).toEqual([
    second, first, first, undefined,
  ])
})

test('the local queue can fail a send before adding a reference', () => {
  const queue = new TestQueue()
  const error = new Error('Synthetic failed publication')
  queue.failNextSend(error)

  expect(() => queue.send(first)).toThrow(error)
  expect(queue.take()).toBeUndefined()
  queue.send(first)
  expect(queue.take()).toEqual(first)
})
