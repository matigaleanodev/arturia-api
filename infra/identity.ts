// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { CfnOutput, CfnParameter, RemovalPolicy, type Stack } from 'aws-cdk-lib'
import {
  FeaturePlan, ManagedLoginVersion, Mfa, OAuthScope, ResourceServerScope, UserPool, UserPoolClientIdentityProvider,
} from 'aws-cdk-lib/aws-cognito'
import { ARTURIA_ACCESS_SCOPE } from '../src/identity/actor.ts'

export interface IdentityProps {
  /** Exact return URLs of the browser client; the pilot derives both from the web distribution. */
  readonly callbackUrl: string
  readonly logoutUrl: string
}

export function addIdentity(stack: Stack, props: IdentityProps) {
  const [serverId, scopeName] = ARTURIA_ACCESS_SCOPE.split('/')
  const domainPrefix = new CfnParameter(stack, 'CognitoDomainPrefix', {
    type: 'String',
    allowedPattern: '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?',
    minLength: 1,
    maxLength: 63,
  })

  const userPool = new UserPool(stack, 'UserPool', {
    featurePlan: FeaturePlan.LITE,
    selfSignUpEnabled: false,
    mfa: Mfa.REQUIRED,
    mfaSecondFactor: { sms: false, otp: true },
    // Synthetic pilot users (D3): the pool is deleted with the stack.
    deletionProtection: false,
    removalPolicy: RemovalPolicy.DESTROY,
  })
  const accessScope = new ResourceServerScope({ scopeName, scopeDescription: 'Access the Arturia API' })
  const resourceServer = userPool.addResourceServer('ArturiaApi', {
    identifier: serverId,
    scopes: [accessScope],
  })
  const domain = userPool.addDomain('HostedLogin', {
    cognitoDomain: { domainPrefix: domainPrefix.valueAsString },
    managedLoginVersion: ManagedLoginVersion.CLASSIC_HOSTED_UI,
  })
  const client = userPool.addClient('BrowserClient', {
    generateSecret: false,
    authFlows: { userSrp: false },
    enableTokenRevocation: true,
    preventUserExistenceErrors: true,
    supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [OAuthScope.OPENID, OAuthScope.resourceServer(resourceServer, accessScope)],
      callbackUrls: [props.callbackUrl],
      logoutUrls: [props.logoutUrl],
    },
  })

  new CfnOutput(stack, 'UserPoolId', { value: userPool.userPoolId })
  new CfnOutput(stack, 'BrowserClientId', { value: client.userPoolClientId })
  new CfnOutput(stack, 'HostedLoginUrl', { value: domain.baseUrl() })
  return { userPool, client, domain }
}
