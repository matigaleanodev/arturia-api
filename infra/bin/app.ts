// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App, BootstraplessSynthesizer, Stack } from 'aws-cdk-lib'
import { addIdentity } from '../identity.ts'

if ((process.env.ARTURIA_IDENTITY_MODE ?? 'cognito') !== 'cognito') {
  throw new Error('Real infrastructure requires Cognito identity')
}

const app = new App({ analyticsReporting: false })
const stack = new Stack(app, 'Arturia', { synthesizer: new BootstraplessSynthesizer() })
addIdentity(stack)
app.synth()
