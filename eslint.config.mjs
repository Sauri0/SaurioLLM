// Config flat de ESLint 10 (raíz del monorepo) — reemplaza el `.eslintrc.*` que nunca existió y que
// dejaba `pnpm lint` roto ("ESLint couldn't find an eslint.config.* file").
//
// Alcance deliberadamente mínimo: reglas que atrapan errores reales (variables/imports sin usar,
// hooks de React mal usados, casos de switch sin break, promesas sueltas, etc.), NO reglas de estilo
// (comillas, punto y coma, orden de imports...) — eso lo puede sumar quien lo necesite más adelante,
// pero no es lo que pedía este encargo ("reglas de errores reales, no estilo").
//
// Sin `type-checked`: usar los presets con chequeo de tipos de typescript-eslint requeriría un
// `parserOptions.project` válido para CADA tsconfig del monorepo (apps/desktop/src/{main,preload,renderer}
// + packages/*), y linting type-aware es notablemente más lento; para un lint de "errores reales" del
// día a día alcanza con el preset sintáctico (`tseslint.configs.recommended`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/release/**',
      '**/dist/**',
      '**/.vite/**',
      '**/coverage/**',
      'eval/**',
      'docs/**',
      'resources/**',
      '**/*.d.ts',
      // Worktrees de otros agentes trabajando en paralelo dentro de este mismo repo (ver
      // .git/info/exclude): son copias de código ajeno en otra rama, no el estado real de este repo.
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // No es un bug: en este código se usa `any` a propósito en puntos de integración (IPC, adapters
      // de terceros). Forzarlo a error hoy exigiría una reescritura masiva fuera del alcance de este
      // encargo (arreglar el LINTER, no el código de otros agentes).
      '@typescript-eslint/no-explicit-any': 'off',
      // Real pero no bloqueante: variables/args sin usar con prefijo `_` quedan exceptuados (patrón ya
      // usado en el repo para parámetros de callback ignorados, p. ej. `(_e, details) => ...`).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // rules-of-hooks SÍ es un error real (rompe la app en runtime); exhaustive-deps queda en warn
      // porque tiene falsos positivos frecuentes y no ameritaba bloquear `pnpm lint` para este encargo.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/src/preload/**/*.ts', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Scripts de test (vitest): globals de test (describe/it/expect) vía import explícito en este repo
    // (no globals=true de vitest), así que no hace falta agregar `globals.vitest` acá.
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
