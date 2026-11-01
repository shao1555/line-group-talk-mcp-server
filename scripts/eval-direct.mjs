import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'line-direct-eval-'));
try {
  const outfile = join(dir, 'runner.mjs');
  await build({ entryPoints: ['scripts/eval-direct.ts'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  process.exitCode = typeof code === 'number' ? code : 1;
} finally { await rm(dir, { recursive: true, force: true }); }
