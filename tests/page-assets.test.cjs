const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const file=path.join(__dirname,'../server/page-assets.js');
test('page styles are embedded from local sources, and all local scripts share a content-derived release',()=>{
 assert.ok(fs.existsSync(file),'mobile HTML must carry its local styling even if CSS subrequests fail');
 const {createPageAssets}=require(file);const root=path.resolve(__dirname,'..');const assets=createPageAssets(root);
 const input='<head><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/visit.css"><script src="/js/visit.js" defer></script><script type="module" src="/js/auth.js"></script></head>';
 const html=assets.prepare(input);
 assert.match(html,/<style data-source="\/css\/style.css">/);assert.match(html,/--page-bg: #EEF4ED/);assert.match(html,/\.visit-monitor/);
 assert.doesNotMatch(html,/<link[^>]*href="\/css\//);
 const sources=[...html.matchAll(/src="([^"]+)"/g)].map(x=>x[1]);
 assert.ok(sources.includes(`/js/auth-policy.js?v=${assets.release}`));
 for(const src of sources)assert.ok(src.endsWith(`?v=${assets.release}`));
 assert.match(html,new RegExp(`<meta name="spacecycle-release" content="${assets.release}">`));
 assert.match(assets.release,/^[a-f0-9]{16}$/);
 assert.equal(createPageAssets(root).release,assets.release,'same content must produce stable release');
 assert.throws(()=>assets.prepare('<head><link rel="stylesheet" href="/css/../../server.js"></head>'),/unsupported_asset/);
});
