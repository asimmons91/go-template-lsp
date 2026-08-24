import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['out/**', 'node_modules/**', 'bin/**', 'funcmap/**', 'fixtures/**', '*.vsix'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // This codebase returns plain closures (not `this`-bound methods) from
      // helpers and destructures them (e.g. `transpileTemplate`'s `mapOffset`),
      // which the rule reports as potentially unbound methods. The flagged
      // functions never rely on `this`.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // `node:test`'s `test()` returns a Promise by design, so top-level
      // `test(...)` calls are intentional fire-and-forget.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  eslintConfigPrettier,
);
