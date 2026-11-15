const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const moduleId = "pf2e-eliott-tools";
const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");
const flush = () => new Promise(setImmediate);

function feat(slug, extra = {}) {
  return { slug, id: `item-${slug}`, name: slug, img: "icon.svg", system: { actionType: { value: "reaction" }, ...extra.system },
    isOfType: (...types) => types.includes(extra.type ?? "feat"), ...extra };
}

function makeActor(name, { feats = [], alliance = "party", shield = null, raised = false, conditions = [], hp = 20 } = {}) {
  const actor = {
    name, uuid: `Actor.${name}`, alliance,
    itemTypes: { feat: feats, action: [] },
    heldShield: shield,
    attributes: { shield: { raised, broken: !!shield?.isBroken, destroyed: !!shield?.isDestroyed }, hp: { value: hp } },
    hitPoints: { value: hp },
    hasCondition: (slug) => conditions.includes(slug),
    isEnemyOf: (other) => actor.alliance !== other.alliance,
    isAllyOf: (other) => actor !== other && actor.alliance === other.alliance,
    getReach: () => 5,
    testUserPermission: () => alliance === "party",
    items: { get: (id) => feats.find((item) => item.id === id) },
  };
  return actor;
}

function makeShield(overrides = {}) {
  return { name: "Steel Shield", hardness: 5, acBonus: 2, hitPoints: { value: 20, max: 20 }, isBroken: false, isDestroyed: false, ...overrides };
}

function setup({ enabled = true, distance = () => 5 } = {}) {
  const hooks = new Map();
  const messages = [];
  const settings = new Map();
  const context = vm.createContext({
    console,
    Hooks: { on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) },
    PIXI: { Rectangle: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } } },
    canvas: { grid: { size: 100 }, scene: { tokens: [] } },
    document: { querySelector: () => ({}), createElement: () => ({}), head: { append() {} } },
    foundry: { utils: { getRoute: (path) => path } },
    ui: { notifications: { warn() {}, error() {} } },
    ChatMessage: { create: async (data) => { messages.push(data); return data; }, getSpeaker: () => ({}) },
    game: {
      release: { generation: 14 },
      user: { id: "gm", isGM: true },
      users: Object.assign([{ id: "gm", isGM: true }, { id: "player", isGM: false }], { activeGM: { id: "gm" } }),
      settings: {
        register: (_id, key, value) => settings.set(key, value),
        get: (_id, key) => (key === "reactionsEnabled" ? enabled : settings.get(key)?.default),
      },
    },
    pf2eEliottTools: { module: { id: moduleId, logPrefix: "test", settings: { reactionsEnabled: "reactionsEnabled" } } },
  });
  for (const file of ["core", "catalog", "index"]) vm.runInContext(read(`scripts/features/reactions/${file}.js`), context);
  const feature = context.pf2eEliottTools.features.reactions;
  feature.onInit();

  const combatants = [];
  const combat = {
    id: "combat", started: true, round: 1, turn: 0,
    combatants: Object.assign(combatants, { get: (id) => combatants.find((entry) => entry.id === id) }),
    get combatant() { return combatants[this.turn]; },
  };
  context.game.combat = combat;

  function addCombatant(actor) {
    const token = { id: `token-${actor.name}`, actor, x: 0, y: 0, width: 1, height: 1, elevation: 0 };
    token.object = { distanceTo: (other) => distance(token, other) };
    const flags = {};
    const combatant = {
      id: `combatant-${actor.name}`, actor, token, tokenId: token.id, defeated: false,
      getFlag: (_scope, key) => flags[key],
      setFlag: async (_scope, key, value) => { flags[key] = value; },
      unsetFlag: async (_scope, key) => { delete flags[key]; },
    };
    combatants.push(combatant);
    return combatant;
  }

  const emit = (name, ...args) => hooks.get(name)?.forEach((fn) => fn(...args));
  return { context, feature, hooks, messages, settings, combat, addCombatant, emit };
}

function attackMessage(attacker, target, { type = "attack-roll", outcome = "success", total = 20, dc = 18, die = 10, damageTypes = [], item } = {}) {
  return {
    flags: { pf2e: { context: { type, outcome, dc: { value: dc }, traits: ["attack"], options: [] } } },
    actor: attacker.actor, token: attacker.token,
    target: { actor: target.actor, token: target.token },
    item: item ?? { isMelee: true, isOfType: (...types) => types.includes("weapon"), system: { traits: { value: [] } } },
    rolls: [{ total, dice: [{ total: die }], instances: damageTypes.map((type) => ({ type })) }],
    getFlag: () => undefined,
  };
}

test("disabled setting registers no reaction hooks", () => {
  const env = setup({ enabled: false });
  assert.equal(env.settings.get("reactionsEnabled").requiresReload, true);
  assert.equal(env.hooks.has("createChatMessage"), false);
  assert.equal(env.hooks.has("renderCombatTracker"), false);
});

test("Shield Block is offered only with a raised, intact shield against physical attack damage", async () => {
  const cases = [
    { shield: null, raised: true, expected: 0 },
    { shield: makeShield(), raised: false, expected: 0 },
    { shield: makeShield({ isBroken: true }), raised: true, expected: 0 },
    { shield: makeShield(), raised: true, expected: 1 },
    { shield: makeShield(), raised: true, damageTypes: ["fire"], expected: 0 },
  ];
  for (const { shield, raised, damageTypes = ["slashing"], expected } of cases) {
    const env = setup();
    const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
    const hero = env.addCombatant(makeActor("Hero", { feats: [feat("shield-block")], shield, raised }));
    await env.feature.handleMessage(attackMessage(goblin, hero, { type: "damage-roll", damageTypes }));
    assert.equal(env.messages.length, expected, JSON.stringify({ shield: !!shield, raised, damageTypes }));
    if (expected) {
      assert.match(env.messages[0].content, /shield-block/);
      assert.deepEqual([...env.messages[0].whisper], ["gm", "player"]);
    }
  }
});

test("Nimble Dodge is offered only when +2 AC changes the attack result", async () => {
  for (const [total, expected] of [[19, 1], [25, 0]]) {
    const env = setup();
    const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
    const hero = env.addCombatant(makeActor("Hero", { feats: [feat("nimble-dodge")] }));
    await env.feature.handleMessage(attackMessage(goblin, hero, { total, dc: 18 }));
    assert.equal(env.messages.length, expected, `total ${total}`);
  }
});

test("incapacitated or out-of-reaction creatures get no prompt", async () => {
  const env = setup();
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  const stunned = env.addCombatant(makeActor("Hero", { feats: [feat("nimble-dodge")], conditions: ["stunned"] }));
  await env.feature.handleMessage(attackMessage(goblin, stunned, { total: 19 }));
  assert.equal(env.messages.length, 0);

  const spent = env.addCombatant(makeActor("Rogue", { feats: [feat("nimble-dodge")] }));
  await spent.setFlag(moduleId, "reactions", { spent: 1, pools: {} });
  await env.feature.handleMessage(attackMessage(goblin, spent, { total: 19 }));
  assert.equal(env.messages.length, 0);
});

test("posting a reaction spends the extra pool before the general reaction", async () => {
  const env = setup();
  const block = feat("shield-block");
  const hero = env.addCombatant(makeActor("Hero", { feats: [block, feat("quick-shield-block")] }));
  const card = { flags: { pf2e: { origin: { uuid: "Actor.Hero.Item.block", type: "feat" } } }, item: { ...block, actor: hero.actor }, actor: hero.actor, getFlag: () => undefined };
  const core = env.feature.core;
  assert.equal(core.remaining(hero, "shield-block"), 2);
  await env.feature.handleMessage(card);
  assert.deepEqual(JSON.parse(JSON.stringify(hero.getFlag(moduleId, "reactions"))), { spent: 0, pools: { "quick-shield-block": 1 } });
  assert.equal(core.remaining(hero), 1);
  await env.feature.handleMessage(card);
  assert.equal(core.remaining(hero, "shield-block"), 0);
});

test("reaction refreshes at the start of the combatant's own turn", async () => {
  const env = setup();
  const hero = env.addCombatant(makeActor("Hero"));
  await hero.setFlag(moduleId, "reactions", { spent: 1, pools: {} });
  env.emit("updateCombat", env.combat, { turn: 0 });
  await flush();
  assert.equal(hero.getFlag(moduleId, "reactions"), undefined);
});

test("Reactive Strike triggers when the acting enemy leaves a square in reach, once per turn", async () => {
  // The fighter is adjacent to the goblin's starting square only.
  const env = setup({ distance: (_from, to) => (to.x === 0 ? 5 : 15) });
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  env.addCombatant(makeActor("Fighter", { feats: [feat("reactive-strike", { type: "feat" })] }));
  env.emit("canvasReady");
  env.feature.handleTokenMove(goblin.token, {});
  // Seed the starting position, then move twice.
  env.hooks.get("createToken")[0](goblin.token);
  goblin.token.x = 100;
  await env.feature.handleTokenMove(goblin.token, { x: 100 });
  goblin.token.x = 200;
  await env.feature.handleTokenMove(goblin.token, { x: 200 });
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0].content, /reactive-strike/);
});

test("Reactive Strike ignores moves by a creature whose turn it is not", async () => {
  const env = setup({ distance: () => 5 });
  env.addCombatant(makeActor("Fighter", { feats: [feat("reactive-strike")] }));
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  env.hooks.get("createToken")[0](goblin.token);
  goblin.token.x = 100;
  await env.feature.handleTokenMove(goblin.token, { x: 100 });
  assert.equal(env.messages.length, 0);
});

test("catalog entries are well-formed and cover every upstream reaction", () => {
  const env = setup();
  const known = new Set(["attack-roll", "damage-roll", "damage-taken", "saving-throw", "skill-check", "perception-check", "action", "move"]);
  const ids = new Set();
  const slugs = new Set();
  for (const entry of env.feature.catalog) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.slugs.length > 0 && entry.triggers.length > 0, entry.id);
    for (const trigger of entry.triggers) assert.ok(known.has(trigger), `${entry.id}: ${trigger}`);
    assert.ok(["target", "self", "others", "any"].includes(entry.scope), entry.id);
    entry.slugs.forEach((slug) => slugs.add(slug));
  }
  const upstream = ["youre-next", "ring-bell", "ferocity", "entitys-resurgence", "final-spite", "amulets-abeyance", "retributive-strike",
    "denier-of-destruction", "glimpse-of-redemption", "flash-of-grandeur", "liberating-step", "vengeful-spite", "reactive-gnaw",
    "iron-command", "selfish-shield", "destructive-vengeance", "avenging-bite", "implements-interruption", "fast-swallow", "wicked-thorns",
    "schadenfreude", "opportune-backstab", "convincing-illusion", "mental-static", "premonition-of-clarity", "grit-and-tenacity",
    "emergency-targe", "orc-ferocity", "cheat-death", "cleave", "shield-block", "banshee-cry", "electric-counter", "all-in-my-head",
    "unexpected-shift", "resounding-finale", "reverberate", "verdant-presence", "align-ki", "mage-hunter", "counter-thought", "accompany",
    "spell-relay", "you-failed-to-account-for-this", "suspect-of-opportunity", "foresee-danger", "mirror-shield", "spiritual-guides",
    "squawk", "sacrifice-armor", "reactive-transformation", "fake-out", "ruby-resurrection", "rapid-response", "no", "wounded-rage",
    "negate-damage", "distracting-explosion", "embrace-the-pain", "retaliatory-cleansing", "nimble-dodge", "ectoplasmic-shield",
    "airy-step", "farabellus-flip", "reactive-shield", "pirouette", "fiery-retort", "knights-retaliation", "clever-gambit",
    "opportune-riposte", "dueling-riposte", "twin-riposte", "perfect-clarity", "furious-vengeance", "cringe", "storm-retribution",
    "courageous-opportunity", "attack-of-opportunity", "reactive-strike", "impossible-technique", "rippling-spin",
    "guardians-deflection-fighter", "guardians-deflection-swashbuckler", "stand-still", "no-escape", "verdistant-defense",
    "eerie-flicker", "scars-of-steel", "sense-the-unseen", "shoving-sweep", "intercept-attack", "flashy-dodge", "hit-the-dirt",
    "deflect-arrow", "nights-warning", "blood-rising", "inked-panoply", "hunters-defense", "lucky-escape", "wood-ward",
    "deflecting-cloud", "reactive-charm", "instinctive-obfuscation", "reflective-defense", "disarming-smile", "crane-flutter",
    "everdistant-defense", "reflexive-courage", "tangle-of-battle"];
  const missing = upstream.filter((slug) => !slugs.has(slug));
  assert.deepEqual(missing, []);
});

test("Grit and Tenacity follows a failed Fortitude save of the roller only", async () => {
  for (const [domain, outcome, expected] of [["fortitude", "failure", 1], ["reflex", "failure", 0], ["will", "success", 0]]) {
    const env = setup();
    const hero = env.addCombatant(makeActor("Hero", { feats: [feat("grit-and-tenacity")] }));
    await env.feature.handleMessage({
      flags: { pf2e: { context: { type: "saving-throw", outcome, domains: ["saving-throw", domain], options: [] } } },
      actor: hero.actor, token: hero.token, target: null, rolls: [], getFlag: () => undefined,
    });
    assert.equal(env.messages.length, expected, `${domain} ${outcome}`);
  }
});

test("Orc Ferocity follows a damage-taken message that drops the creature to 0 HP", async () => {
  const env = setup();
  const hero = env.addCombatant(makeActor("Hero", { feats: [feat("orc-ferocity")], hp: 0, conditions: ["unconscious"] }));
  await env.feature.handleMessage({
    flags: { pf2e: { context: { type: "damage-taken", options: [] }, appliedDamage: { updates: [{ path: "system.attributes.hp.value", value: 7 }] } } },
    actor: hero.actor, token: hero.token, rolls: [], getFlag: () => undefined,
  });
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0].content, /orc-ferocity/);
});

test("Reactive Strike answers a ranged attack aimed at the reactor itself", async () => {
  const env = setup();
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  const fighter = env.addCombatant(makeActor("Fighter", { feats: [feat("reactive-strike")] }));
  const bow = { isMelee: false, isRanged: true, isOfType: (...types) => types.includes("weapon"), system: { traits: { value: [] } } };
  await env.feature.handleMessage(attackMessage(goblin, fighter, { item: bow, outcome: "failure", total: 10 }));
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0].content, /reactive-strike/);
});

test("Foresee Danger appears only when the Perception DC turns the hit into a miss", async () => {
  for (const [perceptionDC, expected] of [[25, 1], [15, 0]]) {
    const env = setup();
    const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
    const actor = makeActor("Oracle", { feats: [feat("foresee-danger")] });
    actor.perception = { dc: { value: perceptionDC } };
    const oracle = env.addCombatant(actor);
    await env.feature.handleMessage(attackMessage(goblin, oracle, { total: 20, dc: 18 }));
    assert.equal(env.messages.length, expected, `Perception DC ${perceptionDC}`);
  }
});

test("prompt links the reaction item", async () => {
  const env = setup();
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  const dodge = feat("nimble-dodge", { uuid: "Actor.Hero.Item.dodge" });
  const hero = env.addCombatant(makeActor("Hero", { feats: [dodge] }));
  await env.feature.handleMessage(attackMessage(goblin, hero, { total: 19 }));
  assert.match(env.messages[0].content, /@UUID\[Actor\.Hero\.Item\.dodge\]\{nimble-dodge\}/);
});

test("NPC Ferocity still triggers after PF2e marks the downed NPC defeated", async () => {
  const env = setup();
  const npc = env.addCombatant(makeActor("Orc", { feats: [feat("ferocity", { type: "action" })], alliance: "opposition", hp: 0 }));
  npc.actor.itemTypes.action = npc.actor.itemTypes.feat;
  npc.defeated = true;
  await env.feature.handleMessage({
    flags: { pf2e: { context: { type: "damage-taken", options: [] }, appliedDamage: { updates: [{ path: "system.attributes.hp.value", value: 9 }] } } },
    actor: npc.actor, token: npc.token, rolls: [], getFlag: () => undefined,
  });
  assert.equal(env.messages.length, 1);
});

test("a spell card and its attack roll give one Reactive Strike prompt", async () => {
  const env = setup();
  const mage = env.addCombatant(makeActor("Mage", { alliance: "opposition" }));
  const fighter = env.addCombatant(makeActor("Fighter", { feats: [feat("reactive-strike")] }));
  const spell = { uuid: "Actor.Mage.Item.ray", isRanged: true, isMelee: false, isOfType: (...types) => types.includes("spell"),
    system: { traits: { value: ["manipulate", "concentrate", "attack"] } } };
  await env.feature.handleMessage({ flags: { pf2e: { origin: { uuid: spell.uuid, type: "spell" } } }, actor: mage.actor, token: mage.token,
    item: spell, rolls: [], getFlag: () => undefined });
  await env.feature.handleMessage(attackMessage(mage, fighter, { item: spell, outcome: "failure", total: 5 }));
  assert.equal(env.messages.length, 1);
});

test("a Stride card and the following move give one Reactive Strike prompt", async () => {
  const env = setup({ distance: () => 5 });
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  env.addCombatant(makeActor("Fighter", { feats: [feat("reactive-strike")] }));
  const stride = { uuid: "Item.stride", isOfType: (...types) => types.includes("action"), system: { traits: { value: ["move"] } } };
  await env.feature.handleMessage({ flags: { pf2e: { origin: { uuid: stride.uuid, type: "action" } } }, actor: goblin.actor, token: goblin.token,
    item: stride, rolls: [], getFlag: () => undefined });
  env.hooks.get("createToken")[0](goblin.token);
  goblin.token.x = 100;
  await env.feature.handleTokenMove(goblin.token, { x: 100 });
  assert.equal(env.messages.length, 1);
  // The next turn starts fresh.
  env.emit("updateCombat", env.combat, { turn: 1 });
  env.combat.turn = 0;
  goblin.token.x = 200;
  await env.feature.handleTokenMove(goblin.token, { x: 200 });
  assert.equal(env.messages.length, 2);
});

test("an actor's reaction index refreshes when it gains a feat", async () => {
  const env = setup();
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  const hero = env.addCombatant(makeActor("Hero"));
  await env.feature.handleMessage(attackMessage(goblin, hero, { total: 19 }));
  assert.equal(env.messages.length, 0);
  const dodge = feat("nimble-dodge");
  hero.actor.itemTypes.feat.push(dodge);
  env.emit("createItem", { type: "feat", parent: hero.actor });
  await env.feature.handleMessage(attackMessage(goblin, hero, { total: 19 }));
  assert.equal(env.messages.length, 1);
});

test("messages no reaction listens to are skipped before resolving their source", async () => {
  const env = setup();
  env.addCombatant(makeActor("Hero", { feats: [feat("nimble-dodge")] }));
  let lookups = 0;
  env.context.fromUuidSync = () => { lookups += 1; return null; };
  for (const type of ["initiative", "flat-check", "counteract-check"]) {
    await env.feature.handleMessage({ flags: { pf2e: { context: { type, options: [] }, origin: { uuid: "Item.x" } } }, rolls: [], getFlag: () => undefined });
  }
  assert.equal(lookups, 0);
  assert.equal(env.messages.length, 0);
});

test("without a GM only one client refreshes the reaction at turn start", async () => {
  for (const [userId, expected] of [["a", undefined], ["b", 1]]) {
    const env = setup();
    env.context.game.users = Object.assign([{ id: "a", active: true, isGM: false }, { id: "b", active: true, isGM: false }], { activeGM: null });
    env.context.game.user = { id: userId };
    const hero = env.addCombatant(makeActor("Hero"));
    await hero.setFlag(moduleId, "reactions", { spent: 1, pools: {} });
    env.emit("updateCombat", env.combat, { turn: 0 });
    await flush();
    assert.equal(hero.getFlag(moduleId, "reactions")?.spent, expected, `client ${userId}`);
  }
});

// Square grid of 100px cells: straight and diagonal direct paths between cell centres.
function squareGrid() {
  return {
    size: 100, isGridless: false,
    getDirectPath([from, to]) {
      const [i0, j0, i1, j1] = [Math.floor(from.y / 100), Math.floor(from.x / 100), Math.floor(to.y / 100), Math.floor(to.x / 100)];
      const steps = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
      return Array.from({ length: steps + 1 }, (_v, k) => ({
        i: i0 + Math.round(((i1 - i0) * k) / (steps || 1)), j: j0 + Math.round(((j1 - j0) * k) / (steps || 1)),
      }));
    },
    getTopLeftPoint: ({ i, j }) => ({ x: j * 100, y: i * 100 }),
  };
}

function pathSetup() {
  // The fighter stands at x=500; distance grows 5 ft per column away from it.
  const env = setup({ distance: (_from, to) => Math.max(Math.abs(to.x - 500) / 100, 1) * 5 });
  env.context.canvas.grid = squareGrid();
  const goblin = env.addCombatant(makeActor("Goblin", { alliance: "opposition" }));
  env.addCombatant(makeActor("Fighter", { feats: [feat("reactive-strike")] }));
  const move = (waypoints, method = "dragging") => env.feature.handleMovement(goblin.token, {
    origin: { x: 0, y: 0 }, method, passed: { waypoints: waypoints.map(([x, action = "walk"]) => ({ x, y: 0, action })) },
  }, "gm");
  return { env, move };
}

test("moving through reach and out the other side provokes Reactive Strike", async () => {
  const { env, move } = pathSetup();
  // 0 → 1000 in one drag: squares 400–600 are within 5 ft of the fighter.
  await move([[1000]]);
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0].content, /reactive-strike/);
});

test("stopping inside reach does not provoke: the last square is not left", async () => {
  const { env, move } = pathSetup();
  await move([[400]]);
  assert.equal(env.messages.length, 0);
});

test("moves that stay out of reach, teleports and undo do not provoke", async () => {
  for (const [waypoints, method] of [[[[300]], "dragging"], [[[1000, "displace"]], "dragging"], [[[1000]], "undo"]]) {
    const { env, move } = pathSetup();
    await move(waypoints, method);
    assert.equal(env.messages.length, 0, JSON.stringify({ waypoints, method }));
  }
});

test("movement squares fill the grid between waypoints and skip displaced segments", () => {
  const env = setup();
  env.context.canvas.grid = squareGrid();
  const core = env.feature.core;
  const squares = core.movementSquares({ x: 0, y: 0 }, [{ x: 300, y: 0, action: "walk" }, { x: 900, y: 0, action: "displace" }], { width: 1 });
  assert.deepEqual([...squares.map((square) => square.x)], [0, 100, 200, 300, 900]);
  assert.deepEqual([...core.leftSquares(squares).map((square) => square.x)], [0, 100, 200]);
});
