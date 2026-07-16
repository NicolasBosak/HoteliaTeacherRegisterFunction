module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  // lcov feeds SonarQube; text keeps the CI log readable.
  coverageReporters: ['text', 'lcov', 'json-summary'],
  // Ratchet: set just below the current measured coverage so a drop fails the
  // build. Raise these as coverage improves; never lower them to make a red
  // build pass.
  coverageThreshold: {
    global: {
      statements: 65,
      branches: 55,
      functions: 75,
      lines: 65
    }
  }
};
