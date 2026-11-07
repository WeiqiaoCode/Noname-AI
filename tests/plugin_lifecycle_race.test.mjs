import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerPlugin, installPlugin, uninstallPlugin, uninstallAllPlugins, pluginState,
} from '../score/foundation/runtime/plugins.js';

let serial = 0;
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(label) {
  const id = 'b1-l01-' + label + '-' + (++serial);
  const gate = deferred();
  let cleanup = 0, installs = 0;
  const plugin = {
    id,
    onInstall() { installs++; return gate.promise; },
    onUninstall() { cleanup++; },
  };
  assert.equal(registerPlugin(plugin, { install: false }).ok, true);
  return { id, gate, get cleanup() { return cleanup; }, get installs() { return installs; } };
}

test('B1-L01: uninstall while async onInstall pending never resurrects plugin', async () => {
  const f = fixture('pending');
  const pending = installPlugin(f.id);
  assert.equal(pluginState(f.id).state, 'installing');
  assert.equal(installPlugin(f.id), pending, 'duplicate install shares in-flight promise');
  assert.equal(f.installs, 1);
  assert.equal(uninstallPlugin(f.id).ok, true);
  assert.equal(f.cleanup, 0, 'cleanup deferred until onInstall settles');
  f.gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(f.cleanup, 1, 'cleanup occurs exactly once after settlement');
  assert.equal(pluginState(f.id).state, 'pending');
});

test('B1-L01: cancelled rejected installation cleans up and does not install', async () => {
  const f = fixture('rejection');
  const pending = installPlugin(f.id);
  uninstallPlugin(f.id);
  f.gate.reject(new Error('late failure'));
  assert.equal((await pending).ok, false);
  assert.equal(f.cleanup, 1);
  assert.equal(pluginState(f.id).state, 'pending');
});

test('B1-L01: global unload cancels unresolved installations', async () => {
  const f = fixture('all');
  const pending = installPlugin(f.id);
  assert.ok(uninstallAllPlugins() >= 1);
  f.gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(f.cleanup, 1);
  assert.equal(pluginState(f.id).state, 'pending');
});
