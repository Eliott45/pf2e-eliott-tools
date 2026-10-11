const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const featureSource = readFileSync(join(__dirname, "../scripts/features/template-targeting.js"), "utf8");
const contextSource = readFileSync(join(__dirname, "../scripts/module/context.js"), "utf8");

function setup({ isGM = false, blocked = [] } = {}) {
  const hooks = new Map();
  const settings = new Map();
  const region = { id: "r1", tokens: new Set(), getCoverage: () => ({ covered: [], blocked }) };
  const tokens = [];
  const canvas = { ready: true, grid: { sizeX: 100, sizeY: 100, getOffset: ({ x, y }) => ({ i: Math.floor(y / 100), j: Math.floor(x / 100) }) },
    tokens: { placeables: tokens } };
  const context = vm.createContext({
    canvas,
    CONST: { TOKEN_DISPLAY_MODES: { HOVER: 30, ALWAYS: 50 } },
    Hooks: { on: (name, fn) => hooks.set(name, fn) },
    document: { querySelectorAll: () => [], createElement: () => ({}), head: { append: () => {} } },
    foundry: { utils: { getRoute: (path) => path }, applications: { api: { ApplicationV2: class {} } } },
    game: { user: { id: "u1", isGM }, settings: { register: (_id, key, value) => settings.set(key, value), get: (_id, key) => settings.get(key)?.default } },
    console,
  });
  vm.runInContext(contextSource, context);
  vm.runInContext(featureSource, context);
  const feature = context.pf2eEliottTools.features.templateTargeting;

  function addToken(id, { alliance = "opposition", inside = true, hidden = false, visible = true, dead = false, x = 0, y = 0, displayName = 50, owner = false } = {}) {
    const actor = { alliance, isDead: dead, isOwner: owner, img: `${id}.webp`, isOfType: (...types) => types.includes("creature") };
    const doc = { id, name: id, x, y, width: 1, height: 1, hidden, displayName, isOwner: owner, texture: { src: `${id}.png` },
      testInsideRegion: (target) => target === region && inside };
    const token = { document: doc, actor, visible };
    tokens.push(token);
    return token;
  }

  return { feature, region, addToken, hooks, settings,
    collect: (selfToken = null, actor = { alliance: "party" }) => feature.collectCandidates({ region, actor, selfToken }) };
}

const ids = (rows) => [...rows.map((row) => row.id)];
const included = (feature, rows, options) => [...rows.filter((row) => feature.isIncluded(row, options)).map((row) => row.id)];

test("party caster: enemies, allies and all modes pick the matching tokens", () => {
  const env = setup();
  const self = env.addToken("caster", { alliance: "party" });
  env.addToken("goblin");
  env.addToken("friend", { alliance: "party" });
  env.addToken("cow", { alliance: null });
  const rows = env.collect(self);
  const base = { self: true, neutral: true };
  assert.deepEqual(included(env.feature, rows, { ...base, mode: "enemies" }), ["goblin"]);
  assert.deepEqual(included(env.feature, rows, { ...base, mode: "allies" }).sort(), ["caster", "friend"]);
  assert.deepEqual(included(env.feature, rows, { ...base, mode: "all" }).sort(), ["caster", "cow", "friend", "goblin"]);
  assert.deepEqual(included(env.feature, rows, { mode: "all", self: false, neutral: false }).sort(), ["friend", "goblin"]);
});

test("tokens outside the area are not listed; dead and wall-blocked ones are listed but not selected", () => {
  const env = setup({ blocked: [{ i: 0, j: 3 }] });
  env.addToken("far", { inside: false, x: 900 });
  env.addToken("behindWall", { inside: false, x: 300 });
  env.addToken("corpse", { dead: true });
  env.addToken("orc");
  const rows = env.collect();
  assert.deepEqual(ids(rows).sort(), ["behindWall", "corpse", "orc"]);
  assert.equal(rows.find((row) => row.id === "behindWall").blocked, true);
  assert.deepEqual(included(env.feature, rows, { mode: "all", self: true, neutral: true }), ["orc"]);
  assert.equal(rows.at(-1).id, "behindWall", "blocked rows go last");
});

test("players never see hidden or invisible tokens; the GM sees hidden ones unselected", () => {
  const player = setup();
  player.addToken("ambusher", { hidden: true });
  player.addToken("inDarkness", { visible: false });
  player.addToken("seen");
  assert.deepEqual(ids(player.collect()), ["seen"]);

  const gm = setup({ isGM: true });
  gm.addToken("ambusher", { hidden: true });
  const rows = gm.collect(null, null);
  assert.deepEqual(ids(rows), ["ambusher"]);
  assert.deepEqual(included(gm.feature, rows, { mode: "all", self: true, neutral: true }), []);
});

test("players see an anonymous name unless the token name is shown on hover", () => {
  const env = setup();
  env.addToken("Secret Lich", { displayName: 0 });
  env.addToken("Known Orc", { displayName: 30 });
  const names = [...env.collect().map((row) => row.name)].sort();
  assert.deepEqual(names, ["Known Orc", "Неизвестное существо"]);
});

test("GM without a caster actor treats party tokens as enemies", () => {
  const env = setup({ isGM: true });
  env.addToken("hero", { alliance: "party" });
  env.addToken("minion", { alliance: "opposition" });
  const rows = env.collect(null, null);
  assert.deepEqual(included(env.feature, rows, { mode: "enemies", self: true, neutral: true }), ["hero"]);
});

test("the client toggle and its hidden options are registered on init", () => {
  const env = setup();
  env.feature.onInit();
  assert.equal(env.settings.get("templateTargetingEnabled").scope, "client");
  assert.equal(env.settings.get("templateTargetingEnabled").default, true);
  assert.equal(env.settings.get("templateTargetingOptions").config, false);
  assert.ok(env.hooks.has("createRegion"));
});

function dialogSetup({ animations = false, sync = true } = {}) {
  const hooks = new Map();
  const targeted = [];
  const apps = [];
  const state = { closed: 0, regionDeletes: 0 };
  const scene = { regions: new Map() };
  const region = { id: "r1", parent: scene, isEffectArea: true, flags: { pf2e: { areaShape: "burst", origin: {} } },
    getCoverage: () => ({ covered: [], blocked: [] }), delete: async () => { state.regionDeletes++; scene.regions.delete("r1"); } };
  scene.regions.set(region.id, region);
  const ally = { document: { id: "ally", name: "Ally", x: 0, y: 0, width: 1, height: 1, isOwner: true, texture: { src: "a.png" }, testInsideRegion: () => true },
    actor: { alliance: "party", isOfType: () => true }, visible: true };
  const userTargets = new Set();
  const canvas = { ready: true, scene, grid: {}, mousePosition: null,
    tokens: { placeables: [ally], get: (id) => (id === "ally" ? ally : null),
      setTargets: (ids) => { targeted.push([...ids]); userTargets.clear(); for (const id of ids) userTargets.add(ally); } } };
  class ApplicationV2 {
    constructor(options) { this.options = options; apps.push(this); }
    render() { this.rendered = true; return this; }
    close() { state.closed++; this.rendered = false; return this; }
  }
  const context = vm.createContext({
    canvas, CONST: { TOKEN_DISPLAY_MODES: { HOVER: 30, ALWAYS: 50 } }, CONFIG: { PF2E: {} }, window: { innerWidth: 1600, innerHeight: 900 },
    Hooks: { on: (name, fn) => hooks.set(name, fn) }, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    document: { querySelectorAll: () => [], createElement: () => ({}), head: { append: () => {} } },
    foundry: { utils: { getRoute: (path) => path }, applications: { api: { ApplicationV2 } } },
    game: { user: { id: "u1", isGM: false, targets: userTargets }, keyboard: { isModifierActive: () => false }, messages: { get: () => null },
      modules: new Map(animations ? [["autoanimations", { active: true }]] : []),
      i18n: { has: () => false, localize: (key) => key },
      settings: { register: () => {}, set: async () => {},
        get: (_id, key) => (key === "templateTargetingOptions" ? {} : key === "templateTargetingAnimationSync" ? sync : true) } },
    console,
  });
  vm.runInContext(contextSource, context);
  vm.runInContext(featureSource, context);
  context.pf2eEliottTools.features.templateTargeting.onInit();
  hooks.get("createRegion")(region, {}, "u1");
  // What Automated Animations does in its own createRegion handler after the item lookup.
  const aaWorkflow = (animationData = { primary: { options: { removeTemplate: false } } }) => {
    const data = { isTemplate: true, templateData: region, targets: [], hitTargets: [] };
    hooks.get("AutomatedAnimations-WorkflowStart")(data, animationData);
    return data;
  };
  const aaSanitize = () => {
    const clone = { primary: { options: { removeTemplate: false } } };
    hooks.get("aa.preDataSanitize")({ templateData: region }, clone);
    return clone.primary.options.removeTemplate;
  };
  return { hooks, region, scene, ally, targeted, state, app: apps[0], aaWorkflow, aaSanitize };
}

const settledYet = async (promise) => {
  let done = false;
  promise.then(() => { done = true; });
  await new Promise(setImmediate);
  return done;
};

test("animation sync: AA waits for the dialog, then plays on the confirmed targets and removes the area itself", async () => {
  const env = dialogSetup({ animations: true });
  const data = env.aaWorkflow();
  assert.equal(data.deferrals.length, 1);
  assert.equal(await settledYet(Promise.all(data.deferrals)), false, "the animation is held while the dialog is open");
  assert.match(env.app.content(), /Анимация начнётся после подтверждения/);

  await env.app.confirm();
  await Promise.all(data.deferrals);
  assert.deepEqual(env.targeted, [["ally"]]);
  assert.deepEqual([...data.targets.map((token) => token.document.id)], ["ally"]);
  assert.deepEqual([...data.hitTargets.map((token) => token.document.id)], ["ally"]);
  assert.equal(env.aaSanitize(), true, "«Убрать шаблон» is passed to AA");
  assert.equal(env.state.regionDeletes, 0, "the area survives until AA's animation has played");
});

test("animation sync: cancelling still releases the animation and keeps the area", async () => {
  const env = dialogSetup({ animations: true });
  const data = env.aaWorkflow();
  await env.app.close();
  await Promise.all(data.deferrals);
  assert.equal(env.aaSanitize(), false);
  assert.equal(env.state.regionDeletes, 0);
  assert.deepEqual(env.targeted, []);
});

test("animation sync: a spell without an AA animation is removed by the dialog as before", async () => {
  const env = dialogSetup({ animations: true });
  const data = env.aaWorkflow(null);
  assert.equal(data.deferrals, undefined);
  await env.app.confirm();
  assert.equal(env.state.regionDeletes, 1);
});

test("without Automated Animations or with sync off nothing is deferred", async () => {
  for (const options of [{ animations: false }, { animations: true, sync: false }]) {
    const env = dialogSetup(options);
    const data = env.aaWorkflow();
    assert.equal(data.deferrals, undefined);
    await env.app.confirm();
    assert.equal(env.state.regionDeletes, 1);
  }
});

test("an animation module deleting the area does not close the dialog; targets still apply from the snapshot", async () => {
  const hooks = new Map();
  const targeted = [];
  let closed = 0;
  let regionDeletes = 0;
  const apps = [];
  const scene = { regions: new Map() };
  const region = { id: "r1", parent: scene, isEffectArea: true, flags: { pf2e: { areaShape: "burst", origin: {} } },
    getCoverage: () => ({ covered: [], blocked: [] }), delete: async () => { regionDeletes++; } };
  scene.regions.set(region.id, region);
  const ally = { document: { id: "ally", name: "Ally", x: 0, y: 0, width: 1, height: 1, isOwner: true, texture: { src: "a.png" }, testInsideRegion: () => true },
    actor: { alliance: "party", isOfType: () => true }, visible: true };
  const canvas = { ready: true, scene, grid: {}, mousePosition: null,
    tokens: { placeables: [ally], get: (id) => (id === "ally" ? ally : null), setTargets: (ids) => targeted.push([...ids]) } };
  class ApplicationV2 {
    constructor(options) { this.options = options; apps.push(this); }
    render() { this.rendered = true; return this; }
    close() { closed++; this.rendered = false; return this; }
  }
  const context = vm.createContext({
    canvas, CONST: { TOKEN_DISPLAY_MODES: { HOVER: 30, ALWAYS: 50 } }, CONFIG: { PF2E: {} }, window: { innerWidth: 1600, innerHeight: 900 },
    Hooks: { on: (name, fn) => hooks.set(name, fn) },
    document: { querySelectorAll: () => [], createElement: () => ({}), head: { append: () => {} } },
    foundry: { utils: { getRoute: (path) => path }, applications: { api: { ApplicationV2 } } },
    game: { user: { id: "u1", isGM: false }, keyboard: { isModifierActive: () => false }, messages: { get: () => null },
      i18n: { has: () => false, localize: (key) => key },
      settings: { register: () => {}, get: (_id, key) => (key === "templateTargetingOptions" ? {} : true), set: async () => {} } },
    console,
  });
  vm.runInContext(contextSource, context);
  vm.runInContext(featureSource, context);
  context.pf2eEliottTools.features.templateTargeting.onInit();

  hooks.get("createRegion")(region, {}, "u1");
  // Automated Animations "Remove Template" fires once the effect finishes.
  scene.regions.delete(region.id);
  hooks.get("deleteRegion")(region);
  assert.equal(closed, 0, "the dialog stays open");

  const [app] = apps;
  assert.equal(app.regionDeleted, true);
  assert.match(app.content(), /Шаблон уже убран анимацией/);
  hooks.get("updateRegion")(region);
  assert.deepEqual([...app.rows.map((row) => row.id)], ["ally"], "the snapshot is kept");

  await app.confirm();
  assert.deepEqual(targeted, [["ally"]]);
  assert.equal(regionDeletes, 0, "an already deleted area is not deleted again");
  assert.equal(closed, 1);
});
