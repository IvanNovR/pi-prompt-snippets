import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// dist is entirely generated. Remove outputs from older source layouts too.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
});
