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
