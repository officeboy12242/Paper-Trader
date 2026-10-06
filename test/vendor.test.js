import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { manifestLines } from '../scripts/vendor-manifest.js';

const base = path.join(ROOT_DIR, 'vendor', 'wa-bot');

test('vendored WA-BOT source is unmodified (matches MANIFEST.sha256)', () => {
    const expected = fs.readFileSync(path.join(base, 'MANIFEST.sha256'), 'utf8').trim().split('\n');
    assert.deepEqual(manifestLines(base), expected);
    assert.match(fs.readFileSync(path.join(base, 'UPSTREAM_COMMIT'), 'utf8'), /^[0-9a-f]{40}\s*$/);
});

test('vendored files equal the upstream clone when it is present at the pinned commit', (t) => {
    const clone = process.env.WA_BOT_CLONE || path.resolve(ROOT_DIR, '..', 'WA-BOT');
    if (!fs.existsSync(path.join(clone, 'src'))) return t.skip('upstream clone not found');
    const head = fs.existsSync(path.join(clone, '.git')) ? fs.readFileSync(path.join(clone, '.git', 'HEAD'), 'utf8') : '';
    const pinned = fs.readFileSync(path.join(base, 'UPSTREAM_COMMIT'), 'utf8').trim();
    if (head && !head.startsWith('ref:') && !head.startsWith(pinned)) return t.skip('clone is at a different commit');
    assert.deepEqual(manifestLines(clone), manifestLines(base));
});
