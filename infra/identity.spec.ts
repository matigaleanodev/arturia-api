// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { spawnSync } from 'node:child_process'
import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { expect, test } from 'vitest'
import { addIdentity } from './identity.js'

test('signup_admin_only_totp', () => {
  const stack = new Stack(new App(), 'TestIdentity')
  addIdentity(stack)
  const template = Template.fromStack(stack)
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolTier: 'LITE',
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    MfaConfiguration: 'ON',
    EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
  })
  template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 1 })
  const resourceServerId = template.getResourceId('AWS::Cognito::UserPoolResourceServer')
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: false,
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: ['openid', { 'Fn::Join': ['', [{ Ref: resourceServerId }, '/access']] }],
    CallbackURLs: [{ Ref: 'LoginCallbackUrl' }],
    LogoutURLs: [{ Ref: 'LogoutUrl' }],
    SupportedIdentityProviders: ['COGNITO'],
    EnableTokenRevocation: true,
    ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
  })
  template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
    Identifier: 'arturia',
    Scopes: [{ ScopeName: 'access', ScopeDescription: 'Access the Arturia API' }],
  })
})

test('synthetic_identity_cannot_synthesize_real_stack', () => {
  const result = spawnSync(process.execPath, ['infra/bin/app.ts'], {
    env: { ...process.env, ARTURIA_IDENTITY_MODE: 'synthetic' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Real infrastructure requires Cognito identity')
}, 12_000)
