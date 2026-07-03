(function() {
    const STORE_KEY = 'jellyfin_desktop_user_profiles_v1';
    const CREDENTIALS_KEY = 'jellyfin_credentials';
    const STARTUP_GUARD_KEY = 'jfdStartupPickerShown';

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

    function captureCurrentProfile() {
        const credentials = readCredentials();
        const server = activeServer(credentials);
        if (!server) return null;

        const user = userFromStorage(server);
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
        if (credentials && Array.isArray(credentials.Servers)) {
            delete server.AccessToken;
            delete server.UserId;
            server.DateLastAccessed = Date.now();
            writeCredentials(credentials);
        }
        try { sessionStorage.setItem(STARTUP_GUARD_KEY, '1'); } catch (err) { /* ignore */ }
        removePicker();
        // Hash-only navigation keeps the same document alive, avoiding the CEF
        // focus reset that a full href reload causes on Windows OSR.
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

    function installMenuItem() {
        if (document.getElementById('jfdSelectUserSettingsItem')) return true;

        const signOut = findRowByLabel('Sign Out');
        const selectServer = findRowByLabel('Select Server');
        const exitApplication = findRowByLabel('Exit Application');
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
        return true;
    }

    window.jfdUserSwitch = {
        captureCurrentProfile,
        profiles: allProfiles,
        showPicker,
        switchToProfile,
        addUser
    };

    // Keep the saved-profile store fresh from real navigation/login events.
    captureCurrentProfile();
    window.addEventListener('focus', captureCurrentProfile);
    window.addEventListener('storage', captureCurrentProfile);

    // window/document always exist, so these listeners can attach immediately.
    window.addEventListener('pageshow', installMenuItem);
    document.addEventListener('viewshow', installMenuItem, true);

    // The DOM-dependent setup must wait until <body> exists: this script is
    // injected at document-start, when document.body/documentElement are still
    // null and MutationObserver.observe() would throw and abort init.
    function startWhenReady() {
        const target = document.body || document.documentElement;
        if (!target) return;
        // Install the menu item whenever the preferences page is (re)rendered.
        // Event-driven only: a scoped MutationObserver, no polling/timeouts.
        new MutationObserver(() => installMenuItem()).observe(target, { childList: true, subtree: true });
        installMenuItem();
        maybeShowStartupPicker();
    }

    if (document.body) {
        startWhenReady();
    } else {
        document.addEventListener('DOMContentLoaded', startWhenReady, { once: true });
    }
})();
