// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App } from 'aws-cdk-lib'
import { FoundationStack } from './foundation-stack.ts'

const app = new App({ analyticsReporting: false })
new FoundationStack(app, 'ArturiaFoundation')
app.synth()
