import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut }
    from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import './auth-policy.js';

const firebaseConfig = {
  apiKey: "AIzaSyAPTYO5sUQqT2DFxbcdDcILDYfTK8mExmg",
  authDomain: "space-cycle-1b705.firebaseapp.com",
  projectId: "space-cycle-1b705",
  storageBucket: "space-cycle-1b705.firebasestorage.app",
  messagingSenderId: "298253427014",
  appId: "1:298253427014:web:b50808f576517d1a518547",
  measurementId: "G-XM3JQRJFVL"
};
let auth = null;
let provider = null;
const loginButton = document.getElementById('google-login');
const logoutButton = document.getElementById('logout');
const statusText = document.getElementById('auth-status');
const authLink = document.querySelector('[data-auth-link]');
const userGreeting = document.getElementById('user-greeting');
const foundSpaceCount = document.getElementById('found-space-count');
const { readReturnPath, loginHref, verifiedSpaceCount, authErrorMessage } = window.SpaceCycleAuthPolicy;
let authRevision = 0;
let countRevision = 0;
const authApi = window.SpaceCycleAuth = {
    isReady: false,
    getUser: () => auth?.currentUser || null,
    async getToken() {
        const user = auth?.currentUser;
        const revision = authRevision;
        if (!user) throw new Error('로그인한 뒤 다시 시도해 주세요.');
        const token = await user.getIdToken();
        if (auth.currentUser !== user || authRevision !== revision) throw new Error('로그인 상태가 변경되었습니다. 다시 시도해 주세요.');
        return token;
    },
    refreshFoundSpaces: () => showFoundSpaceCount(auth?.currentUser || null),
};
if (authLink) authLink.href = loginHref(window.location.pathname, window.location.search, window.location.hash);

function renderCount(value, message) {
    if (!foundSpaceCount) return;
    foundSpaceCount.textContent = value;
    foundSpaceCount.title = message;
    foundSpaceCount.setAttribute('aria-label', message);
    foundSpaceCount.setAttribute('aria-live', 'polite');
}

async function showFoundSpaceCount(user) {
    const revision = ++countRevision;
    const session = authRevision;
    const isCurrent = () => revision === countRevision && session === authRevision && auth.currentUser === user;
    if (!user) {
        renderCount('—', '로그인하면 발견한 공간 수를 확인할 수 있어요.');
        return null;
    }
    renderCount('…', '발견한 공간 수를 확인하고 있어요.');
    try {
        const token = await authApi.getToken();
        if (!isCurrent()) return null;
        const response = await fetch('/api/me/spaces', {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'omit',
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('공간 조회 실패');
        const count = verifiedSpaceCount(await response.json());
        if (!isCurrent()) return null;
        renderCount(String(count), `발견한 공간 ${count}곳`);
        window.dispatchEvent(new CustomEvent('spacecycle:spaceschange', { detail: { count } }));
        return count;
    } catch {
        if (!isCurrent()) return null;
        renderCount('—', '발견한 공간 수를 확인하지 못했습니다. 연결을 확인하고 새로고침해 주세요.');
        return null;
    }
}

function handleAuthState(user) {
    authRevision++;
    authApi.isReady = true;
    window.dispatchEvent(new CustomEvent('spacecycle:authchange'));
    if (user && window.location.pathname === '/login') {
        window.location.replace(readReturnPath(window.location.search, window.location.hash));
        return;
    }

    if (statusText) {
        statusText.textContent = user
            ? `${user.displayName || '사용자'}님, 로그인되었습니다.`
            : 'Google 계정으로 로그인하세요.';
    }

    if (loginButton) {
        loginButton.hidden = Boolean(user);
        loginButton.disabled = false;
    }

    if (logoutButton) {
        logoutButton.hidden = !user;
    }

    if (authLink) {
        authLink.textContent = user ? 'LOGOUT' : 'LOGIN';
    }

    if (userGreeting) {
        userGreeting.textContent = user
            ? `${user.displayName || '사용자'}님, 안녕하세요.\n오늘은 어떤 모험을 떠나보시겠어요?`
            : '';

        userGreeting.hidden = !user;
    }

    showFoundSpaceCount(user);
}

function handleAuthFailure(error) {
    authRevision++;
    countRevision++;
    authApi.isReady = false;
    if (loginButton) loginButton.disabled = true;
    if (statusText) {
        statusText.textContent = authErrorMessage(error);
        statusText.dataset.authError = 'true';
    }
    renderCount('—', '로그인 상태를 확인하지 못했습니다. 새로고침해 주세요.');
}

try {
    auth = getAuth(initializeApp(firebaseConfig));
    provider = new GoogleAuthProvider();
    onAuthStateChanged(auth, handleAuthState, handleAuthFailure);
} catch (error) {
    handleAuthFailure(error);
}

let authBusy = false;

async function runAuthAction(button, action, pendingMessage) {
    if (!authApi.isReady || authBusy) return;
    authBusy = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    if (statusText) statusText.textContent = pendingMessage;
    try {
        // Invoke synchronously: popup creation must stay in the user click stack.
        await action();
    } catch (error) {
        const message = authErrorMessage(error);
        if (statusText) statusText.textContent = message;
        else window.alert(message);
    } finally {
        authBusy = false;
        button.disabled = !authApi.isReady;
        button.removeAttribute('aria-busy');
        button.removeAttribute('aria-disabled');
    }
}

loginButton?.addEventListener('click', () => {
    if (!auth?.currentUser) runAuthAction(loginButton, () => signInWithPopup(auth, provider), 'Google 로그인 창에서 계정을 선택해 주세요.');
});

logoutButton?.addEventListener('click', () => {
    if (auth?.currentUser) runAuthAction(logoutButton, () => signOut(auth), '로그아웃하고 있어요.');
});
authLink?.addEventListener('click', (event) => {
    if (!auth?.currentUser) {
        authLink.href = loginHref(window.location.pathname, window.location.search, window.location.hash);
        return;
    }
    event.preventDefault();
    runAuthAction(authLink, () => signOut(auth), '로그아웃하고 있어요.');
});