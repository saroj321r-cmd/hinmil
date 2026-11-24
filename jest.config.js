/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // The language server counts too: tests/services/languageServer.test.ts
  // runs it in-process over JSON-RPC (tests/helpers/lspHarness.ts).
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  // Just below the measured level (2026-11-23: statements 91.7, branches
  // 84.6, functions 92.4, lines 94.7) so coverage cannot drop unnoticed.
  // Raise these when coverage goes up; never lower them to make a run pass.
  coverageThreshold: {
    global: { statements: 91, branches: 84, functions: 92, lines: 94 },
  },
  verbose: true,
};
