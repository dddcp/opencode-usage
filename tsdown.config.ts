import solid from 'rolldown-plugin-solid'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    tui: 'src/tui.tsx',
  },
  format: ['esm'],
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Force `.js` (not the default `.mjs`) so the package.json `exports` map
  // (`./dist/tui.js`) resolves at runtime.
  outExtensions: () => ({ js: '.js' }),
  // The Solid JSX must compile to the "universal" generator (terminal cells,
  // no DOM). rolldown-plugin-solid forwards its `solid` option to
  // babel-preset-solid.
  plugins: [
    solid({
      solid: {
        moduleName: '@opentui/solid',
        generate: 'universal',
      },
    }),
  ],
  // The opencode host provides these at runtime (either from the plugin's own
  // install tree or the host's) — never bundle them in, duplicate instances
  // break Solid reactivity and OpenTUI renderer registration.
  deps: {
    neverBundle: [/^@opencode/, /^@opentui\//, /^solid-js/],
  },
})
