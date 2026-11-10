const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('Docker deployment is reproducible, non-root and local-only on port 4500', () => {
    for (const file of ['Dockerfile', 'compose.yaml', '.dockerignore']) {
        assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
    }
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^EXPOSE 4500$/m);
    assert.match(dockerfile, /HEALTHCHECK[\s\S]*127\.0\.0\.1:4500\/healthz/);
    assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
    assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/m);
    assert.match(dockerfile, /COPY --chown=node:node server\/ \.\/server\//);
    assert.match(fs.readFileSync(path.join(root, '.dockerignore'), 'utf8'), /^!server\/\*\*$/m);

    const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
    assert.match(compose, /127\.0\.0\.1:4500:4500/);
    assert.match(compose, /restart: unless-stopped/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /SPACE_CYCLE_DB: \/app\/data\/visits\.sqlite/);
    assert.match(compose, /visits-data:\/app\/data/);
    assert.match(compose, /^volumes:\n  visits-data:/m);
    assert.match(dockerfile, /mkdir -p \/app\/data.*chown node:node \/app\/data/);
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/data\/$/m);
    assert.match(compose, /no-new-privileges:true/);
    assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*host/);

    const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
    assert.equal(ignore.split('\n')[0], '**', 'Docker context must be allowlisted');
    assert.match(ignore, /^!package-lock\.json$/m);
    assert.match(ignore, /^!public\/\*\*$/m);
    assert.doesNotMatch(ignore, /^!\.env|^!secrets/m);
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
    assert.deepEqual(packageJson.dependencies, lock.packages[''].dependencies);
    assert.equal(packageJson.scripts.test, 'node --test tests/*.test.cjs');

    const manifests = spawnSync('git', ['check-ignore', '--no-index', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' });
    assert.equal(manifests.status, 1, 'dependency manifests must not be ignored');
    const secrets = spawnSync('git', ['check-ignore', '--no-index', '.env', '.env.production', 'secrets/tunnel-token', 'node_modules/example'], { cwd: root, encoding: 'utf8' });
    assert.equal(secrets.status, 0);
    assert.deepEqual(secrets.stdout.trim().split('\n'), ['.env', '.env.production', 'secrets/tunnel-token', 'node_modules/example']);
});
