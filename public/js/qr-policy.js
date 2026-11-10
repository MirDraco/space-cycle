/* Shared validation: QR contents are untrusted and never become arbitrary navigation. */
(function (root, factory) {
    const data = typeof module === 'object' && module.exports ? require('./space-data.js') : root.SpaceCycleSpaces;
    const api = factory(data);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleQrPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, spaces => {
    const validSpace = id => typeof id === 'string' && /^(indoor|outdoor)-0[1-5]$/.test(id);

    function readSelection(search) {
        if (search === '') return { valid: true, spaceId: null };
        const match = /^\?space=((?:indoor|outdoor)-0[1-5])$/.exec(search);
        return match ? { valid: true, spaceId: match[1] } : { valid: false, spaceId: null };
    }

    function spaceLabel(id) {
        return spaces.getSpace(id)?.name || null;
    }

    function interpretQr(value, selected, currentOrigin) {
        const invalid = { status: 'invalid' };
        if (typeof value !== 'string' || value.length > 2048 || (selected !== null && !validSpace(selected))) return invalid;
        // A strict canonical format avoids protocol confusion, redirects and duplicate parameters.
        const short = /^(https?:\/\/[^\s/?#]+)\/s\/((?:in|out)0[1-5])$/.exec(value);
        const legacy = /^(https?:\/\/[^\s/?#]+)\/spaces\?space=((?:indoor|outdoor)-0[1-5])$/.exec(value);
        const match = short || legacy;
        if (!match) return invalid;
        let url;
        try { url = new URL(value); } catch { return invalid; }
        if (url.username || url.password || url.origin !== match[1]) return invalid;
        const permitted = url.origin === 'https://spacecycle.space' || url.origin === currentOrigin;
        if (!permitted) return invalid;
        // Plain HTTP is allowed only for an exact current loopback development origin.
        if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return invalid;
        const spaceId = short ? spaces.fromCode(short[2])?.id : legacy[2];
        if (!spaceId) return invalid;
        if (selected && selected !== spaceId) return { status: 'mismatch', spaceId };
        return { status: 'matched', spaceId, path: spaces.destination(spaceId) };
    }

    return Object.freeze({ readSelection, interpretQr, spaceLabel });
});
