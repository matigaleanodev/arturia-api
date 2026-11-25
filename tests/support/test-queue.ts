// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

type TurnReference = Readonly<{ userId: string; scopeId: string; turnId: string }>

export class TestQueue {
  private readonly pending: TurnReference[] = []
  private nextError: Error | undefined

  failNextSend(error: Error) {
    this.nextError = error
  }

  send({ userId, scopeId, turnId }: TurnReference) {
    if (this.nextError) {
      const error = this.nextError
      this.nextError = undefined
      throw error
    }
    this.pending.push({ userId, scopeId, turnId })
  }

  take(index = 0): TurnReference | undefined {
    return this.pending.splice(index, 1)[0]
  }
}
