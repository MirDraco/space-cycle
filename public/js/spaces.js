(() => {
    const tablist = document.getElementById('spaces-tabs');
    if (!tablist) return;

    const tabs = [...tablist.querySelectorAll('[data-category-tab]')];
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
    if (!tabs.length || panels.some(panel => !panel)) return;

    const activate = index => {
        tabs.forEach((tab, current) => {
            const selected = current === index;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            panels[current].hidden = !selected;
        });
    };

    tabs.forEach((tab, index) => {
        panels[index].setAttribute('role', 'tabpanel');
        panels[index].setAttribute('aria-labelledby', tab.id);
        panels[index].tabIndex = 0;
        tab.addEventListener('click', () => activate(index));
        tab.addEventListener('keydown', event => {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            else return;
            event.preventDefault();
            activate(next);
            tabs[next].focus();
        });
    });

    activate(0);
    tablist.hidden = false;

    // Keep one disclosure open even on browsers without <details name> grouping.
    const spaces = [...document.querySelectorAll('details[data-space-slot]')];
    spaces.forEach(space => space.addEventListener('toggle', () => {
        if (space.open) spaces.forEach(other => { if (other !== space) other.open = false; });
    }));

    const selection = window.SpaceCycleQrPolicy?.readSelection(window.location.search);
    if (selection?.valid && selection.spaceId) {
        const target = spaces.find(space => space.dataset.spaceSlot === selection.spaceId);
        if (target) {
            const index = tabs.findIndex(tab => tab.dataset.categoryTab === target.dataset.category);
            activate(index);
            target.open = true;
            target.querySelector('summary').focus();
        }
    }
})();
