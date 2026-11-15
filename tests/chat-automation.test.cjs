const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const moduleId = "pf2e-eliott-tools";
const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");
const getProperty = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);

function fakeElement(tag) {
  // PF2e stores IWR applications HTML-escaped; a textarea decodes them.
  if (tag === "textarea") return { innerHTML: "", get value() { return this.innerHTML.replace(/&quot;/g, '"'); } };
  return {
    classList: { add() {} }, children: [], textContent: "", innerHTML: "",
    append(...nodes) { this.children.push(...nodes); },
    get outerHTML() { return this.children.map((node) => node.textContent || node.innerHTML).join(""); },
    querySelector: () => null,
  };
}

function baseContext({ activeGM = "gm", userId = "gm", messageModes = true } = {}) {
  const users = { gm: { id: "gm", isGM: true, active: true }, player: { id: "player", isGM: false, active: true } };
  return {
    console: { error() {}, info() {}, warn() {} },
    document: { createElement: fakeElement, querySelector: () => null },
    foundry: { utils: { getProperty, deepClone: (value) => structuredClone(value) } },
    game: {
      user: users[userId],
      users: { activeGM: activeGM ? users[activeGM] : null },
      settings: { get: () => true },
      i18n: { lang: "en", localize: (key) => key },
      packs: { get: () => null },
    },
    CONFIG: { ChatMessage: messageModes ? { modes: { public: {}, gm: {}, blind: {}, self: {} } } : {}, Dice: { rolls: [] } },
    pf2eEliottTools: { module: { id: moduleId, logPrefix: "test", flagPath: `flags.${moduleId}.correction`,
      settings: { oathOfTheDefenderEnabled: "oathOfTheDefenderEnabled" } } },
  };
}

function shieldsSetup(options) {
  const context = baseContext(options);
  const rolls = [];
  const attacker = { uuid: "Actor.attacker", name: "Goblin" };
  const target = { uuid: "Actor.target", name: "Hero", itemTypes: { effect: [
    { slug: "spell-effect-shields-of-the-spirit", name: "Shields", uuid: "Item.effect", system: { level: { value: 3 } }, flags: {} },
  ] } };
  context.fromUuid = async (uuid) => ({ [attacker.uuid]: attacker, [target.uuid]: target })[uuid] ?? null;
  context.ChatMessage = { getSpeaker: () => ({}) };
  context.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate() { return this; }
    async toMessage(data, visibility) { rolls.push({ formula: this.formula, data, visibility }); }
  };
  vm.createContext(context);
  vm.runInContext(read("scripts/features/spells/shields-of-the-spirit.js"), context);
  const message = (contextData, extra = {}) => ({ uuid: "ChatMessage.attack", flags: { pf2e: { context: {
    type: "attack-roll", traits: ["attack"], origin: { actor: attacker.uuid }, target: { actor: target.uuid }, ...contextData,
  } } }, whisper: [], blind: false, ...extra });
  return { context, rolls, message, feature: context.pf2eEliottTools.features.spells.shieldsOfTheSpirit };
}

test("Shields of the Spirit: feature script declares no globals outside its scope", () => {
  const context = vm.createContext(baseContext());
  vm.runInContext(read("scripts/features/spells/shields-of-the-spirit.js"), context);
  // A top-level `let` would collide with any other script declaring the same name.
  assert.throws(() => vm.runInContext("spellUuidCache", context), { name: "ReferenceError" });
});

test("Shields of the Spirit retaliates once per attack, not for rerolls or damage receipts", async () => {
  const env = shieldsSetup();
  await env.feature.onCreateChatMessage(env.message({}));
  assert.equal(env.rolls.length, 1);
  // Rank 3 effect: ceil(3 / 2) = 2d4 spirit damage.
  assert.equal(env.rolls[0].formula, "2d4");

  await env.feature.onCreateChatMessage(env.message({ isReroll: true }));
  await env.feature.onCreateChatMessage(env.message({ type: "damage-taken" }));
  await env.feature.onCreateChatMessage(env.message({ type: "spell-cast" }));
  assert.equal(env.rolls.length, 1);
});

test("Shields of the Spirit mirrors a secret attack's audience instead of posting publicly", async () => {
  const blind = shieldsSetup();
  await blind.feature.onCreateChatMessage(blind.message({}, { blind: true, whisper: ["gm"] }));
  assert.deepEqual({ ...blind.rolls[0].visibility }, { messageMode: "blind" });

  const recorded = shieldsSetup();
  await recorded.feature.onCreateChatMessage(recorded.message({ messageMode: "gm" }));
  assert.deepEqual({ ...recorded.rolls[0].visibility }, { messageMode: "gm" });

  const legacy = shieldsSetup({ messageModes: false });
  await legacy.feature.onCreateChatMessage(legacy.message({}, { whisper: ["gm"] }));
  assert.deepEqual({ ...legacy.rolls[0].visibility }, { rollMode: "gmroll" });
});

test("Shields of the Spirit runs only on the active GM's client", async () => {
  const env = shieldsSetup({ userId: "player" });
  await env.feature.onCreateChatMessage(env.message({}));
  assert.equal(env.rolls.length, 0);
});

function oathSetup(options) {
  const context = vm.createContext(baseContext(options));
  vm.runInContext(read("scripts/features/champion/oath-of-the-defender.js"), context);
  const actorUpdates = [];
  const messageUpdates = [];
  const actor = { system: { attributes: { hp: { value: 30, temp: 0 } } },
    async update(change) { actorUpdates.push(change); } };
  const applications = [
    { category: "resistance", type: "damage from sworn creature kind", adjustment: -5 },
    { category: "resistance", type: "damage from sworn creature kind", adjustment: -3 },
  ];
  const message = {
    id: "damage", actor, author: { id: "player" },
    content: `<div class="iwr" data-applications="${JSON.stringify(applications).replace(/"/g, "&quot;")}"></div>`,
    flags: { pf2e: { context: { type: "damage-taken" },
      appliedDamage: { updates: [{ path: "system.attributes.hp.value", value: 2 }] } } },
    async update(change) { messageUpdates.push(change); },
  };
  return { feature: context.pf2eEliottTools.features.champion.oathOfTheDefender, message, actorUpdates, messageUpdates };
}

test("Oath of the Defender: only one client corrects a damage receipt", async () => {
  // Without this, the GM and the player who applied damage both dealt the missing damage.
  const player = oathSetup({ userId: "player" });
  await player.feature.onCreateChatMessage(player.message);
  assert.equal(player.actorUpdates.length, 0);
  assert.equal(player.messageUpdates.length, 0);

  const gm = oathSetup();
  await gm.feature.onCreateChatMessage(gm.message);
  // 5 + 3 resistance applied instead of the strongest 5: 3 more damage, 30 → 27.
  assert.deepEqual(JSON.parse(JSON.stringify(gm.actorUpdates)), [{ "system.attributes.hp.value": 27 }]);
  assert.equal(gm.messageUpdates.length, 1);
});

test("Oath of the Defender: without a GM, the damage author's client corrects it", async () => {
  const author = oathSetup({ activeGM: null, userId: "player" });
  await author.feature.onCreateChatMessage(author.message);
  assert.equal(author.actorUpdates.length, 1);

  const other = oathSetup({ activeGM: null, userId: "gm" });
  await other.feature.onCreateChatMessage(other.message);
  assert.equal(other.actorUpdates.length, 0);
});
