const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function createPageAssets(root) {
    const publicRoot = path.join(root, 'public');
    const cssNames = ['style', 'index', 'spaces', 'qr', 'visit'];
    const styles = new Map(cssNames.map(name => [`/css/${name}.css`, fs.readFileSync(path.join(publicRoot, 'css', `${name}.css`), 'utf8')]));
    const hash = createHash('sha256');
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(filename);
            else if (entry.isFile()) hash.update(path.relative(root, filename)).update('\0').update(fs.readFileSync(filename)).update('\0');
        }
    }
    // Public assets/templates only; no environment, credentials, database or request data.
    visit(publicRoot);
    visit(path.join(root, 'views'));
    const release = hash.digest('hex').slice(0, 16);
    function prepare(input) {
        let html = input.replace(/<link\b[^>]*href="(\/css\/[^"]+)"[^>]*>/g, (tag, href) => {
            if (!styles.has(href)) throw new Error('unsupported_asset');
            const css = styles.get(href);
            if (/<\/style/i.test(css)) throw new Error('unsupported_asset');
            return `<style data-source="${href}">\n${css}\n</style>`;
        });
        // Load the local policy before auth.js; no unversioned ESM side import remains.
        html = html.replace(/<script type="module" src="\/js\/auth\.js"><\/script>/,
            '<script src="/js/auth-policy.js" defer></script>\n<script type="module" src="/js/auth.js"></script>');
        html = html.replace(/src="(\/(?:js\/|vendor\/)[^"?]+\.js)"/g, (_, src) => `src="${src}?v=${release}"`);
        return html.replace('</head>', `<meta name="spacecycle-release" content="${release}">\n</head>`);
    }
    return Object.freeze({ release, prepare });
}
module.exports = { createPageAssets };
