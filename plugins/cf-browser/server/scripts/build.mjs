import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['playwright-core'], outfile: 'dist/server.mjs', logLevel: 'warning', banner: { js: "import { createRequire as bundledRequire } from 'node:module'; const require = bundledRequire(import.meta.url);" } });
const generated = spawnSync(process.execPath, ['scripts/gen-page-tools.mjs'], { encoding: 'utf8' });
if (generated.status) { process.stderr.write(generated.stderr); process.exit(generated.status); }
writeFileSync('dist/page-tools.json', generated.stdout);
