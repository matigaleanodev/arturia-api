// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App } from 'aws-cdk-lib'
import { createPilotStack, resolvePilotTarget } from '../pilot.ts'

if ((process.env.ARTURIA_IDENTITY_MODE ?? 'cognito') !== 'cognito') {
  throw new Error('Real infrastructure requires Cognito identity')
}

const app = new App({ analyticsReporting: false })
createPilotStack(app, resolvePilotTarget(key => app.node.tryGetContext(key), process.env))
app.synth()
