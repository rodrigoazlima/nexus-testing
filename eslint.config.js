// @ts-check
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['node_modules', 'playwright-report', 'test-results', '.testing', 'tmp', 'eslint.config.js'] },
  tseslint.configs.recommended
);
