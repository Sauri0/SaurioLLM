// Config de electron-vite: build de main/preload con externalizeDepsPlugin, build de renderer con React
// (doc 02 §4.3). externalizeDepsPlugin evita que better-sqlite3/node-pty se agrupen en el bundle.
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @saurio/shared y @saurio/runtime son paquetes del workspace que exportan .ts fuente sin build propio
// (ver packages/shared/package.json y packages/runtime/package.json): hay que excluirlos de
// externalizeDepsPlugin para que electron-vite los transpile e incluya en el bundle de main/preload, ya
// que Node (dentro de Electron) no puede requerir/importar un .ts suelto como si fuera un módulo externo
// [COMPROBADO EN EQUIPO durante el smoke de este scaffolding: ERR_MODULE_NOT_FOUND al externalizarlos].
const workspaceTsPackages = ['@saurio/shared', '@saurio/runtime'];

// Al transpilar @saurio/runtime dentro del bundle de main, rollup también intenta agrupar SUS
// dependencias (better-sqlite3, ripgrep, tree-sitter), que no están en el package.json de esta app y
// por lo tanto externalizeDepsPlugin no conoce. better-sqlite3 es un addon nativo: bundlearlo rompe
// con "Could not dynamically require .../better_sqlite3.node" [COMPROBADO EN EQUIPO durante la
// integración del MVP]. Se externalizan a mano; se resuelven desde node_modules del workspace
// (node-linker=hoisted) y electron-builder los empaqueta como dependencias reales.
// @saurio/repomap NO va acá: es otro paquete del workspace que exporta .ts fuente (igual que
// @saurio/shared y @saurio/runtime) y tiene que transpilarse dentro del bundle.
const runtimeExternals = [
  'better-sqlite3',
  '@vscode/ripgrep',
  'web-tree-sitter',
  '@vscode/tree-sitter-wasm',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceTsPackages })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        external: runtimeExternals,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceTsPackages })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          // El preload sandboxeado de Electron solo acepta CommonJS (no soporta `import` de ESM);
          // como el package.json raíz declara "type": "module", forzamos formato cjs + extensión .cjs
          // explícita para que Node no lo trate como ESM [COMPROBADO EN EQUIPO en el smoke de este
          // scaffolding: "SyntaxError: Cannot use import statement outside a module" con .mjs].
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@saurio/shared': resolve(__dirname, '../../packages/shared/src'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
