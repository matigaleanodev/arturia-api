// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts', 'tests/unit/**/*.spec.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.spec.ts'],
          globalSetup: './tests/support/dynamodb-setup.ts',
        },
      },
      { test: { name: 'infra', include: ['infra/**/*.spec.ts'] } },
    ],
  },
})
