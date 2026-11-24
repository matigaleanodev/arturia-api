// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { spawnSync } from 'node:child_process'
import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { expect, test } from 'vitest'
import { addIdentity } from './identity.js'

test('signup_admin_only_totp', () => {
  const stack = new Stack(new App(), 'TestIdentity')
  const { domain } = addIdentity(stack, { callbackUrl: 'https://web.example.test/', logoutUrl: 'https://web.example.test/' })
  const template = Template.fromStack(stack)
  expect(stack.resolve(domain.baseUrl())).toEqual({ 'Fn::Join': ['', ['https://', { Ref: template.getResourceId('AWS::Cognito::UserPoolDomain') },
    '.auth.', { Ref: 'AWS::Region' }, '.amazoncognito.com']] })
  // Return URLs come from the composition (the distribution origin), never from stack parameters.
  expect(Object.keys(template.toJSON().Parameters ?? {}).filter(name => name !== 'BootstrapVersion')).toEqual(['CognitoDomainPrefix'])
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
    CallbackURLs: ['https://web.example.test/'],
    LogoutURLs: ['https://web.example.test/'],
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
