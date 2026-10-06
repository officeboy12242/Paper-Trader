// Writes vendor/wa-bot/MANIFEST.sha256 (hash of every vendored file).
// Usage: node scripts/vendor-manifest.js   (after syncing vendor/wa-bot/src from upstream)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'wa-bot');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
export function manifestLines(base = root) {
    return walk(path.join(base, 'src'))
        .map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.relative(base, f).split(path.sep).join('/')}`)
        .sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const lines = manifestLines();
    fs.writeFileSync(path.join(root, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
    console.log(`wrote ${lines.length} entries`);
}
