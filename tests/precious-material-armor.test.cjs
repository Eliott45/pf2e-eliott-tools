const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const moduleId = "pf2e-eliott-tools";
const source = readFileSync(join(__dirname, "../scripts/features/precious-material-armor.js"), "utf8");
const contextSource = readFileSync(join(__dirname, "../scripts/module/context.js"), "utf8");

function setup({ material = "cold-iron", weakness = "cold-iron", sickened = 0, immune = false } = {}) {
  const notifications = [];
  const chats = [];
  const errors = [];
  const changes = [];
  const resolutions = [];
  const documents = new Map();
  const armor = {
    uuid: "Actor.target.Item.armor",
    isOfType: (...types) => types.includes("armor"),
    isEquipped: true,
    system: { material: { type: material, grade: "low" } },
  };
  const target = {
    uuid: "Actor.target",
    name: "Defender",
    isOfType: (...types) => types.includes("creature"),
    wornArmor: armor,
  };
  const attacker = {
    uuid: "Actor.attacker",
    name: "Attacker",
    isOfType: (...types) => types.includes("creature"),
    system: { attributes: {
      weaknesses: weakness ? [{ type: weakness, value: 5 }] : [],
      resistances: [],
    }, traits: { value: [] } },
    condition: sickened ? { value: sickened, uuid: "Actor.attacker.Item.sickened" } : null,
    getCondition: () => attacker.condition,
    isImmuneTo: (slug) => immune && slug === "sickened",
    increaseCondition: async (slug, { max }) => {
      changes.push(slug);
      await new Promise(setImmediate);
      // Match PF2e's increment-and-clamp semantics, including its potential
      // to lower a higher condition if the caller fails to check it first.
      attacker.condition = {
        value: Math.min((attacker.condition?.value ?? 0) + 1, max),
        uuid: "Actor.attacker.Item.sickened",
      };
      return attacker.condition;
    },
  };
  const game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm" } },
    settings: { get: () => true },
  };
  const context = vm.createContext({
    game,
    ChatMessage: {
      create: async (data) => { chats.push(data); return data; },
      getWhisperRecipients: () => [{ id: "gm" }],
    },
    fromUuid: async (uuid) => {
      resolutions.push(uuid);
      return documents.get(uuid);
    },
    console: { error: (...args) => errors.push(args) },
    ui: { notifications: {
      info: (text) => notifications.push(text),
      warn: (text) => errors.push(text),
      error: (text) => errors.push(text),
    } },
  });
  vm.runInContext(contextSource, context);
  vm.runInContext(source, context);
  const feature = context.pf2eEliottTools.features.preciousMaterialArmor;
  let nextId = 0;
  function message() {
    const result = {
      uuid: `ChatMessage.${++nextId}`,
      author: { id: "roller" },
      whisper: [],
      blind: false,
      actor: attacker,
      target: { actor: target },
      item: {
        category: "unarmed",
        traits: new Set(["unarmed"]),
        isOfType: (...types) => types.includes("weapon"),
      },
      flags: { pf2e: { context: {
        type: "attack-roll",
        outcome: "criticalFailure",
        options: ["item:category:unarmed"],
        target: { actor: target.uuid },
      } } },
      setFlag: async (scope, key, value) => {
        result.flags[scope] ??= {};
        result.flags[scope][key] = value;
      },
    };
    return result;
  }
  return {
    armor, target, attacker, game, message, notifications, changes, errors, documents, resolutions, chats, context,
    run: feature.onCreateChatMessage,
  };
}

for (const [material, weakness] of [["cold-iron", "cold-iron"], ["silver", "silver"], ["sovereign-steel", "cold-iron"]]) {
  test(`${material} applies Sickened 1 for the correct weakness, at every grade`, async () => {
    for (const grade of ["low", "standard", "high"]) {
      const f = setup({ material, weakness });
      f.armor.system.material.grade = grade;
      const message = f.message();
      await f.run(message);
      assert.equal(f.attacker.condition.value, 1);
      assert.equal(message.flags[moduleId].preciousMaterialArmor.status, "applied");
      assert.equal(message.flags[moduleId].preciousMaterialArmor.material, material);
      assert.equal(f.chats.length, 1);
      assert.match(f.chats[0].content, /На атакующего наложена <strong>тошнота 1/);
      assert.deepEqual(f.errors, []);
    }
  });
}

test("an unholy demon without a material weakness does not qualify", async () => {
  const f = setup({ weakness: null });
  f.attacker.system.traits.value = ["fiend", "demon", "unholy"];
  await f.run(f.message());
  assert.deepEqual(f.changes, []);
});

test("resistance exceptions, a different weakness, and zero weakness do not qualify", async () => {
  for (const weakness of [null, "silver", "unholy"]) {
    const f = setup({ weakness });
    f.attacker.system.attributes.resistances = [{ type: "physical", value: 10, exceptions: ["cold-iron"] }];
    await f.run(f.message());
    assert.deepEqual(f.changes, []);
  }
  const f = setup();
  f.attacker.system.attributes.weaknesses[0].value = 0;
  await f.run(f.message());
  assert.deepEqual(f.changes, []);
});

test("other materials do not inherit a made-up critical miss effect", async () => {
  for (const material of [null, "adamantine", "dawnsilver", "mithral", "abysium", "siccatite", "noqual", "orichalcum", "duskwood"]) {
    const f = setup({ material });
    f.attacker.system.attributes.weaknesses.push({ type: "silver", value: 5 });
    await f.run(f.message());
    assert.deepEqual(f.changes, [], String(material));
  }
});

test("armor must be worn; an inventory item or shield is insufficient", async () => {
  for (const mutate of [
    (f) => { f.target.wornArmor = null; },
    (f) => { f.armor.isEquipped = false; },
    (f) => { f.armor.isOfType = (...types) => types.includes("shield"); },
  ]) {
    const f = setup();
    mutate(f);
    await f.run(f.message());
    assert.deepEqual(f.changes, []);
  }
});

test("uses final degree of success, not natural 1 or unadjusted failure", async () => {
  for (const outcome of ["success", "failure", "criticalSuccess", null]) {
    const f = setup();
    const message = f.message();
    message.flags.pf2e.context.outcome = outcome;
    message.flags.pf2e.context.unadjustedOutcome = "criticalFailure";
    message.rolls = [{ dice: [{ total: 1 }] }];
    await f.run(message);
    assert.deepEqual(f.changes, []);
  }
});

test("weapon attacks, spell attacks, Grapple checks and damage rolls do not trigger", async () => {
  for (const mutate of [
    (m) => { m.item.category = "martial"; m.item.traits.clear(); m.flags.pf2e.context.options = ["item:category:martial"]; },
    (m) => { m.item.isOfType = (...types) => types.includes("spell"); },
    (m) => { m.flags.pf2e.context.type = "skill-check"; m.flags.pf2e.context.traits = ["attack"]; },
    (m) => { m.flags.pf2e.context.type = "damage-roll"; },
  ]) {
    const f = setup();
    const message = f.message();
    mutate(message);
    await f.run(message);
    assert.deepEqual(f.changes, []);
  }
});

test("NPC unarmed traits and generated strikes without an embedded item are supported", async () => {
  for (const mutate of [
    (m) => { m.item.isOfType = (...types) => types.includes("melee"); m.item.category = null; m.flags.pf2e.context.options = ["item:trait:unarmed"]; },
    (m) => { m.item = null; },
    (m) => { m.flags.pf2e.context.options = []; },
  ]) {
    const f = setup();
    const message = f.message();
    mutate(message);
    await f.run(message);
    assert.equal(f.attacker.condition.value, 1);
  }
});

test("a weapon roll does not become unarmed after the current strike changes", async () => {
  const f = setup();
  const message = f.message();
  message.flags.pf2e.context.options = ["item:category:martial"];
  await f.run(message);
  assert.deepEqual(f.changes, []);
});

test("existing Sickened 1, 2 or 3 is neither stacked nor reduced", async () => {
  for (const sickened of [1, 2, 3]) {
    const f = setup({ sickened });
    const message = f.message();
    await f.run(message);
    assert.equal(f.attacker.condition.value, sickened);
    assert.deepEqual(f.changes, []);
    assert.equal(message.flags[moduleId].preciousMaterialArmor.status, "already-sickened");
  }
});

test("Sickened immunity is respected", async () => {
  const f = setup({ immune: true });
  const message = f.message();
  await f.run(message);
  assert.deepEqual(f.changes, []);
  assert.equal(message.flags[moduleId].preciousMaterialArmor.status, "immune");
});

test("only the active GM processes attacks, and disabling prevents work", async () => {
  for (const mutate of [
    (f) => { f.game.user.isGM = false; },
    (f) => { f.game.users.activeGM = { id: "other-gm" }; },
    (f) => { f.game.users.activeGM = null; },
    (f) => { f.game.settings.get = () => false; },
  ]) {
    const f = setup();
    mutate(f);
    await f.run(f.message());
    assert.deepEqual(f.changes, []);
    assert.deepEqual(f.resolutions, []);
  }
});

test("duplicate hooks and simultaneous attacks create a single condition", async () => {
  const f = setup();
  const first = f.message();
  await Promise.all([f.run(first), f.run(first), f.run(f.message()), f.run(f.message())]);
  assert.equal(f.changes.length, 1);
  assert.equal(f.attacker.condition.value, 1);
  assert.equal(f.chats.length, 3);
  assert.equal(f.chats.filter((chat) => chat.flags[moduleId].preciousMaterialArmor.status === "applied").length, 1);
});

test("a persisted result is not applied again, even if the condition was removed", async () => {
  const f = setup();
  const message = f.message();
  message.flags[moduleId] = { preciousMaterialArmor: { status: "applied" } };
  await f.run(message);
  assert.deepEqual(f.changes, []);
});

test("resolves the recorded synthetic target, never the current target or base actor", async () => {
  const f = setup();
  const message = f.message();
  message.target = null;
  message.flags.pf2e.context.target.token = "Scene.scene.Token.target";
  f.target.uuid = "Scene.scene.Token.target.Actor.target";
  f.documents.set("Scene.scene.Token.target", { actor: f.target });
  f.documents.set("Actor.target", { ...f.target, wornArmor: null });
  await f.run(message);
  assert.deepEqual(f.resolutions, ["Scene.scene.Token.target"]);
  assert.equal(f.attacker.condition.value, 1);
  assert.equal(message.flags[moduleId].preciousMaterialArmor.target, f.target.uuid);
});

test("missing target and deleted tokens do not fall back to another actor", async () => {
  for (const target of [null, { actor: "Actor.target", token: "Scene.scene.Token.deleted" }]) {
    const f = setup();
    const message = f.message();
    message.target = null;
    message.flags.pf2e.context.target = target;
    f.documents.set("Actor.target", f.target);
    await f.run(message);
    assert.deepEqual(f.changes, []);
  }
});

test("synthetic attackers receive their own condition", async () => {
  const f = setup();
  f.attacker.uuid = "Scene.scene.Token.attacker.Actor.attacker";
  const message = f.message();
  await f.run(message);
  assert.equal(message.flags[moduleId].preciousMaterialArmor.attacker, f.attacker.uuid);
  assert.equal(f.changes.length, 1);
});

test("PF2e rejecting condition creation does not produce a false success", async () => {
  const f = setup();
  f.attacker.increaseCondition = async () => null;
  const message = f.message();
  await f.run(message);
  assert.equal(message.flags[moduleId], undefined);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.chats.length, 0);
});

test("errors are handled and the next attack is not blocked by a failed queue", async () => {
  const f = setup();
  const original = f.attacker.increaseCondition;
  f.attacker.increaseCondition = async () => { throw new Error("Update failed"); };
  await f.run(f.message());
  assert.ok(f.errors.length > 0);
  f.attacker.increaseCondition = original;
  await f.run(f.message());
  assert.equal(f.attacker.condition.value, 1);
});

test("disabling while target resolution is pending cancels the application", async () => {
  const f = setup();
  const message = f.message();
  const pending = f.run(message);
  f.game.settings.get = () => false;
  await pending;
  assert.deepEqual(f.changes, []);
});

test("chat explains the trigger, actors and rule, without generating another attack", async () => {
  const f = setup();
  const message = f.message();
  await f.run(message);
  const chat = f.chats[0];
  assert.match(chat.content, /Холодное железо/);
  assert.match(chat.content, /Attacker/);
  assert.match(chat.content, /Defender/);
  assert.match(chat.content, /критически промахивается безоружной атакой/);
  assert.match(chat.content, /https:\/\/2e.aonprd.com\/Equipment.aspx\?ID=2798/);
  assert.equal(chat.flags[moduleId].preciousMaterialArmor.triggeredBy, message.uuid);
  await f.run(chat);
  assert.equal(f.chats.length, 1);
});

test("chat explains immunity and existing Sickened without claiming a new condition", async () => {
  const immune = setup({ immune: true });
  await immune.run(immune.message());
  assert.match(immune.chats[0].content, /Тошнота не наложена.*иммунитет/);
  const sick = setup({ sickened: 3 });
  await sick.run(sick.message());
  assert.match(sick.chats[0].content, /уже есть тошнота 3/);
  assert.match(sick.chats[0].content, /Значение не изменилось/);
  assert.equal(sick.changes.length, 0);
});

test("public rolls produce public chat", async () => {
  const f = setup();
  await f.run(f.message());
  assert.equal(f.chats[0].whisper.length, 0);
  assert.equal(f.chats[0].blind, false);
});

test("private rolls preserve recipients and the original author's access", async () => {
  const f = setup();
  const message = f.message();
  message.whisper = ["gm", "observer"];
  await f.run(message);
  assert.deepEqual(Array.from(f.chats[0].whisper), ["gm", "observer", "roller"]);
  assert.equal(f.chats[0].blind, false);
  assert.deepEqual(message.whisper, ["gm", "observer"]);
});

test("blind rolls stay private and do not reveal results to the roller", async () => {
  const f = setup();
  const message = f.message();
  message.whisper = [{ id: "gm" }];
  message.blind = true;
  await f.run(message);
  assert.deepEqual(Array.from(f.chats[0].whisper), ["gm"]);
  assert.equal(f.chats[0].blind, true);
});

test("self rolls remain addressed to the original roller", async () => {
  const f = setup();
  const message = f.message();
  delete message.author;
  message.user = { id: "roller" };
  message.whisper = ["roller"];
  await f.run(message);
  assert.deepEqual(Array.from(f.chats[0].whisper), ["roller"]);
});

test("actor names are escaped before being inserted into chat HTML", async () => {
  const f = setup();
  f.attacker.name = '<img src=x onerror="attack()">';
  f.target.name = "A & B";
  await f.run(f.message());
  assert.doesNotMatch(f.chats[0].content, /<img/);
  assert.match(f.chats[0].content, /&lt;img/);
  assert.match(f.chats[0].content, /A &amp; B/);
});

test("chat failure preserves the applied effect and does not cause a duplicate", async () => {
  const f = setup();
  f.context.ChatMessage.create = async () => { throw new Error("Chat failed"); };
  const message = f.message();
  await f.run(message);
  assert.equal(f.attacker.condition.value, 1);
  assert.equal(message.flags[moduleId].preciousMaterialArmor.status, "applied");
  assert.ok(f.errors.some((error) => typeof error === "string" && error.includes("сообщение в чат")));
  await f.run(message);
  assert.equal(f.changes.length, 1);
});
