import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(js.configs.recommended, ...ts.configs.recommended, {
  files: ['**/*.ts', '**/*.tsx'],
  rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
}, {
  files: ['src/app/viewport.ts', 'src/app/App.tsx'],
  rules: { 'no-control-regex': 'off' }
});
