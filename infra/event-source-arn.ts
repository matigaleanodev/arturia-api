// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { aws_lambda as lambda } from 'aws-cdk-lib'

/**
 * The CloudFormation role scopes event source mappings with `lambda:FunctionArn`, which compares ARNs. The L2
 * constructs send the function name, so every mapping of the function is pointed at its ARN instead (A0).
 */
export function mapEventSourcesByArn(fn: lambda.Function) {
  for (const child of fn.node.findAll()) {
    if (child instanceof lambda.CfnEventSourceMapping) child.functionName = fn.functionArn
  }
}
