import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut }
    from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import { getFirestore, doc, getDoc }
    from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyAPTYO5sUQqT2DFxbcdDcILDYfTK8mExmg",
  authDomain: "space-cycle-1b705.firebaseapp.com",
  projectId: "space-cycle-1b705",
  storageBucket: "space-cycle-1b705.firebasestorage.app",
  messagingSenderId: "298253427014",
  appId: "1:298253427014:web:b50808f576517d1a518547",
  measurementId: "G-XM3JQRJFVL"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
const loginButton = document.getElementById('google-login');
const logoutButton = document.getElementById('logout');
const statusText = document.getElementById('auth-status');
const authLink = document.querySelector('[data-auth-link]');
const userGreeting = document.getElementById('user-greeting');
const foundSpaceCount = document.getElementById('found-space-count');

function foundSpaceTotal(data) {
    if (!data) {
        return 0;
    }

    if (Array.isArray(data.foundSpaces)) {
        return data.foundSpaces.length;
    }

    if (typeof data.foundSpaceCount === 'number') {
        return data.foundSpaceCount;
    }

    return 0;
}

async function showFoundSpaceCount(user) {
    if (!foundSpaceCount) {
        return;
    }

    if (!user) {
        foundSpaceCount.textContent = '—';
        return;
    }

    foundSpaceCount.textContent = '…';

    try {
        const snapshot = await getDoc(doc(db, 'users', user.uid));
        foundSpaceCount.textContent = String(foundSpaceTotal(snapshot.data()));
    } catch (error) {
        console.error(error.code || error);
        foundSpaceCount.textContent = '0';
    }
}

onAuthStateChanged(auth, (user) => {
    if (user && window.location.pathname === '/login') {
        window.location.replace('/');
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
});

async function runAuthAction(button, action) {
    button.disabled = true;
    try {
        await action();
    } catch (error) {
        console.error(error.code);
        statusText.textContent = '인증 처리를 완료하지 못했습니다. 다시 시도해 주세요.';
    } finally {
        button.disabled = false;
    }
}

loginButton?.addEventListener('click', () => {
    runAuthAction(loginButton, () => signInWithPopup(auth, provider));
});

logoutButton?.addEventListener('click', () => {
    runAuthAction(logoutButton, () => signOut(auth));
});
authLink?.addEventListener('click', async (event) => {
    if (!auth.currentUser) {
        return;
    }

    event.preventDefault();

    try {
        await signOut(auth);
    } catch (error) {
        console.error(error.code);
        alert('로그아웃하지 못했습니다. 다시 시도해 주세요.');
    }
});