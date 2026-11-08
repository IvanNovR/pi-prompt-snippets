// Run only from the protected release workflow, never as an npm lifecycle hook.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [registry, tarball] = process.argv.slice(2);
if (!['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(registry) || !tarball) {
  throw new Error('Expected an allowed registry URL and a tarball path');
}
const pkg = JSON.parse(readFileSync('package.json'));
const headers = { Accept: 'application/json' };
if (registry === 'https://npm.pkg.github.com') {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('GitHub Packages token is required');
  headers.Authorization = `Bearer ${process.env.NODE_AUTH_TOKEN}`;
}
const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, {
  headers, redirect: 'error', signal: AbortSignal.timeout(60_000),
});
if (response.status === 200) {
  const existing = await response.json();
  if (existing.name !== pkg.name || existing.version !== pkg.version) throw new Error('Unexpected registry metadata');
  const shasum = createHash('sha1').update(readFileSync(tarball)).digest('hex');
  if (existing.dist?.shasum !== shasum) throw new Error('Published version has different bytes; refusing to skip or overwrite it');
  console.log(`${pkg.name}@${pkg.version} already exists with identical tarball bytes on ${registry}; skipping.`);
} else if (response.status === 404) {
  // A private registry may conceal authorization failures as 404. This is only
  // permission to TRY publishing, never evidence of success. npm errors stay fatal.
  execFileSync('npm', ['publish', tarball, '--registry', registry, '--access', 'public'], { stdio: 'inherit' });
} else {
  throw new Error(`Registry lookup failed (HTTP ${response.status}); not treating this as a missing version`);
}
