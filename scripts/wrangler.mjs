import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const config = existsSync('wrangler.private.jsonc') ? 'wrangler.private.jsonc' : 'wrangler.jsonc';
const result = spawnSync('wrangler', [...args, '--config', config], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
