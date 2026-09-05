const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const featureSource = readFileSync(join(__dirname, "../scripts/features/frightened-recovery.js"), "utf8");
const contextSource = readFileSync(join(__dirname, "../scripts/module/context.js"), "utf8");

function condition(id, value, overrides = {}) {
  return { id, slug: "frightened", value, active: true,
    _source: { system: { value: { value } } }, ...overrides };
}

function setup({ enabled = true, isGM = true, activeGM = "gm" } = {}) {
  const changes = [];
  const errors = [];
  const notifications = [];
  const game = { user: { id: "gm", isGM }, users: { activeGM: activeGM ? { id: activeGM } : null },
    settings: { get: () => enabled } };
  const context = vm.createContext({ game,
    console: { error: (...args) => errors.push(args) },
    ui: { notifications: { error: (message) => notifications.push(message) } },
  });
  vm.runInContext(contextSource, context);
  vm.runInContext(featureSource, context);
  function actor(uuid = "Actor.pc", conditions = [condition("fear", 2)]) {
    const items = new Map(conditions.map((entry) => [entry.id, entry]));
    return { uuid, isDead: false, isOfType: (type) => type === "creature", items,
      itemTypes: { get condition() { return [...items.values()]; } },
      async decreaseCondition(entry) {
        const value = entry._source.system.value.value - 1;
        changes.push({ uuid, id: entry.id, value });
        if (value === 0) items.delete(entry.id);
        else entry.value = entry._source.system.value.value = value;
      },
    };
  }
  const pc = actor();
  const encounter = { started: true, round: 1 };
  const combatant = { actor: pc, parent: encounter, flags: { pf2e: { roundOfLastTurnEnd: 1 } },
    tokens: [{ actor: pc }] };
  return { game, context, pc, actor, encounter, combatant, changes, errors, notifications,
    enable: (value) => { enabled = value; },
    end: (target = combatant, combat = encounter) => context.pf2eEliottTools.features.frightenedRecovery.onEndTurn(target, combat),
  };
}

test("frightened 2 becomes 1, then is removed at the next own turn end", async () => {
  const env = setup();
  await env.end();
  assert.equal(env.pc.items.get("fear").value, 1);
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 2;
  await env.end();
  assert.equal(env.pc.items.has("fear"), false);
  assert.deepEqual(env.changes.map((entry) => entry.value), [1, 0]);
});

test("ending another creature's turn leaves the original actor unchanged", async () => {
  const env = setup();
  const npc = env.actor("Actor.npc", [condition("npc-fear", 3)]);
  const other = { ...env.combatant, actor: npc, tokens: [{ actor: npc }] };
  await env.end(other);
  assert.equal(npc.items.get("npc-fear").value, 2);
  assert.equal(env.pc.items.get("fear").value, 2);
});

test("disabled, player, secondary GM and no active GM do not write", async () => {
  for (const options of [{ enabled: false }, { isGM: false }, { activeGM: "other" }, { activeGM: null }]) {
    const env = setup(options);
    await env.end();
    assert.equal(env.changes.length, 0);
  }
});

test("enabling takes effect on the next turn event without a reload", async () => {
  const env = setup({ enabled: false });
  await env.end();
  env.enable(true);
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 2;
  await env.end();
  assert.equal(env.pc.items.get("fear").value, 1);
});

test("no combat, wrong encounter, or missing completed-turn marker cannot trigger recovery", async () => {
  const env = setup();
  env.encounter.started = false;
  await env.end();
  env.encounter.started = true;
  await env.end(env.combatant, { started: true });
  delete env.combatant.flags.pf2e.roundOfLastTurnEnd;
  await env.end();
  assert.equal(env.changes.length, 0);
});

test("duplicate hooks and backward navigation never repeat the same completed round", async () => {
  const env = setup();
  env.pc.items.set("fear", condition("fear", 4));
  await Promise.all([env.end(), env.end(), env.end()]);
  assert.equal(env.changes.length, 1);
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 2;
  await env.end();
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 1;
  await env.end();
  assert.equal(env.pc.items.get("fear").value, 2);
});

test("round boundary uses the completed turn's round, not the encounter's new round", async () => {
  const env = setup();
  env.encounter.round = 2;
  await env.end();
  env.encounter.round = 3;
  await env.end();
  assert.equal(env.changes.length, 1);
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 2;
  await env.end();
  assert.equal(env.changes.length, 2);
});

test("resetting the encounter allows recovery in round 1 of the restarted combat", async () => {
  const env = setup();
  env.encounter.combatants = [env.combatant];
  await env.end();
  env.context.pf2eEliottTools.features.frightenedRecovery.onUpdateCombat(env.encounter, { round: 0 });
  await env.end();
  assert.equal(env.pc.items.has("fear"), false);
});

test("all stored independent fear sources decay, including weaker inactive sources", async () => {
  const env = setup();
  env.pc.items.set("fear", condition("fear", 3));
  env.pc.items.set("weaker", condition("weaker", 1, { active: false }));
  env.pc.items.set("sickened", condition("sickened", 2, { slug: "sickened" }));
  await env.end();
  assert.equal(env.pc.items.get("fear").value, 2);
  assert.equal(env.pc.items.has("weaker"), false);
  assert.equal(env.pc.items.get("sickened").value, 2);
});

test("locked and temporary fear floors remain while free fear decreases", async () => {
  const env = setup();
  for (const flag of ["isLocked", "inMemoryOnly", "readonly"]) {
    env.pc.items.set(flag, condition(flag, 1, { [flag]: true }));
  }
  await env.end();
  assert.equal(env.changes.length, 1);
  for (const flag of ["isLocked", "inMemoryOnly", "readonly"]) assert.equal(env.pc.items.get(flag).value, 1);
});

test("zero, malformed, dead and missing actors do not write", async () => {
  const env = setup();
  env.pc.items.set("fear", condition("fear", 0));
  env.pc.items.set("bad", condition("bad", null));
  await env.end();
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 2;
  env.pc.items.set("fear", condition("fear", 3));
  env.pc.isDead = true;
  await env.end();
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 3;
  env.combatant.actor = null;
  env.combatant.tokens = [];
  await env.end();
  assert.equal(env.changes.length, 0);
});

test("synthetic tokens use their own actor and repeated linked tokens only count once", async () => {
  const env = setup();
  const npc = env.actor("Scene.scene.Token.npc.Actor.base");
  env.combatant.actor = npc;
  env.combatant.tokens = [{ actor: npc }, { actor: npc }];
  await env.end();
  assert.equal(npc.items.get("fear").value, 1);
  assert.equal(env.pc.items.get("fear").value, 2);
  assert.equal(env.changes.length, 1);
});

test("disabling or losing GM authority before queued work cancels it", async () => {
  for (const mode of ["disable", "gm"]) {
    const env = setup();
    const pending = env.end();
    if (mode === "disable") env.enable(false);
    else env.game.users.activeGM = { id: "other" };
    await pending;
    assert.equal(env.changes.length, 0);
  }
});

test("new or changed fear after the turn-end snapshot is not decremented", async () => {
  const env = setup();
  const pending = env.end();
  env.pc.items.set("new", condition("new", 3));
  env.pc.items.get("fear")._source.system.value.value = 4;
  await pending;
  assert.equal(env.changes.length, 0);
  assert.equal(env.pc.items.get("new").value, 3);
});

test("a failed update warns the GM without retrying the same turn", async () => {
  const env = setup();
  const original = env.pc.decreaseCondition;
  env.pc.decreaseCondition = async () => { throw new Error("write failed"); };
  await env.end();
  assert.equal(env.errors.length, 1);
  assert.equal(env.notifications.length, 1);
  env.pc.decreaseCondition = original;
  await env.end();
  assert.equal(env.changes.length, 0);
  env.combatant.flags.pf2e.roundOfLastTurnEnd = 2;
  await env.end();
  assert.equal(env.changes.length, 1);
});
