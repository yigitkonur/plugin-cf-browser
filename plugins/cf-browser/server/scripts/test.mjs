import { build } from 'esbuild';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'cfb-tests-'));
try {
  const entryPoints = readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`);
  await build({ entryPoints, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, banner: { js: "import { createRequire as testRequire } from 'node:module'; const require = testRequire(import.meta.url);" }, target: 'node20', outdir: root, external: ['playwright-core'], logLevel: 'error' });
  const env = { ...process.env, CFB_HOME: join(root, 'home'), CFB_TEST_ROOT: root };
  delete env.CF_API_TOKEN; delete env.CF_ACCOUNT_ID;
  const result = spawnSync(process.execPath, ['--test', ...entryPoints.map(f => join(root, f.split('/').pop().replace('.ts', '.mjs')))], { env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
