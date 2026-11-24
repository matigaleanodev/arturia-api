// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { sqsMessage } from '../../src/jobs/outbox.js'
import { TIMING } from '../../src/config/timing.js'

type TurnReference = Readonly<{ userId: string; scopeId: string; turnId: string }>
interface Message { messageId: string; body: string; groupId: string; dedupId: string; receives: number; visibleAt: number }
export interface Delivery { readonly messageId: string; readonly body: string }

/**
 * In-memory model of the turn queue as the Lambda event source sees it, with batch size one: the
 * production group and deduplication IDs, visibility after every receive, one message in flight per
 * group, and the move to the DLQ once a receive exceeds the maximum receive count.
 */
export class FifoTurnQueue {
  private readonly queue: Message[] = []
  readonly deadLetters: Message[] = []
  private seq = 0
  constructor(private readonly visibilityMs = TIMING.turnVisibilitySeconds * 1000,
    private readonly maxReceives = TIMING.turnMaxReceives) {}

  send(ref: TurnReference) {
    const { MessageBody, MessageGroupId, MessageDeduplicationId } = sqsMessage('local-queue', ref)
    if ([...this.queue, ...this.deadLetters].some(m => m.dedupId === MessageDeduplicationId)) return
    this.queue.push({ messageId: `message-${++this.seq}`, body: MessageBody, groupId: MessageGroupId,
      dedupId: MessageDeduplicationId, receives: 0, visibleAt: 0 })
  }

  receive(now: number): Delivery | undefined {
    const blocked = new Set<string>()
    for (const message of [...this.queue]) {
      if (blocked.has(message.groupId)) continue
      blocked.add(message.groupId)
      if (message.visibleAt > now) continue
      if (message.receives >= this.maxReceives) {
        this.queue.splice(this.queue.indexOf(message), 1)
        this.deadLetters.push(message)
        blocked.delete(message.groupId)
        continue
      }
      message.receives++
      message.visibleAt = now + this.visibilityMs
      return { messageId: message.messageId, body: message.body }
    }
    return undefined
  }

  /** Successful item: deleted. A reported failure keeps it invisible until its visibility expires. */
  delete(messageId: string) {
    const index = this.queue.findIndex(m => m.messageId === messageId)
    if (index >= 0) this.queue.splice(index, 1)
  }

  receives(messageId: string) { return [...this.queue, ...this.deadLetters].find(m => m.messageId === messageId)?.receives }
  get depth() { return { queued: this.queue.length, deadLetters: this.deadLetters.length } }

  /** Manual DLQ redrive: messages return to the source queue with a fresh receive count. */
  redrive() {
    for (const message of this.deadLetters.splice(0)) this.queue.push({ ...message, receives: 0, visibleAt: 0 })
  }
}

type Handler = (event: { Records: Delivery[] }) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>

/** One event source poll: receive, invoke and apply the partial batch response. */
export async function deliver(queue: FifoTurnQueue, now: number, handler: Handler) {
  const message = queue.receive(now)
  if (!message) return 'empty' as const
  const { batchItemFailures } = await handler({ Records: [message] })
  if (batchItemFailures.some(f => f.itemIdentifier === message.messageId)) return 'failed' as const
  queue.delete(message.messageId)
  return 'deleted' as const
}
