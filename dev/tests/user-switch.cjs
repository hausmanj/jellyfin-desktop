// Run from the repository root: node --test dev/tests/user-switch.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function storage() {
    const data = new Map();
    return {getItem: key => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key)};
}
function client(local = storage(), session = storage()) {
    const auth = [];
    const window = {location: {origin: 'https://media.test', href: '', hash: ''},
        addEventListener() {}, ApiClient: {setAuthenticationInfo: (...args) => auth.push(args)}};
    const document = {body: null, addEventListener() {}, removeEventListener() {}, getElementById: () => null};
    vm.runInNewContext(fs.readFileSync('src/web/user-switch.js', 'utf8'),
        {window, document, localStorage: local, sessionStorage: session, console});
    return {api: window.jfdUserSwitch, window, auth, local, session};
}
function seed(local, id, name, token, serverId = 'server-one') {
    local.setItem('jellyfin_credentials', JSON.stringify({Servers: [{Id: serverId, UserId: id,
        UserName: name, AccessToken: token, ManualAddress: 'https://media.test'}]}));
}
test('profiles survive document recreation and switch credentials in both stores', () => {
    const local = storage();
    seed(local, 'alice', 'Alice', 'test-token-a');
    let c = client(local);
    seed(local, 'bob', 'Bob', 'test-token-b');
    c.api.captureCurrentProfile();
    c = client(local, c.session);
    assert.equal(c.api.profiles().length, 2);
    const alice = c.api.profiles().find(p => p.id === 'alice');
    assert.equal(c.api.switchToProfile(alice), true);
    const server = JSON.parse(local.getItem('jellyfin_credentials')).Servers[0];
    assert.equal(server.UserId, 'alice');
    assert.equal(server.AccessToken, 'test-token-a');
    assert.deepEqual(c.auth.at(-1), ['test-token-a', 'alice']);
    assert.equal(c.window.location.href, 'https://media.test');
    assert.equal(JSON.parse(c.session.getItem('jfdPendingSwitch')).id, 'alice');
});
test('add user saves cancel credentials and clears the switch recovery guard', () => {
    const local = storage();
    seed(local, 'alice', 'Alice', 'test-token-a');
    const c = client(local);
    c.session.setItem('jfdPendingSwitch', '{}');
    assert.equal(c.api.addUser(), true);
    assert.equal(c.session.getItem('jfdPendingSwitch'), null);
    assert.equal(JSON.parse(c.session.getItem('jfdPreAddUserCreds')).Servers[0].UserId, 'alice');
    assert.equal(JSON.parse(local.getItem('jellyfin_credentials')).Servers[0].AccessToken, undefined);
    assert.equal(c.window.location.hash, '!/login.html');
    assert.equal(c.api.profiles().length, 1);
});
test('deleting a saved profile leaves another server and active credentials alone', () => {
    const local = storage();
    seed(local, 'alice', 'Alice', 'test-token-a');
    const c = client(local);
    seed(local, 'bob', 'Bob', 'test-token-b', 'server-two');
    c.api.captureCurrentProfile();
    c.api.deleteProfile(c.api.profiles().find(p => p.id === 'alice'));
    assert.equal(c.api.profiles().length, 1);
    assert.equal(c.api.profiles()[0].serverId, 'server-two');
    assert.equal(JSON.parse(local.getItem('jellyfin_credentials')).Servers[0].UserId, 'bob');
    assert.equal(c.api.switchToProfile({id: 'invalid'}), false);
});
