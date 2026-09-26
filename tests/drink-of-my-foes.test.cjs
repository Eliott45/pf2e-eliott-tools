const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const moduleId = "pf2e-eliott-tools";
const spark = "divine-spark:barrows-edge";
const meta = (message, flag) => message.flags?.[moduleId]?.[flag];
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const delay = () => new Promise(setImmediate);
async function finished(request) {
  for (let i = 0; i < 100 && meta(request, "drinkFoesRequest").status === "pending"; i++) await delay();
  assert.notEqual(meta(request, "drinkFoesRequest").status, "pending");
  return request;
}
const put = (object, path, value) => {
  const keys = path.split(".");
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = structuredClone(value);
};
let nativeHealthDelta;
if (process.env.PF2E_DRINK_HEALTH_SOURCE) {
  nativeHealthDelta = vm.runInNewContext(readFileSync(process.env.PF2E_DRINK_HEALTH_SOURCE, "utf8"), {
    Math: Object.assign(Object.create(Math), { clamp: (n, min, max) => Math.min(max, Math.max(min, n)) }),
    game: { pf2e: { settings: { variants: { stamina: true } } } },
  });
}

function setup({ enabled = true, singleIkon = false } = {}) {
  const hooks = new Map();
  const messages = [];
  const actors = new Map();
  const items = new Map();
  const warnings = [];
  const errors = [];
  let sequence = 0;
  const gm = { id: "gm", isGM: true };
  const player = { id: "player", isGM: false };
  const stranger = { id: "stranger", isGM: false };
  const game = { user: gm, users: { activeGM: gm }, combat: { started: true, id: "combat", round: 1, turn: 0 },
    settings: { get: () => enabled }, i18n: { localize: (s) => s },
    messages: { contents: messages, get: (id) => messages.find((m) => m.id === id) } };
  const fire = (name, ...args) => { for (const fn of hooks.get(name) ?? []) fn(...args); };
  class Actor {
    constructor(id) {
      this.id = id; this.uuid = `Actor.${id}`;
      this.system = { attributes: { hp: { value: 40, max: 100, temp: 0 } } };
      this.items = [];
      this.rollOptions = { all: { [spark]: true } };
      this.token = { id: `token-${id}`, uuid: `Scene.scene.Token.${id}`, actor: this };
      this.synthetics = { toggles: { all: { "divine-spark": { enabled: true, itemId: "barrow", suboptions: [
        { value: "barrows-edge", label: "Barrow's Edge" },
        ...singleIkon ? [] : [{ value: "gleaming-blade", label: "Gleaming Blade" }],
      ] } } } };
      this.healCalls = []; this.shifts = [];
      actors.set(id, this);
    }
    get isOwner() { return this.testUserPermission(game.user); }
    testUserPermission(user) { return user.isGM || (user.id === "player" && this.id === "hero"); }
    getActiveTokens() { return [this.token]; }
    getSelfRollOptions() { return ["self:creature"]; }
    isImmuneTo() { return !!this.immune; }
    calculateHealthDelta({ hp, delta }) {
      if (nativeHealthDelta) return nativeHealthDelta.call(this, { hp, delta });
      if (!hp.max) return { updates: {}, totalApplied: 0 };
      const temp = delta > 0 ? Math.min(hp.temp, delta) : 0;
      return { totalApplied: delta, updates: { "system.attributes.hp.temp": hp.temp - temp,
        "system.attributes.hp.value": Math.max(0, Math.min(hp.max, hp.value - (delta - temp))) } };
    }
    async applyDamage(params) {
      if (this.failDamage) throw new Error("damage failed");
      let total = typeof params.damage === "number" ? params.damage : params.damage.afterIWR - (params.damage.shield ?? 0);
      if (total < 0) {
        this.healCalls.push(params);
        if (this.failHeal) throw new Error("heal failed");
        total -= this.healBonus ?? 0;
      }
      const result = this.calculateHealthDelta({ hp: this.system.attributes.hp, delta: total });
      await Promise.resolve();
      for (const [key, value] of Object.entries(result.updates)) put(this, key, value);
      await ChatMessage.create({ speaker: { actor: this.id },
        whisper: this.id === "hero" ? [] : [gm.id],
        flags: { pf2e: { origin: { uuid: params.item?.uuid },
          appliedDamage: { uuid: this.uuid, isHealing: total < 0 },
          context: { type: "damage-taken", options: Array.from(params.rollOptions ?? []) } } },
      });
      return this;
    }
    async toggleRollOption(...args) {
      this.shifts.push(args);
      if (this.failShift) return null;
      const [, , , value, suboption] = args;
      delete this.rollOptions.all[spark];
      if (value) this.rollOptions.all[`divine-spark:${suboption}`] = true;
      return value;
    }
  }
  class Character extends Actor {}
  class Message {
    constructor(data) {
      Object.assign(this, data);
      this.id = `message-${++sequence}`;
      this.timestamp = Date.now() + sequence;
      this.author = game.user;
      this.flags ??= {};
      this.actor = actors.get(data.speaker?.actor);
      this.token = this.actor?.token;
      this.item = items.get(this.flags.pf2e?.origin?.uuid);
    }
    updateSource(data) { for (const [key, value] of Object.entries(data)) put(this, key, value); }
    async update(data) { this.updateSource(data); }
  }
  const ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }),
    async create(data) {
      const message = new Message(data);
      fire("preCreateChatMessage", message);
      messages.push(message);
      fire("createChatMessage", message);
      return message;
    },
  };
  const dialogCalls = [];
  let cancel = false;
  const context = vm.createContext({
    CONFIG: { PF2E: { Actor: { documentClasses: { character: Character } } } },
    game, ChatMessage, console: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
    Hooks: { on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); } },
    foundry: { utils: { escapeHTML, randomID: () => `key${++sequence}` }, applications: { api: { DialogV2: {
      wait: async (data) => { dialogCalls.push(data); return cancel ? null : { ikon: singleIkon ? "" : "gleaming-blade" }; },
    } } } },
    ui: { notifications: { warn: (s) => warnings.push(s), error: (s) => errors.push(s) } },
    document: { createElement: () => ({ addEventListener(name, fn) { this[name] = fn; } }) },
  });
  for (const path of ["scripts/module/context.js", "scripts/features/drink-of-my-foes.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "..", path), "utf8"), context);
  }
  context.pf2eEliottTools.features.drinkOfMyFoes.onInit();
  const hero = new Character("hero"), enemy = new Actor("enemy");
  const action = { type: "action", slug: "drink-of-my-foes", uuid: "Actor.hero.Item.drink", actor: hero,
    system: { actionType: { value: "action" } }, getRollOptions: () => ["item:trait:healing", "item:trait:vitality"] };
  const weapon = { type: "weapon", uuid: "Actor.hero.Item.weapon", actor: hero,
    system: { traits: { otherTags: ["physical-ikon:barrows-edge"] } } };
  hero.items.push(action, weapon); items.set(action.uuid, action); items.set(weapon.uuid, weapon);
  if (singleIkon) hero.items.push({ type: "feat", slug: "exemplar-dedication" });
  async function roll({ outcome = "success", owner = player, sourceType = "attack" } = {}) {
    game.user = owner;
    return ChatMessage.create({ speaker: { actor: hero.id }, flags: { pf2e: { origin: { uuid: weapon.uuid },
      context: { type: "damage-roll", sourceType, outcome, options: [spark] } } } });
  }
  async function apply(source, afterIWR = 31, { shield = 0, target = enemy } = {}) {
    game.user = gm;
    await target.applyDamage({ damage: { afterIWR, shield }, token: target.token, item: weapon,
      outcome: source.flags.pf2e.context.outcome, rollOptions: new Set(source.flags.pf2e.context.options) });
    return messages.findLast((m) => meta(m, "drinkFoesDamage"));
  }
  async function request(source, { owner = player, ikon = singleIkon ? "" : "gleaming-blade" } = {}) {
    // Simulate the server-authored player request arriving on the active GM client.
    game.user = owner;
    const message = new Message({ speaker: { actor: hero.id }, whisper: [owner.id, gm.id],
      flags: { [moduleId]: { drinkFoesRequest: { source: source.id, ikon, status: "pending" } } } });
    messages.push(message);
    game.user = gm;
    fire("createChatMessage", message);
    return finished(message);
  }
  function render(source) {
    const root = { button: null, querySelector(selector) { return selector === ".eliott-drink-foes" ? this.button : this; },
      append(button) { this.button = button; } };
    fire("renderChatMessageHTML", source, root);
    fire("renderChatMessage", source, root);
    return root.button;
  }
  return { game, gm, player, stranger, hero, enemy, action, weapon, messages, roll, apply, request, render, fire, ChatMessage,
    warnings, errors, dialogCalls, context, cancel: () => { cancel = true; }, setEnabled: (value) => { enabled = value; } };
}

test("player roll is linked to hidden GM-applied damage, not the visible dice total", async () => {
  const env = setup();
  const source = await env.roll();
  const record = await env.apply(source, 31, { shield: 6 });
  assert.deepEqual(record.whisper, ["gm"]);
  assert.equal(meta(record, "drinkFoesDamage").damage, 25);
  assert.equal(meta(source, "drinkFoesDamage"), undefined);
  const reply = await env.request(source);
  assert.equal(meta(reply, "drinkFoesRequest").status, "applied");
  assert.equal(env.hero.system.attributes.hp.value, 52);
  assert.equal(env.hero.healCalls[0].damage, -12);
  assert.deepEqual(env.hero.shifts[0], ["all", "divine-spark", "barrow", true, "gleaming-blade"]);
  assert.ok(!reply.content.includes("25"), "response contains healing, not target damage or HP");
  assert.equal(meta(record, "drinkFoesDamage").state, "used");
});

test("temporary HP and overkill are damage dealt; healing rounds down and respects maximum HP", async () => {
  const env = setup();
  env.enemy.system.attributes.hp = { value: 3, max: 100, temp: 4 };
  env.hero.system.attributes.hp.value = 95;
  const source = await env.roll({ outcome: "criticalSuccess" });
  const record = await env.apply(source, 31);
  assert.equal(meta(record, "drinkFoesDamage").damage, 31);
  await env.request(source);
  assert.equal(env.hero.healCalls[0].damage, -15);
  assert.equal(env.hero.system.attributes.hp.value, 100);
});

test("native healing-received modifiers are retained", async () => {
  const env = setup(); env.hero.healBonus = 2;
  const source = await env.roll(); await env.apply(source, 20); await env.request(source);
  assert.equal(env.hero.system.attributes.hp.value, 52);
  assert.equal(env.hero.healCalls[0].skipIWR, true);
  assert.ok(env.hero.healCalls[0].rollOptions.has("item:trait:vitality"));
});

test("100 final damage against 1 remaining HP supplies 50 healing, not zero", async () => {
  const env = setup();
  env.enemy.system.attributes.hp = { value: 1, max: 100, temp: 0 };
  env.hero.system.attributes.hp.value = 10;
  const source = await env.roll();
  const record = await env.apply(source, 100);
  assert.equal(env.enemy.system.attributes.hp.value, 0);
  assert.equal(meta(record, "drinkFoesDamage").damage, 100);
  await env.request(source);
  assert.equal(env.hero.healCalls[0].damage, -50);
  assert.equal(env.hero.system.attributes.hp.value, 60);
});

test("no damage applied yet means no healing and no spark change", async () => {
  const env = setup(); const source = await env.roll();
  const reply = await env.request(source);
  assert.equal(meta(reply, "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 0); assert.equal(env.hero.shifts.length, 0);
  await env.apply(source, 20);
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "applied");
});

test("concurrent requests and repeated clicks cannot heal twice", async () => {
  const env = setup(); const source = await env.roll(); await env.apply(source);
  await Promise.all([env.request(source), env.request(source)]);
  assert.equal(env.hero.healCalls.length, 1);
  env.hero.rollOptions.all[spark] = true;
  await env.request(source);
  assert.equal(env.hero.healCalls.length, 1);
});

test("reverted applications cannot supply healing and ambiguous repeated applications are rejected", async () => {
  const env = setup(); const source = await env.roll();
  const first = await env.apply(source);
  first.flags.pf2e.appliedDamage.isReverted = true;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  const second = await env.apply(source);
  await env.apply(source);
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  second.flags.pf2e.appliedDamage.isReverted = true;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "applied");
});

test("single-ikon dedication returns the spark to the soul", async () => {
  const env = setup({ singleIkon: true }); const source = await env.roll(); await env.apply(source);
  await env.request(source);
  assert.deepEqual(env.hero.shifts[0], ["all", "divine-spark", "barrow", false, "barrows-edge"]);
  assert.equal(env.hero.rollOptions.all[spark], undefined);
});

test("zero damage causes no healing but can still spend the transcendence action", async () => {
  const env = setup(); const source = await env.roll(); await env.apply(source, 0);
  const reply = await env.request(source);
  assert.equal(meta(reply, "drinkFoesRequest").status, "applied");
  assert.equal(env.hero.healCalls.length, 0); assert.equal(env.hero.shifts.length, 1);
});

test("missing spark/action, changed turn, vitality immunity, and invalid choices block use", async () => {
  for (const change of [e => { delete e.hero.rollOptions.all[spark]; }, e => { e.hero.items = [e.weapon]; },
    e => { e.game.combat.turn++; }, e => { e.hero.system.attributes.hp.negativeHealing = true; },
    e => { e.hero.immune = true; }, e => { e.hero.modeOfBeing = "undead"; }]) {
    const env = setup(); const source = await env.roll(); await env.apply(source); change(env);
    assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
    assert.equal(env.hero.healCalls.length, 0);
  }
  const env = setup(); const source = await env.roll(); await env.apply(source);
  assert.equal(meta(await env.request(source, { ikon: "barrows-edge" }), "drinkFoesRequest").status, "error");
});

test("logged later actions invalidate an older strike", async () => {
  const env = setup(); const source = await env.roll(); await env.apply(source);
  env.messages.push({ id: "later", timestamp: Date.now() + 100, actor: env.hero, isCheckRoll: true, flags: {} });
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 0);
});

test("the requester must own the attacker and the damage record must be GM-authored", async () => {
  const env = setup(); const source = await env.roll(); const record = await env.apply(source);
  assert.equal(meta(await env.request(source, { owner: env.stranger }), "drinkFoesRequest").status, "error");
  record.author = env.player;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 0);
});

test("partial failure claims the strike durably and prevents a second healing attempt", async () => {
  for (const failure of ["failHeal", "failShift"]) {
    const env = setup(); const source = await env.roll(); const record = await env.apply(source);
    env.hero[failure] = true;
    assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
    assert.ok(["claimed", "healed"].includes(meta(record, "drinkFoesDamage").state));
    env.hero[failure] = false;
    await env.request(source);
    assert.equal(env.hero.healCalls.length, 1);
  }
});

test("unsuccessful attacks, unrelated weapons and spell damage do not gain buttons", async () => {
  const env = setup();
  for (const options of [{ outcome: "failure" }, { sourceType: "spell" }]) {
    const source = await env.roll(options);
    assert.equal(meta(source, "drinkFoesRoll"), undefined); assert.equal(env.render(source), null);
  }
  env.weapon.system.traits.otherTags = [];
  assert.equal(meta(await env.roll(), "drinkFoesRoll"), undefined);
});

test("the player gets a button on their visible damage roll without seeing the hidden result", async () => {
  const env = setup(); const source = await env.roll(); await env.apply(source);
  env.game.user = env.player;
  const button = env.render(source);
  assert.equal(button.textContent, "◆ Drink of my Foes");
  button.click({ preventDefault() {}, stopPropagation() {} });
  await delay(); await delay();
  const request = env.messages.findLast(m => meta(m, "drinkFoesRequest"));
  assert.ok(request); assert.deepEqual(Array.from(request.whisper), ["player", "gm"]);
  assert.deepEqual(Object.keys(meta(request, "drinkFoesRequest")).sort(), ["ikon", "source", "status"]);
  assert.equal(env.hero.healCalls.length, 0, "the player never calculates or applies hidden damage locally");
  env.game.user = env.gm; env.fire("createChatMessage", request); await finished(request);
  assert.equal(env.hero.healCalls.length, 1);
});

test("cancel, absent GM and non-owner clients cannot trigger healing", async () => {
  const env = setup(); const source = await env.roll(); env.cancel();
  const button = env.render(source);
  button.click({ preventDefault() {}, stopPropagation() {} }); await delay();
  assert.equal(env.messages.filter(m => meta(m, "drinkFoesRequest")).length, 0);
  env.game.users.activeGM = null;
  button.click({ preventDefault() {}, stopPropagation() {} }); await delay();
  assert.ok(env.warnings.length > 0);
  env.game.user = env.stranger; assert.equal(env.render(source), null);
});

test("simultaneous applications to the same actor keep their own final damage totals", async () => {
  const env = setup(); const first = await env.roll(), second = await env.roll();
  await Promise.all([env.apply(first, 13), env.apply(second, 27)]);
  const records = env.messages.filter(m => meta(m, "drinkFoesDamage")).map(m => meta(m, "drinkFoesDamage"));
  assert.deepEqual(records.map(r => r.damage), [13, 27]);
  assert.equal(records[0].rollKey, meta(first, "drinkFoesRoll").key);
  assert.equal(records[1].rollKey, meta(second, "drinkFoesRoll").key);
});

test("disabled automation and repeated initialization preserve native behavior", async () => {
  const env = setup({ enabled: false }); const source = await env.roll();
  assert.equal(meta(source, "drinkFoesRoll"), undefined);
  env.context.pf2eEliottTools.features.drinkOfMyFoes.onInit();
  env.setEnabled(true);
  const enabledRoll = await env.roll(); await env.apply(enabledRoll); await env.request(enabledRoll);
  assert.equal(env.hero.healCalls.length, 1);
});

test("saving throws, flat checks and declaring Drink of my Foes do not invalidate the Strike", async () => {
  for (const later of [
    { isCheckRoll: true, flags: { pf2e: { context: { type: "saving-throw" } } } },
    { isCheckRoll: true, flags: { pf2e: { context: { type: "flat-check" } } } },
    { item: { type: "action", slug: "drink-of-my-foes", system: { actionType: { value: "action" } } } },
  ]) {
    const env = setup(); const source = await env.roll(); await env.apply(source);
    env.messages.push({ id: "later", timestamp: source.timestamp + 1, actor: env.hero, ...later });
    assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "applied");
  }
});

test("subsequent attacks, skill checks and action cards block an older Strike", async () => {
  for (const later of [
    { isCheckRoll: true, flags: { pf2e: { context: { type: "attack-roll" } } } },
    { isCheckRoll: true, flags: { pf2e: { context: { type: "skill-check" } } } },
    { item: { type: "action", slug: "stride", system: { actionType: { value: "action" } } } },
  ]) {
    const env = setup(); const source = await env.roll(); await env.apply(source);
    env.messages.push({ id: "later", timestamp: source.timestamp + 1, actor: env.hero, ...later });
    assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
    assert.equal(env.hero.healCalls.length, 0);
  }
});

test("deleting a used damage receipt and applying damage again cannot heal from the same Strike", async () => {
  const env = setup(); const source = await env.roll(); const record = await env.apply(source);
  await env.request(source);
  assert.equal(meta(source, "drinkFoesRoll").state, "used");
  env.messages.splice(env.messages.indexOf(record), 1);
  env.hero.rollOptions.all[spark] = true;
  await env.apply(source);
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 1);
  assert.equal(env.render(source).disabled, true);
});

test("source claim prevents retries even if the damage receipt update fails", async () => {
  const env = setup(); const source = await env.roll(); const record = await env.apply(source);
  const update = record.update;
  record.update = async () => { throw new Error("receipt update failed"); };
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(meta(source, "drinkFoesRoll").state, "claimed");
  record.update = update;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 0);
  assert.equal(env.hero.shifts.length, 0);
});

test("damage must be applied to the recorded actor and token, when the roll has a target", async () => {
  for (const target of [
    { actor: "Actor.other", token: "Scene.scene.Token.other" },
    { actor: "Actor.enemy", token: "Scene.scene.Token.other" },
    { actor: "Actor.enemy", token: "Scene.scene.Token.enemy" },
  ]) {
    const env = setup(); const source = await env.roll();
    source.flags.pf2e.context.target = target;
    await env.apply(source);
    const correct = target.token === env.enemy.token.uuid;
    assert.equal(meta(await env.request(source), "drinkFoesRequest").status, correct ? "applied" : "error");
    assert.equal(env.hero.healCalls.length, correct ? 1 : 0);
  }
});

test("a receipt from another turn cannot be used by returning the tracker to the roll's turn", async () => {
  const env = setup(); const source = await env.roll();
  env.game.combat.turn = 1; await env.apply(source); env.game.combat.turn = 0;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 0);
});

test("only Exemplar Dedication can return a single ikon's spark to the soul", async () => {
  const env = setup({ singleIkon: true });
  env.hero.items = env.hero.items.filter((item) => item.slug !== "exemplar-dedication");
  const source = await env.roll(); await env.apply(source);
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  assert.equal(env.hero.healCalls.length, 0);
});

test("translated dedication uses the source UUID, and unavailable spark toggles reject requests", async () => {
  const env = setup({ singleIkon: true });
  const dedication = env.hero.items.find((item) => item.slug === "exemplar-dedication");
  dedication.slug = "translated"; dedication.sourceId = "Compendium.pf2e.feats-srd.Item.qvWmW5JWpVBDyGqe";
  const source = await env.roll(); await env.apply(source);
  const toggle = env.hero.synthetics.toggles.all["divine-spark"];
  toggle.enabled = false;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "error");
  toggle.enabled = true;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "applied");
});

test("native zero-damage receipts without appliedDamage can still complete transcendence", async () => {
  const env = setup(); const source = await env.roll(); const record = await env.apply(source, 0);
  record.flags.pf2e.appliedDamage = null;
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "applied");
  assert.equal(env.hero.healCalls.length, 0);
  assert.equal(env.hero.shifts.length, 1);
});

test("a failed damage operation releases its queue so the next application can be tracked", async () => {
  const env = setup(); const source = await env.roll(); env.enemy.failDamage = true;
  await assert.rejects(env.apply(source), /damage failed/);
  env.enemy.failDamage = false;
  await env.apply(source, 20);
  assert.equal(meta(await env.request(source), "drinkFoesRequest").status, "applied");
  assert.equal(env.hero.healCalls[0].damage, -10);
});
