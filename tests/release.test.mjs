import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const script = pathToFileURL(resolve('scripts/publish-registry.mjs')).href;
function probe({ status = 200, mismatch = false, network = false, publishFailure = false, registry = 'https://registry.npmjs.org', versionAbsent = false } = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    const dir = mkdtempSync(join(tmpdir(), 'registry-test-'));
    const tarball = join(dir, 'package.tgz');
    writeFileSync(tarball, 'fixture tarball');
    const pkg = JSON.parse(readFileSync('package.json'));
    const calls = [];
    cp.execFileSync = (cmd, args) => {
      calls.push([cmd, args]);
      if (${publishFailure}) throw new Error('publish authorization failure');
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => {
      if (${network}) throw new Error('network failure');
      const isGitHub = ${JSON.stringify(registry)} === 'https://npm.pkg.github.com';
      const shasum = createHash('sha1').update('fixture tarball').digest('hex');
      if (isGitHub) {
        const versions = ${versionAbsent} ? {} : { [pkg.version]: { name: pkg.name, version: pkg.version, dist: { shasum: ${mismatch} ? 'different' : shasum } } };
        return { status: ${status}, json: async () => ({ name: pkg.name, versions }) };
      } else {
        return { status: ${status}, json: async () => ({ name: pkg.name, version: pkg.version, dist: { shasum: ${mismatch} ? 'different' : shasum } }) };
      }
    };
    process.argv = ['node', 'script', ${JSON.stringify(registry)}, tarball];
    process.env.NODE_AUTH_TOKEN = 'test-only';
    console.log = () => {};
    let error;
    try { await import(${JSON.stringify(script)}); } catch (e) { error = e.message; }
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ calls, error }));
  `], { encoding: 'utf8' }));
}

test('publication skips only an identical existing tarball', () => {
  assert.deepEqual(probe(), { calls: [] });
  assert.match(probe({ mismatch: true }).error, /different bytes/);
});
for (const status of [401, 403, 429, 500]) {
  test(`registry HTTP ${status} is fatal, never missing`, () => {
    const result = probe({ status });
    assert.equal(result.calls.length, 0);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
  });
}
test('network errors are fatal, never missing', () => {
  assert.deepEqual(probe({ network: true }), { calls: [], error: 'network failure' });
});
for (const registry of ['https://registry.npmjs.org', 'https://npm.pkg.github.com']) {
  test(`only 404 attempts publication on ${registry}`, () => {
    const result = probe({ status: 404, registry });
    assert.equal(result.error, undefined);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0][0], 'npm');
    assert.deepEqual(result.calls[0][1].slice(-4), ['--registry', registry, '--access', 'public']);
  });
}
test('a concealed 404 or a failed publication cannot produce false success', () => {
  const result = probe({ status: 404, publishFailure: true, registry: 'https://npm.pkg.github.com' });
  assert.equal(result.calls.length, 1);
  assert.equal(result.error, 'publish authorization failure');
});
test('GitHub Packages aggregate 200 with identical sha skips publication', () => {
  const result = probe({ registry: 'https://npm.pkg.github.com' });
  assert.equal(result.calls.length, 0);
  assert.equal(result.error, undefined);
});
test('GitHub Packages aggregate 200 with version absent attempts publication', () => {
  const result = probe({ registry: 'https://npm.pkg.github.com', versionAbsent: true });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0][0], 'npm');
});
test('GitHub Packages aggregate 200 with mismatched sha is fatal', () => {
  const result = probe({ registry: 'https://npm.pkg.github.com', mismatch: true });
  assert.equal(result.calls.length, 0);
  assert.match(result.error, /different bytes/);
});
for (const status of [403, 429, 500]) {
  test(`GitHub Packages aggregate ${status} is fatal with no publish calls`, () => {
    const result = probe({ status, registry: 'https://npm.pkg.github.com' });
    assert.equal(result.calls.length, 0);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
  });
}
