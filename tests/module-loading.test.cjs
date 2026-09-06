const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");
const contextSource = read("scripts/module/context.js");
const mainSource = read("scripts/main.js");
const recoverySource = read("scripts/features/frightened-recovery.js");
const flush = () => new Promise(setImmediate);

function setup({ loaded = false, bestiaryLoaded = true } = {}) {
  const hooks = new Map();
  const scripts = [];
  const errors = [];
  const notifications = [];
  const settings = new Map();
  let trackerUpdates = 0;
  const register = (name, fn) => {
    const listeners = hooks.get(name) ?? [];
    listeners.push(fn);
    hooks.set(name, listeners);
  };
  const context = vm.createContext({
    Hooks: { on: register, once: register },
    game: { keybindings: { register: () => {} }, settings: { register: (_id, key, value) => settings.set(key, value), get: () => true } },
    document: { querySelector: () => ({}), createElement: (name) => ({ tagName: name }), head: { append: (script) => scripts.push(script) } },
    foundry: { utils: { getRoute: (path) => `/foundry/${path}` } },
    console: { log: () => {}, error: (...args) => errors.push(args) },
    ui: { notifications: { error: (message) => notifications.push(message) } },
  });
  vm.runInContext(contextSource, context);
  const noOp = () => {};
  context.pf2eEliottTools.features = {
    champion: { oathOfTheDefender: { onInit: noOp } }, spells: { shieldsOfTheSpirit: {} },
    criticalDeckTranslation: { onInit: noOp, onReady: noOp },
    combatTrackerEnhancements: { onUpdateCombat: () => trackerUpdates++ },
    worldClock: { onInit: noOp, onReady: noOp }, preciousMaterialArmor: {},
    weaponFamiliarity: { onInit: noOp },
    bestiary: { initialize: noOp },
  };
  if (!bestiaryLoaded) delete context.pf2eEliottTools.features.bestiary;
  if (loaded) vm.runInContext(recoverySource, context);
  vm.runInContext(mainSource, context);
  const emit = (name, ...args) => hooks.get(name)?.forEach((fn) => fn(...args));
  return { context, hooks, scripts, errors, notifications, settings, emit,
    load: () => vm.runInContext(recoverySource, context),
    get trackerUpdates() { return trackerUpdates; } };
}

test("cached manifest: new settings appear and recovery script is loaded before registering hooks", async () => {
  const env = setup();
  env.emit("init");
  assert.equal(env.settings.get("frightenedRecoveryEnabled").default, true);
  env.emit("ready");
  assert.equal(env.scripts.length, 1);
  assert.equal(env.scripts[0].src, "/foundry/modules/pf2e-eliott-tools/scripts/features/frightened-recovery.js");
  // Reproduces the user's events while the feature is still missing.
  assert.doesNotThrow(() => env.emit("updateCombat", {}, { turn: 1 }));
  assert.doesNotThrow(() => env.emit("pf2e.endTurn", {}, {}));
  assert.equal(env.hooks.has("pf2e.endTurn"), false);
  env.load();
  const calls = [];
  env.context.pf2eEliottTools.features.frightenedRecovery.onEndTurn = (...args) => calls.push(args);
  env.scripts[0].onload();
  await flush();
  env.emit("pf2e.endTurn", "combatant", "encounter");
  assert.deepEqual(calls, [["combatant", "encounter"]]);
  assert.equal(env.hooks.get("pf2e.endTurn").length, 1);
  assert.deepEqual(env.errors, []);
});

test("fresh manifest: existing feature is reused without loading or registering twice", async () => {
  const env = setup({ loaded: true });
  const original = env.context.pf2eEliottTools.features.frightenedRecovery;
  env.emit("ready");
  await flush();
  assert.equal(env.scripts.length, 0);
  assert.equal(env.hooks.get("pf2e.endTurn").length, 1);
  assert.equal(env.context.pf2eEliottTools.features.frightenedRecovery, original);
});

test("network failure reports a load error and does not break the combat tracker", async () => {
  const env = setup();
  env.emit("ready");
  env.scripts[0].onerror();
  await flush();
  assert.equal(env.errors.length, 1);
  assert.equal(env.notifications.length, 1);
  assert.equal(env.hooks.has("pf2e.endTurn"), false);
  env.emit("updateCombat", {}, { turn: 1 });
  assert.equal(env.trackerUpdates, 1);
});

test("a script that fails to initialize reports the problem rather than installing broken callbacks", async () => {
  const env = setup();
  env.emit("ready");
  env.scripts[0].onload();
  await flush();
  assert.equal(env.errors.length, 1);
  assert.equal(env.notifications.length, 1);
  assert.equal(env.hooks.has("pf2e.endTurn"), false);
});

test("cached manifest loads bestiary dependencies in order before initialization", async () => {
  const env = setup({ loaded: true, bestiaryLoaded: false });
  env.emit("ready");
  for (const [index, file] of ["model", "store", "application", "index"].entries()) {
    assert.equal(env.scripts.length, index + 1);
    assert.equal(env.scripts[index].src, `/foundry/modules/pf2e-eliott-tools/scripts/features/bestiary/${file}.js`);
    if (file === "index") env.context.pf2eEliottTools.features.bestiary = { initialize: () => env.notifications.push("initialized") };
    env.scripts[index].onload();
    await flush();
  }
  assert.deepEqual(env.notifications, ["initialized"]);
  assert.deepEqual(env.errors, []);
});

test("a missing bestiary dependency stops its load chain and preserves other features", async () => {
  const env = setup({ loaded: true, bestiaryLoaded: false });
  env.emit("ready"); env.scripts[0].onerror(); await flush();
  assert.equal(env.scripts.length, 1);
  assert.match(env.notifications[0], /бестиарий/);
  env.emit("updateCombat", {}, { turn: 1 });
  assert.equal(env.trackerUpdates, 1);
});
