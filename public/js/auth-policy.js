/* Local-only auth policy. Never normalize untrusted return destinations into valid ones. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SpaceCycleAuthPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function safeReturnPath(value) {
        if (typeof value !== 'string') return '/';
        const match = /^(?:\/|\/badges|\/(?:spaces|qr)(?:\?space=(?:indoor|outdoor)-0[1-5])?|\/visit\?space=(?:indoor|outdoor)-0[1-5]|\/s\/(?:in|out)0[1-5])$/.exec(value);
        return match && match[0] === value ? value : '/';
    }

    function readReturnPath(search, hash = '') {
        if (hash || typeof search !== 'string') return '/';
        const match = /^\?next=([^&]+)$/.exec(search);
        if (!match || match[0] !== search) return '/';
        try { return safeReturnPath(decodeURIComponent(match[1])); }
        catch { return '/'; }
    }

    function loginHref(pathname, search = '', hash = '') {
        const target = hash ? '/' : pathname === '/login'
            ? readReturnPath(search) : safeReturnPath(pathname + search);
        return `/login?next=${encodeURIComponent(target)}`;
    }

    function verifiedSpaceCount(data) {
        const ids = data?.foundSpaces;
        const validId = id => typeof id === 'string' && /^(?:indoor|outdoor)-0[1-5](?![\s\S])/.test(id);
        if (!Array.isArray(ids) || !ids.every(validId) || new Set(ids).size !== ids.length ||
            !Number.isInteger(data.foundSpaceCount) || data.foundSpaceCount !== ids.length) {
            throw new Error('발견한 공간 정보를 확인하지 못했습니다. 새로고침해 주세요.');
        }
        return data.foundSpaceCount;
    }

    function authErrorMessage(error) {
        switch (error?.code) {
        case 'auth/unauthorized-domain':
            return '이 도메인에서 로그인이 허용되지 않았습니다. 관리자에게 로그인 도메인 등록을 요청해 주세요.';
        case 'auth/popup-blocked':
            return '로그인 팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.';
        case 'auth/popup-closed-by-user':
            return '로그인 창이 닫혔습니다. Google로 계속하기를 눌러 다시 로그인해 주세요.';
        case 'auth/cancelled-popup-request':
            return '다른 로그인 요청이 진행 중입니다. 열린 로그인 창에서 완료할 때까지 기다려 주세요.';
        case 'auth/operation-not-allowed':
            return 'Google 로그인을 사용할 수 없습니다. 관리자에게 Google 로그인 사용 설정을 요청해 주세요.';
        case 'auth/invalid-api-key':
            return '로그인 설정을 확인하지 못했습니다. 관리자에게 인증 설정 확인을 요청해 주세요.';
        case 'auth/network-request-failed':
            return '로그인 서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
        case 'auth/web-storage-unsupported':
            return '로그인에 필요한 브라우저 저장 공간을 사용할 수 없습니다. 사이트 데이터 저장을 허용한 뒤 다시 시도해 주세요.';
        default:
            return '인증 처리를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.';
        }
    }

    return Object.freeze({ safeReturnPath, readReturnPath, loginHref, verifiedSpaceCount, authErrorMessage });
});
