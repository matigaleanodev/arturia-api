// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createChat } from '../chat/turns.js'
import { ChatStore } from '../chat/turns.store.js'
import { ConfigError, loadHttpRuntime, memoize } from '../config/runtime.js'
import { createLog } from '../observability/log.js'
import { createLambdaAdapter, internalError, type RestEvent, type RestResult } from './lambda-adapter.js'

const log = createLog()
// Read once per execution environment; an invalid configuration fails every request closed.
const adapter = memoize(() => {
  const runtime = loadHttpRuntime(process.env)
  const store = new ChatStore(new DynamoDBClient({}), runtime.tableName)
  return createLambdaAdapter({ chat: createChat(store), identity: store, clientId: runtime.clientId, log })
})

export async function handler(event: RestEvent): Promise<RestResult> {
  const requestId = event.requestContext.requestId
  let handle: ReturnType<typeof adapter>
  try {
    handle = adapter()
  } catch (error) {
    log('error', 'CONFIG_INVALID', { requestId, error, variables: error instanceof ConfigError ? error.variables : undefined })
    return internalError(requestId)
  }
  return handle(event)
}
