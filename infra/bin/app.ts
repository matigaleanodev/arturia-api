// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App, BootstraplessSynthesizer, Stack, Validations } from 'aws-cdk-lib'

const app = new App({ analyticsReporting: false })
const stack = new Stack(app, 'Arturia', { synthesizer: new BootstraplessSynthesizer() })
Validations.of(stack).acknowledge({
  id: 'CloudFormation-Validate::F0001',
  reason: 'The foundation stack is intentionally empty until resources are defined.',
})
app.synth()
