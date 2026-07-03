(function() {
    console.warn('[JFD] user-switch.js loaded, hash=' + window.location.hash);
    const STORE_KEY = 'jellyfin_desktop_user_profiles_v1';
    const CREDENTIALS_KEY = 'jellyfin_credentials';
    const STARTUP_GUARD_KEY = 'jfdStartupPickerShown';
    // Saved before addUser() clears credentials; restored on cancel.
    const ADD_USER_SAVED_CREDS_KEY = 'jfdPreAddUserCreds';
    const ADD_USER_SAVED_HASH_KEY  = 'jfdPreAddUserHash';

    // Class names that are structural to a menu-row icon span. Anything else on
    // a cloned icon span is the source row's glyph and must be stripped so our
    // icon shows instead of (e.g.) the "Sign Out" glyph.
    const ICON_STRUCTURAL = new Set([
        'material-icons', 'md-icon',
        'listItemIcon', 'listItemIcon-transparent',
        'actionsheetMenuItemIcon'
    ]);

    function parseJson(text, fallback) {
        if (!text) return fallback;
        try {
            return JSON.parse(text);
        } catch (err) {
            console.warn('[UserSwitch] Invalid JSON in localStorage:', err.message);
            return fallback;
        }
    }

    function readCredentials() {
        const data = parseJson(localStorage.getItem(CREDENTIALS_KEY), null);
        if (!data || !Array.isArray(data.Servers)) return null;
        return data;
    }

    function writeCredentials(data) {
        localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(data));
    }

    function readStore() {
        const store = parseJson(localStorage.getItem(STORE_KEY), null);
        if (store && store.version === 1 && store.servers) return store;
        return { version: 1, servers: {} };
    }

    function writeStore(store) {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
    }

    function activeServer(credentials) {
        if (!credentials || !Array.isArray(credentials.Servers)) return null;
        return credentials.Servers.find(s => s && s.AccessToken && s.UserId && s.Id) || null;
    }

    function lastServer(credentials) {
        if (!credentials || !Array.isArray(credentials.Servers)) return null;
        return credentials.Servers
            .filter(s => s && s.Id)
            .sort((a, b) => (b.DateLastAccessed || 0) - (a.DateLastAccessed || 0))[0] || null;
    }

    function userFromStorage(server) {
        if (!server || !server.UserId || !server.Id) return null;
        return parseJson(localStorage.getItem('user-' + server.UserId + '-' + server.Id), null);
    }

    function profileName(server, user) {
        if (user && user.Name) return user.Name;
        if (server && server.UserName) return server.UserName;
        if (server && server.UserId) return 'User ' + server.UserId.slice(0, 8);
        return 'Unknown user';
    }

    function deleteProfile(profile) {
        const store = readStore();
        const server = store.servers[profile.serverId];
        if (server && server.users) {
            delete server.users[profile.id];
            if (Object.keys(server.users).length === 0) {
                delete store.servers[profile.serverId];
            }
        }
        writeStore(store);
    }

    function captureCurrentProfile() {
        const credentials = readCredentials();
        const server = activeServer(credentials);
        if (!server) return null;

        const user = userFromStorage(server);
        // Skip if we don't have a real display name — the fallback
        // "User XXXXXXXX" creates phantom entries that require re-login.
        if (!user?.Name && !server?.UserName) return null;
        const store = readStore();
        const serverId = server.Id;
        const userId = server.UserId;

        store.servers[serverId] = store.servers[serverId] || {
            id: serverId,
            name: server.Name || '',
            manualAddress: server.ManualAddress || '',
            localAddress: server.LocalAddress || '',
            users: {}
        };

        const savedServer = store.servers[serverId];
        savedServer.name = server.Name || savedServer.name || '';
        savedServer.manualAddress = server.ManualAddress || savedServer.manualAddress || '';
        savedServer.localAddress = server.LocalAddress || savedServer.localAddress || '';
        savedServer.users[userId] = {
            id: userId,
            serverId,
            name: profileName(server, user),
            primaryImageTag: user && user.PrimaryImageTag ? user.PrimaryImageTag : '',
            accessToken: server.AccessToken,
            dateLastSeen: Date.now()
        };

        writeStore(store);
        return savedServer.users[userId];
    }

    function allProfiles() {
        const store = readStore();
        const out = [];
        for (const server of Object.values(store.servers)) {
            if (!server || !server.users) continue;
            for (const user of Object.values(server.users)) {
                if (!user || !user.accessToken) continue;
                out.push({
                    id: user.id,
                    serverId: user.serverId,
                    name: user.name,
                    primaryImageTag: user.primaryImageTag || '',
                    serverName: server.name || '',
                    manualAddress: server.manualAddress || '',
                    localAddress: server.localAddress || '',
                    accessToken: user.accessToken,
                    dateLastSeen: user.dateLastSeen || 0
                });
            }
        }
        return out.sort((a, b) => (b.dateLastSeen || 0) - (a.dateLastSeen || 0));
    }

    function currentUserId() {
        const server = activeServer(readCredentials());
        return server ? server.UserId : '';
    }

    function switchToProfile(profile) {
        if (!profile || !profile.accessToken || !profile.serverId || !profile.id) return false;
        const credentials = readCredentials();
        if (!credentials) return false;

        let server = credentials.Servers.find(s => s && s.Id === profile.serverId);
        if (!server) {
            server = {
                Id: profile.serverId,
                Name: profile.serverName || '',
                ManualAddress: profile.manualAddress || window.location.origin,
                LocalAddress: profile.localAddress || '',
                LastConnectionMode: 2,
                manualAddressOnly: true
            };
            credentials.Servers.push(server);
        }

        server.AccessToken = profile.accessToken;
        server.UserId = profile.id;
        server.DateLastAccessed = Date.now();
        if (profile.manualAddress) server.ManualAddress = profile.manualAddress;
        if (profile.localAddress) server.LocalAddress = profile.localAddress;

        writeCredentials(credentials);
        captureCurrentProfile();
        // Switching triggers a reload; keep the startup picker from re-appearing.
        try { sessionStorage.setItem(STARTUP_GUARD_KEY, '1'); } catch (err) { /* ignore */ }
        window.location.href = server.ManualAddress || window.location.origin;
        return true;
    }

    function loginUrl(server) {
        const base = (server && (server.ManualAddress || server.LocalAddress)) || window.location.origin;
        return base.replace(/\/$/, '') + '/web/index.html#!/login.html';
    }

    function addUser() {
        const credentials = readCredentials();
        const server = activeServer(credentials) || lastServer(credentials) || {
            ManualAddress: window.location.origin,
            LocalAddress: window.location.origin
        };

        captureCurrentProfile();
        // Save credentials and current hash so cancel can restore both.
        try {
            sessionStorage.setItem(ADD_USER_SAVED_CREDS_KEY, JSON.stringify(readCredentials()));
            sessionStorage.setItem(ADD_USER_SAVED_HASH_KEY, window.location.hash || '');
        } catch (err) { /* ignore */ }
        if (credentials && Array.isArray(credentials.Servers)) {
            delete server.AccessToken;
            delete server.UserId;
            server.DateLastAccessed = Date.now();
            writeCredentials(credentials);
        }
        try { sessionStorage.setItem(STARTUP_GUARD_KEY, '1'); } catch (err) { /* ignore */ }
        removePicker();
        // Hash-only navigation keeps the SPA document alive so cancel can
        // restore credentials and call showPicker() without a full reload.
        window.location.hash = '!/login.html';
        return true;
    }

    function imageUrl(profile) {
        const base = profile.manualAddress || profile.localAddress || window.location.origin;
        if (!profile.primaryImageTag || !base || !profile.id) return '';
        return base.replace(/\/$/, '') + '/Users/' + profile.id + '/Images/Primary?tag=' +
            encodeURIComponent(profile.primaryImageTag) + '&maxWidth=160';
    }

    function removePicker() {
        document.removeEventListener('keydown', onOverlayKeydown, true);
        const existing = document.getElementById('jfdUserSwitchOverlay');
        if (existing) existing.remove();
    }

    function onOverlayKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            removePicker();
        }
    }

    function overlayParent() {
        return document.body || document.documentElement;
    }

    function buttonForProfile(profile, activeId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = [
            'display:flex',
            'align-items:center',
            'gap:14px',
            'width:100%',
            'padding:14px',
            'border:1px solid rgba(255,255,255,.18)',
            'border-radius:8px',
            'background:rgba(255,255,255,.07)',
            'color:#fff',
            'text-align:left',
            'cursor:pointer'
        ].join(';');

        const img = document.createElement('div');
        img.style.cssText = [
            'width:48px',
            'height:48px',
            'border-radius:50%',
            'background:#333',
            'background-size:cover',
            'background-position:center',
            'flex:0 0 auto'
        ].join(';');
        const url = imageUrl(profile);
        if (url) img.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
        btn.appendChild(img);

        const label = document.createElement('div');
        label.style.flex = '1';
        const name = document.createElement('div');
        name.textContent = profile.name || 'Unknown user';
        name.style.cssText = 'font-size:1.05rem;font-weight:600';
        label.appendChild(name);
        if (profile.serverName) {
            const server = document.createElement('div');
            server.textContent = profile.serverName;
            server.style.cssText = 'font-size:.85rem;opacity:.72;margin-top:2px';
            label.appendChild(server);
        }
        btn.appendChild(label);

        if (profile.id === activeId) {
            const badge = document.createElement('div');
            badge.textContent = 'Current';
            badge.style.cssText = 'font-size:.78rem;opacity:.75';
            btn.appendChild(badge);
        } else {
            const del = document.createElement('button');
            del.type = 'button';
            del.textContent = '×';
            del.title = 'Remove profile';
            del.style.cssText = 'background:transparent;border:0;color:#fff;opacity:.5;cursor:pointer;font-size:1.4rem;padding:0 4px;line-height:1;flex:0 0 auto';
            del.addEventListener('click', (event) => {
                event.stopPropagation();
                deleteProfile(profile);
                showPicker();
            });
            btn.appendChild(del);
        }

        btn.addEventListener('click', () => switchToProfile(profile));
        return btn;
    }

    function showPicker() {
        captureCurrentProfile();
        const profiles = allProfiles();
        const parent = overlayParent();
        if (!parent) return false;

        removePicker();

        const overlay = document.createElement('div');
        overlay.id = 'jfdUserSwitchOverlay';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'background:rgba(0,0,0,.72)',
            'padding:24px',
            'box-sizing:border-box',
            'visibility:visible',
            'opacity:1',
            'pointer-events:auto'
        ].join(';');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        // Clicking the backdrop (but not the panel) dismisses the picker.
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) removePicker();
        });

        const panel = document.createElement('div');
        panel.style.cssText = [
            'width:min(520px,100%)',
            'max-height:min(720px,100%)',
            'overflow:auto',
            'background:#101010',
            'border:1px solid rgba(255,255,255,.16)',
            'border-radius:8px',
            'box-shadow:0 18px 60px rgba(0,0,0,.45)',
            'padding:22px',
            'box-sizing:border-box',
            'color:#fff'
        ].join(';');
        overlay.appendChild(panel);

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px';
        const title = document.createElement('h2');
        title.textContent = "Who's watching?";
        title.style.cssText = 'margin:0;font-size:1.35rem;font-weight:600';
        header.appendChild(title);

        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.style.cssText = 'background:transparent;border:0;color:#fff;opacity:.8;cursor:pointer;font-size:.95rem';
        close.addEventListener('click', removePicker);
        header.appendChild(close);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:10px';
        const activeId = currentUserId();
        for (const profile of profiles) {
            list.appendChild(buttonForProfile(profile, activeId));
        }
        panel.appendChild(list);

        if (!profiles.length) {
            const empty = document.createElement('div');
            empty.textContent = 'No saved users yet.';
            empty.style.cssText = 'padding:14px;border:1px solid rgba(255,255,255,.16);border-radius:8px;opacity:.78';
            panel.appendChild(empty);
        }

        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = 'Add user';
        add.style.cssText = [
            'width:100%',
            'margin-top:14px',
            'padding:13px 14px',
            'border:1px solid rgba(255,255,255,.22)',
            'border-radius:8px',
            'background:transparent',
            'color:#fff',
            'font-size:1rem',
            'cursor:pointer'
        ].join(';');
        add.addEventListener('click', addUser);
        panel.appendChild(add);

        parent.appendChild(overlay);
        document.addEventListener('keydown', onOverlayKeydown, true);
        return true;
    }

    // Startup picker: only worth showing when there is a genuine choice to make
    // (2+ saved profiles) and only once per app session — never on every reload.
    function maybeShowStartupPicker() {
        try {
            if (sessionStorage.getItem(STARTUP_GUARD_KEY)) return;
        } catch (err) { /* sessionStorage unavailable: fall through and show once */ }
        captureCurrentProfile();
        if (allProfiles().length < 2) return;
        try { sessionStorage.setItem(STARTUP_GUARD_KEY, '1'); } catch (err) { /* ignore */ }
        showPicker();
    }

    function normalizedText(el) {
        return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
    }

    // Rows on the "My Preferences" settings page (#/mypreferencesmenu) are
    // anchors of the form:
    //   <a class="emby-button ... listItem-border" href="#/...">
    //     <div class="listItem">
    //       <span class="material-icons listItemIcon listItemIcon-transparent GLYPH"></span>
    //       <div class="listItemBody"><div class="listItemBodyText">Label</div></div>
    //     </div></a>
    // Matching on `a.listItem-border` gives the full, correctly-aligned row.
    function menuRows() {
        return Array.from(document.querySelectorAll('a.listItem-border'));
    }

    function findRowByLabel(label) {
        const lower = label.toLowerCase();
        const rows = menuRows();
        return rows.find(r => normalizedText(r).toLowerCase() === lower)
            || rows.find(r => normalizedText(r).toLowerCase().includes(lower))
            || null;
    }

    // Icons here are class-based (the glyph is a class such as `person`, with an
    // empty text node), not ligature text. Strip the source row's glyph class and
    // add ours; keep the structural classes so sizing/color still apply.
    function setRowIcon(row, glyph) {
        const icon = row.querySelector('.material-icons, .listItemIcon');
        if (!icon) return;
        for (const cls of Array.from(icon.classList)) {
            if (!ICON_STRUCTURAL.has(cls)) icon.classList.remove(cls);
        }
        if (!icon.classList.contains('material-icons')) icon.classList.add('material-icons');
        icon.classList.add(glyph);
        icon.textContent = '';
    }

    function setRowLabel(row, text) {
        const body = row.querySelector('.listItemBodyText') || row.querySelector('.listItemBody');
        if (body) {
            body.textContent = text;
            return;
        }
        row.textContent = text;
    }

    function onMenuActivate() {
        showPicker();
    }

    function isPreferencesPage() {
        const hash = (window.location.hash || '').toLowerCase();
        return hash.includes('mypreferencesmenu') || hash.includes('mypreferences');
    }

    function installMenuItem() {
        if (!isPreferencesPage()) return false;

        const existing = document.getElementById('jfdSelectUserSettingsItem');
        if (existing) {
            console.warn('[JFD] installMenuItem: row exists, parentNode=' +
                (existing.parentNode ? existing.parentNode.tagName + '.' + existing.parentNode.className.slice(0,40) : 'DETACHED'));
            return true;
        }

        const signOut = findRowByLabel('Sign Out');
        const selectServer = findRowByLabel('Select Server');
        const exitApplication = findRowByLabel('Exit Application');
        console.warn('[JFD] installMenuItem: signOut=' + !!signOut +
            ' selectServer=' + !!selectServer + ' exitApp=' + !!exitApplication);
        const reference = signOut || selectServer || exitApplication;
        if (!reference || !reference.parentNode) return false;

        const row = reference.cloneNode(true);
        row.id = 'jfdSelectUserSettingsItem';
        // Drop the reference row's behaviour classes (e.g. btnLogout / selectServer
        // / exitApp) so jellyfin-web's delegated handlers don't fire on our row.
        row.className = 'emby-button listItem-border';
        row.removeAttribute('href');
        row.removeAttribute('data-itemid');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.style.cursor = 'pointer';
        setRowIcon(row, 'people');
        setRowLabel(row, 'Select User');

        row.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onMenuActivate();
        }, true);
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onMenuActivate();
            }
        });

        // Group it with the account actions: above Sign Out, else just after
        // Select Server, else above Exit Application.
        if (signOut && signOut.parentNode) {
            signOut.parentNode.insertBefore(row, signOut);
        } else if (selectServer && selectServer.parentNode) {
            selectServer.parentNode.insertBefore(row, selectServer.nextSibling);
        } else {
            reference.parentNode.insertBefore(row, reference);
        }

        // Walk ancestors to find and fix the element clipping our extra row.
        // We look for overflow:hidden OR a max-height constraint — both can
        // clip content. Log the full chain so we can see what's constraining.
        let fixedEl = null;
        let depth = 0;
        let el = row.parentNode;
        while (el && el !== document.body) {
            const cs = window.getComputedStyle(el);
            const hasOverflowHidden = cs.overflow === 'hidden' || cs.overflowY === 'hidden';
            const hasMaxHeight = cs.maxHeight !== 'none' && cs.maxHeight !== '' && cs.maxHeight !== '0px';
            console.warn('[JFD] ancestor[' + depth + '] <' + el.tagName + '> class="' +
                el.className.slice(0, 50) + '" overflow=' + cs.overflow +
                ' overflowY=' + cs.overflowY + ' height=' + cs.height + ' maxHeight=' + cs.maxHeight);
            if (hasOverflowHidden || hasMaxHeight) {
                el.classList.add('jfd-settings-overflow-fix');
                console.warn('[JFD] → tagged ancestor[' + depth + '] with jfd-settings-overflow-fix' +
                    (hasOverflowHidden ? ' (overflow:hidden)' : '') +
                    (hasMaxHeight ? ' (maxHeight=' + cs.maxHeight + ')' : ''));
                fixedEl = el;
                // Watch for the class being stripped back off.
                new MutationObserver(() => {
                    if (!el.classList.contains('jfd-settings-overflow-fix')) {
                        console.warn('[JFD] WARNING: jfd-settings-overflow-fix removed from ancestor[' + depth + '] — re-adding');
                        el.classList.add('jfd-settings-overflow-fix');
                    }
                }).observe(el, { attributes: true, attributeFilter: ['class'] });
                break;
            }
            el = el.parentNode;
            depth++;
        }
        if (!fixedEl) {
            console.warn('[JFD] WARNING: no clipping ancestor found after ' + depth + ' levels');
        }

        // Watch for our row or any sibling being removed from the parent.
        const parent = row.parentNode;
        const siblingsBefore = Array.from(parent.children).map(c =>
            (c.id || '') + ':' + c.className.slice(0,20));
        console.warn('[JFD] siblings at insertion: [' + siblingsBefore.join(', ') + ']');
        new MutationObserver((muts) => {
            for (const m of muts) {
                for (const n of m.removedNodes) {
                    if (n.nodeType === 1) {
                        console.warn('[JFD] REMOVED from parent: id=' + n.id +
                            ' class=' + n.className.slice(0,30));
                    }
                }
                for (const n of m.addedNodes) {
                    if (n.nodeType === 1) {
                        console.warn('[JFD] ADDED to parent: id=' + n.id +
                            ' class=' + n.className.slice(0,30));
                    }
                }
            }
        }).observe(parent, { childList: true });

        return true;
    }

    window.jfdUserSwitch = {
        captureCurrentProfile,
        profiles: allProfiles,
        showPicker,
        switchToProfile,
        addUser,
        deleteProfile
    };

    // Keep the saved-profile store fresh from real navigation/login events.
    captureCurrentProfile();
    window.addEventListener('focus', captureCurrentProfile);
    window.addEventListener('storage', captureCurrentProfile);

    function isLoginPage() {
        const h = (window.location.hash || '').toLowerCase();
        const p = (window.location.pathname || '').toLowerCase();
        return h.includes('login') || p === '/login' || p.endsWith('/login');
    }

    // Inject a "Back to user selection" button directly below the Sign In
    // button so it appears as a natural part of the login form's action area.
    function injectLoginCancelButton() {
        if (!isLoginPage()) return;
        if (document.getElementById('jfdLoginCancelBtn')) return;
        if (allProfiles().length < 1) return;

        // Only show cancel if we actually came from addUser() (saved state exists).
        let hasSavedState = false;
        try { hasSavedState = !!sessionStorage.getItem(ADD_USER_SAVED_CREDS_KEY); } catch (err) {}
        if (!hasSavedState) return;

        // The Sign In button is the anchor; we need its parent to insert after it.
        const signIn = document.querySelector('.btnLogin')
            || document.querySelector('button[type="submit"]')
            || document.querySelector('input[type="submit"]');
        if (!signIn || !signIn.parentNode) return;

        const btn = document.createElement('button');
        btn.id = 'jfdLoginCancelBtn';
        btn.type = 'button';
        // Mirror the sign-in button's classes but strip the primary action
        // modifiers so this reads as a secondary/back action.
        btn.className = (signIn.className || '')
            .replace(/\bbtnLogin\b/g, '')
            .replace(/\bbutton-submit\b/g, 'button-flat')
            .replace(/\bMuiButton-contained\b/g, 'MuiButton-outlined')
            .replace(/\bMuiButton-containedPrimary\b/g, '')
            .trim();
        btn.style.marginTop = '8px';
        btn.textContent = '← Back to user selection';
        btn.addEventListener('click', () => {
            // Restore the credentials that addUser() cleared so Jellyfin
            // doesn't redirect to its own login page when we navigate home.
            try {
                const saved = sessionStorage.getItem(ADD_USER_SAVED_CREDS_KEY);
                if (saved) writeCredentials(JSON.parse(saved));
                sessionStorage.removeItem(ADD_USER_SAVED_CREDS_KEY);
            } catch (err) { /* ignore */ }

            // Navigate back to where we were via hash change (same SPA doc),
            // then show the picker. The overlay is added to document.body which
            // persists across hash changes, so it appears as the page renders.
            let returnHash = '';
            try {
                returnHash = sessionStorage.getItem(ADD_USER_SAVED_HASH_KEY) || '';
                sessionStorage.removeItem(ADD_USER_SAVED_HASH_KEY);
            } catch (err) {}
            window.location.hash = returnHash || '!/home.html';
            showPicker();
        });
        signIn.parentNode.insertBefore(btn, signIn.nextSibling);
    }

    // Tab between login form fields. jellyfin-apiclient's focus manager sets
    // tabindex="-1" on all inputs and intercepts Tab for spatial navigation,
    // completely breaking native Tab traversal on the login form.
    // Strategy: (1) restore tabindex on login inputs so they're in the tab
    // order; (2) add a capture-phase keydown handler that manually cycles
    // focus so we win even if Jellyfin's handler also runs.
    function fixLoginInputTabindex() {
        if (!isLoginPage()) return;
        document.querySelectorAll('input[type="text"], input[type="password"], input[type="email"]')
            .forEach(el => {
                if (el.getAttribute('tabindex') === '-1') {
                    el.setAttribute('tabindex', '0');
                }
            });
    }

    function addLoginTabFix() {
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Tab' && e.keyCode !== 9) return;
            if (!isLoginPage()) return;
            const active = document.activeElement;
            if (!active || active === document.body || active === document.documentElement) return;
            // Search whole document — don't require a <form> ancestor since some
            // Jellyfin versions use divs instead.
            const inputs = Array.from(document.querySelectorAll(
                'input[type="text"], input[type="password"], input[type="email"], input:not([type])'
            )).filter(el => !el.disabled && el.type !== 'hidden');
            if (inputs.length < 2) return;
            // Jellyfin's focus manager sometimes lands focus on a wrapper div
            // instead of the input itself. Check the element and its descendants.
            let idx = inputs.indexOf(active);
            if (idx === -1) {
                const contained = inputs.find(el => active.contains(el));
                idx = contained ? inputs.indexOf(contained) : -1;
            }
            if (idx === -1) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            const next = e.shiftKey
                ? inputs[(idx - 1 + inputs.length) % inputs.length]
                : inputs[(idx + 1) % inputs.length];
            // Use the prototype directly in case Jellyfin overrides .focus().
            if (next) HTMLElement.prototype.focus.call(next);
        }, true);
    }

    function onDomChange() {
        installMenuItem();
        injectLoginCancelButton();
        fixLoginInputTabindex();
    }

    // window/document always exist, so these listeners can attach immediately.
    window.addEventListener('pageshow', onDomChange);
    document.addEventListener('viewshow', onDomChange, true);

    // The DOM-dependent setup must wait until <body> exists: this script is
    // injected at document-start, when document.body/documentElement are still
    // null and MutationObserver.observe() would throw and abort init.
    function startWhenReady() {
        const target = document.body || document.documentElement;
        if (!target) return;

        // Inject a persistent CSS rule that wins over Jellyfin's inline styles.
        // installMenuItem() adds jfd-settings-overflow-fix to the first ancestor
        // that clips overflow, keeping Exit Application and Select Server visible.
        if (!document.getElementById('jfdOverflowStyle')) {
            const style = document.createElement('style');
            style.id = 'jfdOverflowStyle';
            style.textContent = '.jfd-settings-overflow-fix { overflow: visible !important; max-height: none !important; }';
            (document.head || target).appendChild(style);
        }

        // Install the menu item and cancel button whenever the page (re)renders.
        // Event-driven only: a scoped MutationObserver, no polling/timeouts.
        new MutationObserver(onDomChange).observe(target, { childList: true, subtree: true });
        onDomChange();
        addLoginTabFix();
        maybeShowStartupPicker();
    }

    if (document.body) {
        startWhenReady();
    } else {
        document.addEventListener('DOMContentLoaded', startWhenReady, { once: true });
    }
})();
