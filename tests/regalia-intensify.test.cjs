const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const code = readFileSync(join(__dirname, "../scripts/features/regalia-intensify.js"), "utf8");
const moduleId = "pf2e-eliott-tools";

function setup() {
  const gm = { id: "gm", isGM: true }, player = { id: "player", isGM: false };
  const hooks = new Map(), docs = new Map(), notices = [], requests = [];
  let nextId = 0, dialog;
  const makeToken = (id, alliance, owners) => {
    const actor = { uuid: `Actor.${id}`, level: 9, type: "character", alliance, owners,
      itemTypes: { effect: [] }, rules: [],
      isAllyOf(other) { return this.alliance === other.alliance; },
      testUserPermission(user) { return user.isGM || owners.includes(user.id); },
      getFlag() { return null; },
      async createEmbeddedDocuments(_type, data) {
        return data.map((source) => {
          const effect = { ...source, id: `effect${++nextId}`, uuid: `${actor.uuid}.Item.effect${nextId}`,
            remainingDuration: { expired: false },
            async update(changes) {
              if (changes.name) this.name = changes.name;
              if (changes["system.rules"]) this.system.rules = changes["system.rules"];
              if (changes[`flags.${moduleId}.regaliaIntensify.bonus`]) this.flags[moduleId].regaliaIntensify.bonus = changes[`flags.${moduleId}.regaliaIntensify.bonus`];
            },
          };
          actor.itemTypes.effect.push(effect);
          return effect;
        });
      },
      async deleteEmbeddedDocuments(_type, ids) { this.itemTypes.effect = this.itemTypes.effect.filter((e) => !ids.includes(e.id)); },
    };
    const document = { id, uuid: `Scene.test.Token.${id}`, name: id, documentName: "Token", parent: { id: "test" }, actor };
    const token = { actor, document, name: id, isVisible: true };
    actor.getActiveTokens = () => [token];
    docs.set(document.uuid, document);
    return token;
  };
  const source = makeToken("thaum", "party", [player.id]);
  const ally = makeToken("ally", "party", []);
  const enemy = makeToken("enemy", "opposition", []);
  const otherEnemy = makeToken("otherEnemy", "opposition", []);
  const game = { user: gm, users: { activeGM: gm }, time: { worldTime: 100 }, system: { id: "pf2e" }, messages: new Map() };
  gm.targets = player.targets = new Set();
  for (const token of [source, ally, enemy, otherEnemy]) Object.defineProperty(token.actor, "isOwner", { get: () => token.actor.testUserPermission(game.user) });
  const context = vm.createContext({
    pf2eEliottTools: { module: { id: moduleId }, features: {} }, game,
    canvas: { scene: { id: "test" }, tokens: { controlled: [source], placeables: [source, ally, enemy, otherEnemy] } },
    fromUuid: async (uuid) => docs.get(uuid), console: { error() {} }, setTimeout, clearTimeout,
    ui: { notifications: Object.fromEntries(["info", "warn", "error"].map((k) => [k, (text) => notices.push(text)])) },
    Hooks: { on: (event, fn) => { const list = hooks.get(event) ?? []; list.push(fn); hooks.set(event, list); return fn; },
      off: (event, fn) => hooks.set(event, hooks.get(event).filter((f) => f !== fn)) },
    ChatMessage: { getSpeaker: () => ({}), create: async (data) => {
      requests.push(data);
      const message = makeMessage(data.flags[moduleId].regaliaRequest, player);
      game.messages.set(message.id, message);
      // A separate GM client processes the request while player keeps its local user.
      const user = game.user; game.user = gm;
      await feature.onRequest(message); game.user = user;
      return message;
    } },
    foundry: { applications: { api: { DialogV2: { wait: async (config) => {
      dialog = config;
      return config.buttons.find((b) => b.action === selection).callback(null, {
        form: { elements: { enemy: { value: enemy.document.uuid }, ally: { value: ally.document.uuid } } },
      });
    } } } } },
  });
  let selection = "hit";
  vm.runInContext(code, context);
  const feature = context.pf2eEliottTools.features.regaliaIntensify;
  const choice = (bonus = 1) => ({ source: source.document.uuid, ally: ally.document.uuid, enemy: enemy.document.uuid, bonus });
  function makeMessage(payload = choice(), author = player) {
    return { id: `message${++nextId}`, author, timestamp: Date.now(),
      flags: { [moduleId]: { regaliaRequest: { ...payload, status: "pending" } } },
      async update(changes) {
        this.content = changes.content;
        this.flags[moduleId].regaliaRequest = changes[`flags.${moduleId}.regaliaRequest`];
      },
    };
  }
  return { feature, context, game, gm, player, source, ally, enemy, otherEnemy, choice, makeMessage, hooks, notices, requests,
    get dialog() { return dialog; }, set selection(value) { selection = value; } };
}

test("hit/crit creates real targeted PF2e modifiers with source-turn expiry", async () => {
  for (const bonus of [1, 2]) {
    const e = setup(); await e.feature.apply(e.choice(bonus), e.gm);
    const effect = e.ally.actor.itemTypes.effect[0];
    assert.equal(effect.system.duration.expiry, "turn-start");
    assert.equal(effect.system.context.origin.actor, e.source.actor.uuid);
    const [mark, modifier] = effect.system.rules;
    assert.equal(mark.uuid, e.enemy.document.uuid);
    assert.equal(modifier.value, bonus);
    assert.equal(modifier.type, "circumstance");
    assert.equal(modifier.selector, "attack-roll");
    assert.equal(modifier.predicate[0], `target:mark:${mark.slug}`);
  }
});

test("repeated hits do not stack, and a later normal hit does not downgrade a crit", async () => {
  const e = setup();
  await Promise.all([e.feature.apply(e.choice(1), e.gm), e.feature.apply(e.choice(2), e.gm), e.feature.apply(e.choice(1), e.gm)]);
  assert.equal(e.ally.actor.itemTypes.effect.length, 1);
  assert.equal(e.ally.actor.itemTypes.effect[0].system.rules[1].value, 2);
});

test("different enemy tokens have separate target marks", async () => {
  const e = setup();
  await e.feature.apply(e.choice(1), e.gm);
  await e.feature.apply({ ...e.choice(2), enemy: e.otherEnemy.document.uuid }, e.gm);
  const effects = e.ally.actor.itemTypes.effect;
  assert.equal(effects.length, 2);
  assert.notEqual(effects[0].system.rules[0].slug, effects[1].system.rules[0].slug);
});

test("expired effect is replaced, not allowed to retain its larger bonus", async () => {
  const e = setup(); await e.feature.apply(e.choice(2), e.gm);
  e.ally.actor.itemTypes.effect[0].remainingDuration.expired = true;
  await e.feature.apply(e.choice(1), e.gm);
  assert.equal(e.ally.actor.itemTypes.effect.length, 1);
  assert.equal(e.ally.actor.itemTypes.effect[0].system.rules[1].value, 1);
});

test("GM applies a player's request to an unowned ally and acknowledges it", async () => {
  const e = setup(), message = e.makeMessage();
  assert.equal(e.ally.actor.testUserPermission(e.player), false);
  await e.feature.onRequest(message);
  assert.equal(e.ally.actor.itemTypes.effect.length, 1);
  assert.equal(message.flags[moduleId].regaliaRequest.status, "applied");
  await e.feature.onRequest(message);
  assert.equal(e.ally.actor.itemTypes.effect.length, 1);
});

test("request uses actual author permissions and rejects forged identity/bonus", async () => {
  const e = setup();
  for (const message of [e.makeMessage(e.choice(), { id: "outsider", isGM: false }), e.makeMessage(e.choice(99))]) {
    await e.feature.onRequest(message);
    assert.equal(message.flags[moduleId].regaliaRequest.status, "error");
  }
  assert.equal(e.ally.actor.itemTypes.effect.length, 0);
});

test("stale requests and a GM on a different scene fail visibly", async () => {
  const e = setup(), old = e.makeMessage(); old.timestamp -= 60000;
  await e.feature.onRequest(old);
  assert.equal(old.flags[moduleId].regaliaRequest.status, "error");
  e.context.canvas.scene.id = "elsewhere";
  const message = e.makeMessage(); await e.feature.onRequest(message);
  assert.equal(message.flags[moduleId].regaliaRequest.status, "error");
  assert.equal(e.ally.actor.itemTypes.effect.length, 0);
});

test("only active GM handles delegated requests", async () => {
  const e = setup(); e.game.user = { id: "secondGM", isGM: true };
  await e.feature.onRequest(e.makeMessage());
  assert.equal(e.ally.actor.itemTypes.effect.length, 0);
});

test("cannot give self a bonus, target an ally, or resolve arbitrary documents", async () => {
  const e = setup();
  for (const choice of [
    { ...e.choice(), ally: e.source.document.uuid },
    { ...e.choice(), enemy: e.ally.document.uuid },
    { ...e.choice(), source: "Actor.private" },
  ]) await assert.rejects(e.feature.apply(choice, e.gm));
});

test("targeted ally/enemy are preselected and cancel changes nothing", async () => {
  const e = setup(); e.gm.targets = new Set([e.ally, e.otherEnemy]); e.selection = "cancel";
  await e.feature.open();
  assert.ok(e.dialog.content.includes(`value="${e.ally.document.uuid}" selected`));
  assert.ok(e.dialog.content.includes(`value="${e.otherEnemy.document.uuid}" selected`));
  assert.equal(e.ally.actor.itemTypes.effect.length, 0);
});

test("player flow delegates, waits for acknowledgement, and reports success", async () => {
  const e = setup(); e.game.user = e.player;
  await e.feature.open();
  assert.equal(e.requests.length, 1);
  assert.equal(e.ally.actor.itemTypes.effect.length, 1);
  assert.match(e.notices.at(-1), /\+1 к атакам/);
});

test("without GM, unowned recipient produces a clear warning", async () => {
  const e = setup(); e.game.user = e.player; e.game.users.activeGM = null;
  await e.feature.open();
  assert.equal(e.requests.length, 0);
  assert.match(e.notices.at(-1), /подключённый мастер/);
});

test("initialize is idempotent", () => {
  const e = setup(); e.feature.initialize(); e.feature.initialize();
  assert.equal(e.hooks.get("createChatMessage").length, 1);
});
