(() => {
    const storageKey = 'space-cycle-theme';
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    let savedTheme = null;

    try {
        const storedValue = localStorage.getItem(storageKey);
        if (storedValue === 'light' || storedValue === 'dark') {
            savedTheme = storedValue;
        }
    } catch {}

    const applyTheme = (theme) => {
        document.documentElement.dataset.theme = theme;
        const toggle = document.getElementById('theme-toggle');
        if (toggle) {
            toggle.checked = theme === 'dark';
        }
    };

    applyTheme(savedTheme || (systemTheme.matches ? 'dark' : 'light'));

    document.addEventListener('DOMContentLoaded', () => {
        const toggle = document.getElementById('theme-toggle');
        if (!toggle) return;

        applyTheme(document.documentElement.dataset.theme);
        toggle.addEventListener('change', () => {
            savedTheme = toggle.checked ? 'dark' : 'light';
            applyTheme(savedTheme);
            try {
                localStorage.setItem(storageKey, savedTheme);
            } catch {}
        });
    });

    systemTheme.addEventListener('change', (event) => {
        if (!savedTheme) {
            applyTheme(event.matches ? 'dark' : 'light');
        }
    });
})();