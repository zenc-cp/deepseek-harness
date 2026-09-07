import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Explicit diagnostic entry: the general Windows suite excludes this mixed
// POSIX/PowerShell file. Its own platform guards remain authoritative.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    pool: 'forks',
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-invariants.ts'],
    include: ['packages/terminal/terminal-bash/tests/local.spec.ts'],
    testNamePattern: 'bootstraps a persistent pwsh',
  },
})
