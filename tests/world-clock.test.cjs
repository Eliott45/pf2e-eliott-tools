const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../scripts/features/world-clock.js"), "utf8");

function setup({ isGM = true, activeGM = "gm", running = false, enabled = true } = {}) {
  const hooks = new Map();
  const timers = new Map();
  const advances = [];
  const errors = [];
  let now = 0;
  let nextTimer = 0;
  const registrations = new Map();
  const values = new Map([["worldClockRunning", running], ["worldClockEnabled", enabled]]);
  const game = {
    ready: false,
    paused: false,
    user: { id: isGM ? "gm" : "player", isGM },
    users: { activeGM: activeGM ? { id: activeGM } : null },
    combats: [],
    pf2e: {},
    time: { advance: async (seconds) => advances.push(seconds) },
    settings: {
      register: (_module, key, options) => { registrations.set(key, options); },
      get: (_module, key) => values.get(key),
      set: async (_module, key, value) => {
        values.set(key, value);
        registrations.get(key).onChange(value);
      },
    },
  };
  const context = vm.createContext({
    game,
    pf2eEliottTools: { module: {
      id: "test", logPrefix: "test", settings: { worldClockEnabled: "worldClockEnabled" },
    } },
    Hooks: {
      on: (name, callback) => {
        const listeners = hooks.get(name) ?? [];
        listeners.push(callback);
        hooks.set(name, listeners);
      },
    },
    performance: { now: () => now },
    setInterval: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    HTMLElement: class {},
    console: { error: () => {} },
    ui: { notifications: { error: (message) => errors.push(message) } },
  });
  vm.runInContext(source, context);
  const feature = context.pf2eEliottTools.features.worldClock;
  feature.onInit();
  game.ready = true;
  feature.onReady();

  return {
    game, timers, advances, errors,
    get running() { return values.get("worldClockRunning"); },
    enable: (value) => game.settings.set("test", "worldClockEnabled", value),
    context,
    start: () => game.settings.set("test", "worldClockRunning", true),
    stop: () => game.settings.set("test", "worldClockRunning", false),
    emit: (name) => hooks.get(name)?.forEach((callback) => callback()),
    elapse: async (milliseconds) => {
      now += milliseconds;
      [...timers.values()].forEach((callback) => callback());
      await new Promise(setImmediate);
    },
  };
}

test("starts stopped; play advances one second per second and stop cancels it", async () => {
  const clock = setup();
  assert.equal(clock.timers.size, 0);
  await clock.start();
  await clock.elapse(1000);
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, [1, 1]);
  await clock.stop();
  await clock.elapse(5000);
  assert.deepEqual(clock.advances, [1, 1]);
  assert.equal(clock.timers.size, 0);
});

test("disabling a running clock cancels its timer; enabling skips disabled time", async () => {
  const clock = setup({ running: true });
  await clock.elapse(1000);
  await clock.enable(false);
  assert.equal(clock.timers.size, 0);
  clock.emit("updateCombat");
  clock.emit("userConnected");
  await clock.elapse(60000);
  assert.deepEqual(clock.advances, [1]);
  await clock.enable(true);
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, [1, 1]);
  assert.equal(clock.timers.size, 1);
});

test("disabled feature stays idle on reload despite a saved running state", async () => {
  const clock = setup({ running: true, enabled: false });
  clock.emit("pauseGame");
  clock.emit("updateUser");
  await clock.elapse(60000);
  assert.deepEqual(clock.advances, []);
  assert.equal(clock.timers.size, 0);
});

test("enabling the feature does not start a clock that was stopped", async () => {
  const clock = setup({ enabled: false });
  await clock.enable(true);
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, []);
  assert.equal(clock.timers.size, 0);
});

test("disabling removes the controls from an already open clock", async () => {
  const clock = setup();
  let removed = false;
  const root = new clock.context.HTMLElement();
  root.querySelector = () => ({ remove: () => { removed = true; } });
  clock.game.pf2e.worldClock = { element: root };
  await clock.enable(false);
  assert.equal(removed, true);
});

test("players and secondary GMs never advance shared time", async () => {
  for (const options of [{ isGM: false }, { activeGM: "other-gm" }, { activeGM: null }]) {
    const clock = setup({ ...options, running: true });
    await clock.elapse(3000);
    assert.deepEqual(clock.advances, []);
    assert.equal(clock.timers.size, 0);
  }
});

test("delayed callbacks retain fractional seconds without clock drift", async () => {
  const clock = setup({ running: true });
  await clock.elapse(1500);
  await clock.elapse(1500);
  await clock.elapse(2500);
  await clock.elapse(500);
  assert.deepEqual(clock.advances, [1, 2, 2, 1]);
});

test("game pause resumes without adding time spent paused", async () => {
  const clock = setup({ running: true });
  await clock.elapse(1000);
  clock.game.paused = true;
  clock.emit("pauseGame");
  await clock.elapse(60000);
  assert.equal(clock.running, true);
  clock.game.paused = false;
  clock.emit("pauseGame");
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, [1, 1]);
});

test("combat suspends real-time ticks until the last started combat ends", async () => {
  const clock = setup({ running: true });
  clock.game.combats.push({ started: true }, { started: true });
  clock.emit("updateCombat");
  await clock.elapse(60000);
  clock.game.combats.pop();
  clock.emit("deleteCombat");
  assert.equal(clock.timers.size, 0);
  clock.game.combats[0].started = false;
  clock.emit("updateCombat");
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, [1]);
});

test("GM handover does not replay inactive time or duplicate timers", async () => {
  const clock = setup({ running: true });
  clock.emit("updateUser");
  clock.emit("userConnected");
  assert.equal(clock.timers.size, 1);
  await clock.elapse(1000);
  clock.game.users.activeGM = { id: "other-gm" };
  clock.emit("userConnected");
  await clock.elapse(60000);
  clock.game.users.activeGM = clock.game.user;
  clock.emit("userConnected");
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, [1, 1]);
});

test("each tick rechecks GM authority even before connection hooks arrive", async () => {
  const clock = setup({ running: true });
  clock.game.users.activeGM = { id: "other-gm" };
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, []);
  assert.equal(clock.timers.size, 0);
});

test("slow world-time writes never overlap", async () => {
  const clock = setup({ running: true });
  let finish;
  clock.game.time.advance = (seconds) => {
    clock.advances.push(seconds);
    return new Promise((resolve) => { finish = resolve; });
  };
  await clock.elapse(1000);
  await clock.elapse(2000);
  assert.deepEqual(clock.advances, [1]);
  finish();
  await new Promise(setImmediate);
  await clock.elapse(1000);
  assert.deepEqual(clock.advances, [1, 3]);
  finish();
});

test("advance failure stops the clock and notifies the GM", async () => {
  const clock = setup({ running: true });
  clock.game.time.advance = async () => { throw new Error("Disconnected"); };
  await clock.elapse(1000);
  assert.equal(clock.running, false);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.errors.length, 1);
});

test("an old failed write cannot stop a newly started clock", async () => {
  const clock = setup({ running: true });
  let fail;
  clock.game.time.advance = () => new Promise((_resolve, reject) => { fail = reject; });
  await clock.elapse(1000);
  await clock.stop();
  await clock.start();
  fail(new Error("Late failure"));
  await clock.elapse(0);
  assert.equal(clock.running, true);
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.errors.length, 0);
});
