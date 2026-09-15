const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const command = readFileSync(join(__dirname, "../scripts/macros/drink-from-chalice.js"), "utf8");
const featureCode = readFileSync(join(__dirname, "../scripts/features/chalice.js"), "utf8");
const moduleId = "pf2e-eliott-tools";

function setup({ level = 9, ally = false, owned = true, adept = false, intensified = false,
  mode = "sip", temp = 0, negativeHealing = false, failMessage = false, assigned = false, activeGM = true } = {}) {
  let nextId = 0;
  const notices = [], errors = [], messages = [], created = [], requests = [], mutationUsers = [];
  const gm = { id: "gm", isGM: true }, player = { id: "player", isGM: false };
  const hooks = new Map();
  const makeActor = (uuid, actorLevel, isOwner) => ({
    uuid, documentName: "Actor", name: uuid, type: "character", level: actorLevel,
    get isOwner() { return game.user.isGM || isOwner; },
    testUserPermission(user) { return user.isGM || (user.id === player.id && isOwner); },
    system: { attributes: { hp: { temp: 0, negativeHealing } } },
    itemTypes: { effect: [] },
    async update(data) {
      assert.ok(this.isOwner, "only the actor owner can update HP");
      for (const [key, value] of Object.entries(data)) this.system.attributes.hp[key.split(".").at(-1)] = value;
    },
    async createEmbeddedDocuments(_type, data) {
      assert.ok(this.isOwner, "only the actor owner can create an effect");
      mutationUsers.push(game.user.id);
      return data.map((entry) => {
        const document = { ...entry, id: `effect${++nextId}`, slug: entry.system.slug,
          remainingDuration: { expired: false },
          update: async (changes) => {
            if (changes["system.start"]) document.system.start = changes["system.start"];
          },
          delete: async () => this.deleteEmbeddedDocuments("Item", [document.id]),
        };
        this.itemTypes.effect.push(document);
        created.push(document);
        const rule = entry.system.rules.find((r) => r.key === "TempHP");
        // Mirrors PF2e TempHP's onCreate/onDelete source ownership contract.
        if (rule && rule.value > this.system.attributes.hp.temp) {
          this.system.attributes.hp.temp = rule.value;
          this.system.attributes.hp.tempsource = document.id;
        }
        return document;
      });
    },
    async deleteEmbeddedDocuments(_type, ids) {
      assert.ok(this.isOwner, "only the actor owner can delete an effect");
      if (ids.includes(this.system.attributes.hp.tempsource)) {
        this.system.attributes.hp.temp = 0;
        delete this.system.attributes.hp.tempsource;
      }
      this.itemTypes.effect = this.itemTypes.effect.filter((e) => !ids.includes(e.id));
    },
  });
  const source = makeActor("Actor.Thaum", level, true);
  const recipient = ally ? makeActor("Actor.Ally", 2, owned) : source;
  recipient.system.attributes.hp.temp = temp;
  if (temp) recipient.system.attributes.hp.tempsource = "other-source";
  const token = { documentName: "Token", uuid: "Scene.Test.Token.Thaum", actor: source };
  const docs = new Map([[source.uuid, source], [recipient.uuid, recipient], [token.uuid, token]]);
  player.character = assigned ? source : null;
  player.targets = new Set(ally ? [{ actor: recipient }] : []);
  const game = { system: { id: "pf2e" }, time: { worldTime: 100 }, user: player,
    users: { activeGM: activeGM ? gm : null }, messages: new Map() };
  const selection = { adept, intensified, mode };
  const preview = { textContent: "" };
  let dialog, change;
  const context = {
    pf2eEliottTools: { module: { id: moduleId }, features: {} },
    fromUuid: async (uuid) => docs.get(uuid), setTimeout, clearTimeout,
    Hooks: {
      on: (event, fn) => { const list = hooks.get(event) ?? []; list.push(fn); hooks.set(event, list); return fn; },
      off: (event, fn) => hooks.set(event, hooks.get(event).filter((f) => f !== fn)),
    },
    game, canvas: { tokens: { controlled: assigned ? [] : [{ actor: source, document: { uuid: "Scene.Test.Token.Thaum" } }] } },
    ui: { notifications: Object.fromEntries(["warn", "info", "error"].map((key) => [key, (text) => notices.push(text)])) },
    console: { error: (...args) => errors.push(args) },
    CONFIG: { Dice: { rolls: [class DamageRoll {
      constructor(formula) { this.formula = formula; }
      async toMessage(data) { if (failMessage) throw new Error("message failed"); messages.push({ formula: this.formula, ...data }); }
    }] } },
    ChatMessage: { getSpeaker: ({ actor }) => ({ actor: actor.uuid }), create: async (data) => {
      const message = makeMessage(data.flags[moduleId].chaliceRequest);
      requests.push(message);
      game.messages.set(message.id, message);
      const current = game.user;
      game.user = gm;
      try { await context.pf2eEliottTools.features.chalice.onRequest(message); }
      finally { game.user = current; }
      return message;
    } },
    foundry: { applications: { api: { DialogV2: { wait: async (config) => {
      dialog = config;
      const form = { elements: { recipient: { value: recipient.uuid },
        adept: { checked: selection.adept }, intensified: { checked: selection.intensified } },
        addEventListener: (_event, fn) => { change = fn; }, querySelector: () => preview };
      config.render(null, { element: { querySelector: () => form } });
      change();
      if (selection.mode === "close") return null;
      return config.buttons.find((b) => b.action === selection.mode).callback(null, { form });
    } } } } },
  };
  vm.createContext(context);
  vm.runInContext(featureCode, context);
  function makeMessage(choice = {}, author = player) {
    return { id: `request${++nextId}`, author, timestamp: Date.now(),
      flags: { [moduleId]: { chaliceRequest: { source: source.uuid, recipient: recipient.uuid,
        token: assigned ? null : token.uuid, adept, intensified, ...choice, status: "pending" } } },
      async update(changes) { this.flags[moduleId].chaliceRequest = changes[`flags.${moduleId}.chaliceRequest`]; },
    };
  }
  return { source, recipient, selection, game, notices, errors, messages, created, preview,
    feature: context.pf2eEliottTools.features.chalice, requests, mutationUsers, hooks, gm, player, docs, makeMessage,
    get dialog() { return dialog; },
    run: () => vm.runInContext(`(async () => {${command}\n})()`, context),
  };
}

for (const [adept, intensified, expected] of [[false, false, 9], [true, false, 18], [false, true, 18], [true, true, 27]]) {
  test(`sip without combat: adept=${adept}, intensified=${intensified} grants ${expected}`, async () => {
    const env = setup({ adept, intensified });
    await env.run();
    assert.equal(env.recipient.system.attributes.hp.temp, expected);
    assert.equal(env.created[0].system.duration.expiry, "turn-end");
    assert.equal(env.created[0].system.context.origin.actor, env.source.uuid);
    assert.match(env.preview.textContent, new RegExp(`Глоток: ${expected} `));
    assert.deepEqual(env.errors, []);
  });
}

test("minimum sip is 3 and an assigned character works off-scene", async () => {
  const env = setup({ level: 1, assigned: true });
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 3);
  assert.equal(env.created[0].system.context.origin.token, null);
});

test("ally uses thaumaturge level, not recipient level", async () => {
  const env = setup({ ally: true, adept: true });
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 18);
  assert.equal(env.source.system.attributes.hp.temp, 0);
});

test("equal repeated sip refreshes source before deleting old effect", async () => {
  const env = setup({ adept: true });
  await env.run();
  const first = env.created[0].id;
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 18);
  assert.notEqual(env.recipient.system.attributes.hp.tempsource, first);
  assert.equal(env.recipient.itemTypes.effect.length, 1);
  env.recipient.system.attributes.hp.temp = 4;
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 18);
  assert.equal(env.recipient.itemTypes.effect.length, 1);
  await env.recipient.itemTypes.effect[0].delete();
  assert.equal(env.recipient.system.attributes.hp.temp, 0);
});

test("stronger external HP are retained, with their original source", async () => {
  const env = setup({ temp: 25, adept: true });
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 25);
  assert.equal(env.recipient.system.attributes.hp.tempsource, "other-source");
  assert.equal(env.created.length, 0);
});

test("switching from adept to basic sip does not reduce or prolong stronger HP", async () => {
  const env = setup({ adept: true });
  await env.run();
  const effect = env.created[0];
  env.selection.adept = false;
  env.game.time.worldTime = 102;
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 18);
  assert.equal(env.recipient.itemTypes.effect[0], effect);
  assert.equal(effect.system.start.value, 100);
});

for (const [adept, intensified, expected] of [[false, false, 27], [true, false, 45], [false, true, 45], [true, true, 63]]) {
  test(`drain: adept=${adept}, intensified=${intensified} heals ${expected}`, async () => {
    const env = setup({ mode: "drain", adept, intensified });
    await env.run();
    assert.equal(env.messages[0].formula, `{${expected}[healing,vitality]}`);
    assert.equal(env.source.itemTypes.effect[0].system.duration.value, 10);
    assert.equal(env.source.itemTypes.effect[0].system.duration.unit, "minutes");
    await env.run();
    assert.equal(env.messages.length, 1, "cannot drain again during cooldown");
  });
}

test("sip resets active drained cooldown; expired cooldown allows draining", async () => {
  const env = setup({ mode: "drain" });
  await env.run();
  const drained = env.source.itemTypes.effect[0];
  env.game.time.worldTime = 200;
  env.selection.mode = "sip";
  await env.run();
  assert.equal(drained.system.start.value, 200);
  drained.remainingDuration.expired = true;
  env.selection.mode = "drain";
  await env.run();
  assert.equal(env.messages.length, 2);
  assert.equal(env.source.itemTypes.effect.filter((e) => e.slug === "chalice-drained").length, 1);
});

test("void healing works without relying on undead trait", async () => {
  const env = setup({ mode: "drain", negativeHealing: true });
  await env.run();
  assert.equal(env.messages[0].formula, "{27[healing,void]}");
});

test("cancel and window close do not consume or apply anything", async () => {
  for (const mode of ["cancel", "close"]) {
    const env = setup({ mode });
    await env.run();
    assert.equal(env.created.length, 0);
    assert.equal(env.messages.length, 0);
    env.selection.mode = "sip";
    await env.run();
    assert.equal(env.created.length, 1, "dialog lock is released");
  }
});

test("without a connected GM the player cannot mutate an unowned ally", async () => {
  const env = setup({ ally: true, owned: false, activeGM: false });
  await env.run();
  assert.equal(env.created.length, 0);
  assert.equal(env.requests.length, 0);
  assert.match(env.notices[0], /подключённый мастер/);
});

test("player's sip on an unowned ally is applied by the GM and acknowledged", async () => {
  const env = setup({ ally: true, owned: false, adept: true, intensified: true });
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 27);
  assert.deepEqual(env.mutationUsers, ["gm"]);
  assert.equal(env.requests[0].flags[moduleId].chaliceRequest.status, "applied");
  assert.match(env.notices.at(-1), /27 временных ОЗ/);
  assert.deepEqual(env.errors, []);
  await env.run();
  assert.equal(env.recipient.itemTypes.effect.length, 1);
  assert.equal(env.recipient.system.attributes.hp.temp, 27);
});

test("delegated sip resets the drained timer even when stronger temporary HP are retained", async () => {
  const env = setup({ ally: true, owned: false, mode: "drain", temp: 30 });
  await env.run();
  env.game.time.worldTime = 200;
  env.selection.mode = "sip";
  await env.run();
  assert.equal(env.source.itemTypes.effect[0].system.start.value, 200);
  assert.equal(env.recipient.system.attributes.hp.temp, 30);
  assert.equal(env.recipient.itemTypes.effect.length, 0);
  assert.equal(env.requests[0].flags[moduleId].chaliceRequest.status, "applied");
});

test("GM rejects foreign source, invalid actor, forged origin, options and stale requests", async () => {
  for (const kind of ["source", "actor", "token", "options", "stale"]) {
    const env = setup({ ally: true, owned: false });
    env.game.user = env.gm;
    const message = env.makeMessage(kind === "source" ? { source: env.recipient.uuid }
      : kind === "actor" ? { recipient: "Item.invalid" }
        : kind === "token" ? { token: "Scene.Test.Token.missing" }
          : kind === "options" ? { adept: "true" } : {});
    if (kind === "stale") message.timestamp -= 31000;
    await env.feature.onRequest(message);
    assert.equal(message.flags[moduleId].chaliceRequest.status, "error", kind);
    assert.equal(env.created.length, 0, kind);
  }
});

test("request is processed only once by the active GM and ignores supplied HP/rules", async () => {
  const env = setup({ ally: true, owned: false });
  const message = env.makeMessage({ amount: 999, rules: [{ key: "TempHP", value: 999 }] });
  await env.feature.onRequest(message);
  env.game.user = { id: "another-gm", isGM: true };
  await env.feature.onRequest(message);
  assert.equal(env.created.length, 0);
  env.game.user = env.gm;
  await Promise.all([env.feature.onRequest(message), env.feature.onRequest(message)]);
  assert.equal(env.created.length, 1);
  assert.equal(env.recipient.system.attributes.hp.temp, 9);
});

test("synthetic actors resolve for unlinked target tokens", async () => {
  const env = setup({ ally: true, owned: false });
  env.recipient.uuid = "Scene.Test.Token.Ally.Actor.synthetic";
  env.docs.set(env.recipient.uuid, env.recipient);
  await env.run();
  assert.equal(env.recipient.system.attributes.hp.temp, 9);
  assert.deepEqual(env.errors, []);
});

test("chalice listener initialization is idempotent", () => {
  const env = setup();
  env.feature.initialize(); env.feature.initialize();
  assert.equal(env.hooks.get("createChatMessage").length, 1);
});

test("failed healing chat does not consume the chalice", async () => {
  const env = setup({ mode: "drain", failMessage: true });
  await env.run();
  assert.equal(env.source.itemTypes.effect.length, 0);
  assert.equal(env.errors.length, 1);
});

test("manifest exposes macro compendium to players in the module folder", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../module.json"), "utf8"));
  const pack = manifest.packs.find((p) => p.name === "thaumaturge-macros");
  assert.equal(pack.type, "Macro");
  assert.equal(pack.ownership.PLAYER, "OBSERVER");
  assert.ok(manifest.packFolders[0].packs.includes(pack.name));
});
