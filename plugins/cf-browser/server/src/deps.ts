import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ToolError } from './cf.js';

// The launcher installs playwright-core + @playwright/mcp in the background and tells us how it is going.
export interface DepsState { state: 'installing' | 'ready' | 'failed'; dir?: string; startedAt?: number; error?: string }

let deps: DepsState = { state: 'installing', startedAt: Date.now() };
let loaded: { chromium: any; createConnection: any } | null = null;

export function setDeps(d: DepsState) { deps = d; }
export function depsState() { return deps; }

export function pw() {
  if (loaded) return loaded;
  if (deps.state === 'installing') {
    const left = Math.max(5, 30 - Math.round((Date.now() - (deps.startedAt || Date.now())) / 1000));
    throw new ToolError('INSTALLING', `cf-browser is installing its browser driver (≈${left}s left, first start only).`, 'Retry this call in a little while.');
  }
  if (deps.state === 'failed') throw new ToolError('INSTALL_FAILED', `cf-browser could not install its browser driver: ${deps.error}`, 'Check the network, then run /mcp and reconnect the cf-browser server.');
  const req = createRequire(join(deps.dir!, 'package.json'));
  const { chromium } = req('playwright-core');
  const { createConnection } = req('@playwright/mcp');
  loaded = { chromium, createConnection };
  return loaded;
}
