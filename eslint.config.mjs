import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/scripts/**',
      'packages/desktop/out/**',
      'packages/desktop/dist/**'
    ]
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'Core package must not depend on Electron'
            }
          ]
        }
      ]
    }
  }
);
