const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const fixture = require("./fixtures/barrows-edge-pf2e-8.5.0.json");
const moduleId = "pf2e-eliott-tools";
const manual = "barrows-edge:target-below-half";
const known = "target:eliott-tools:barrows-edge:hp-known";
const below = "target:eliott-tools:barrows-edge:below-half";

class TestPredicate extends Array {
  constructor(...statements) { super(...statements); }
  test(options) {
    const check = (s) => typeof s === "string" ? options.has(s)
      : s.or ? s.or.some(check) : s.and ? s.and.every(check) : s.not ? !check(s.not) : false;
    return this.every(check);
  }
}
let Predicate = TestPredicate;
let nativePrepareAdjustment;
if (process.env.PF2E_BARROWS_NATIVE_SOURCE) {
  const native = vm.runInNewContext(readFileSync(process.env.PF2E_BARROWS_NATIVE_SOURCE, "utf8"), {
    R: { isPlainObject: (v) => v !== null && typeof v === "object" && !Array.isArray(v) },
    fu: { deepClone: structuredClone }, SYSTEM_NAME: "PF2e", console,
    AELikeRuleElement: { getNewValue: (mode, current, change) => {
      assert.equal(mode, "multiply"); return current * change;
    } },
  });
  Predicate = native.Predicate;
  nativePrepareAdjustment = native.prepareAdjustment;
}

function setup({ enabled = true, slug = "barrows-edge", sourceId, rules = fixture.rules } = {}) {
  class Actor {
    constructor(hp = { value: 100, max: 100 }) {
      this.system = { attributes: { hp } };
      this.rollOptions = { all: { "self:creature": true } };
      this.synthetics = { modifierAdjustments: {} };
    }
    getSelfRollOptions(prefix = "self") {
      return Object.keys(this.rollOptions.all).filter((key) => key.startsWith("self:") && this.rollOptions.all[key])
        .map((key) => key.replace(/^self/, prefix));
    }
  }
  class Character extends Actor {}
  class NPC extends Actor {}
  class AdjustModifier {
    constructor(source, parent) {
      Object.assign(this, structuredClone(source));
      this.predicate = new Predicate(...structuredClone(source.predicate));
      this.selectors = [source.selector];
      this.actor = parent.actor;
      this.item = parent;
      this.maxApplications = Infinity;
    }
    resolveInjectedProperties(value) { return value; }
    resolveValue(value) { return value; }
    beforePrepareData() {
      if (nativePrepareAdjustment) return nativePrepareAdjustment.call(this);
      this.actor.synthetics.modifierAdjustments["weapon-damage"] = [{
        slug: this.slug,
        test: (options) => this.predicate.test(new Set(options)),
        getNewValue: (current) => current * this.value,
      }];
    }
  }
  class Feat {
    constructor() {
      this.slug = slug;
      this.sourceId = sourceId;
      this.actor = new Character();
      this.system = { rules: structuredClone(rules) };
      this._source = structuredClone(this.system);
    }
    getRollOptions() { return []; }
    prepareRuleElements() {
      return this.rules = this.system.rules.map((source) => source.key === "AdjustModifier"
        ? new AdjustModifier(source, this) : structuredClone(source));
    }
  }
  const context = vm.createContext({
    CONFIG: { PF2E: { Item: { documentClasses: { feat: Feat } }, Actor: { documentClasses: { character: Character, npc: NPC } } } },
    game: { settings: { get: () => enabled }, pf2e: { Predicate },
      get user() { throw new Error("automation must not read global user targets"); } },
    console,
  });
  for (const path of ["scripts/module/context.js", "scripts/features/barrows-edge.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "..", path), "utf8"), context);
  }
  const feature = context.pf2eEliottTools.features.barrowsEdge;
  feature.onInit();
  const feat = new Feat();
  const prepare = () => {
    feat.actor.synthetics.modifierAdjustments = {};
    for (const rule of feat.prepareRuleElements()) rule.beforePrepareData?.();
  };
  prepare();
  function damage(target, { dice = 2, manualToggle = false, spark = true, ikon = true, critical = false } = {}) {
    const options = new Set(target?.getSelfRollOptions("target") ?? []);
    if (manualToggle) options.add(manual);
    if (spark) options.add("divine-spark:barrows-edge");
    if (ikon) options.add("item:tag:physical-ikon:barrows-edge");
    const flat = feat.rules.find((rule) => rule.key === "FlatModifier");
    if (!new Predicate(...flat.predicate).test(options)) return 0;
    let value = dice;
    for (const adjustment of feat.actor.synthetics.modifierAdjustments["weapon-damage"] ?? []) {
      if (adjustment.slug === flat.slug && adjustment.test(options)) value = adjustment.getNewValue(value);
    }
    return value * (critical ? 2 : 1);
  }
  return { Actor, Character, NPC, feat, prepare, damage, feature, context, setEnabled: (value) => { enabled = value; } };
}

test("a target below half HP automatically triples spirit damage per weapon die", () => {
  const env = setup();
  for (const dice of [1, 2, 3, 4]) {
    assert.equal(env.damage(new env.NPC({ value: 49, max: 100 }), { dice }), 3 * dice);
    assert.equal(env.damage(new env.NPC({ value: 51, max: 100 }), { dice }), dice);
  }
});

test("half HP is strict, including odd maxima, zero HP and temporary HP", () => {
  const env = setup();
  for (const [value, max, expected] of [[50, 100, 2], [50, 101, 6], [51, 101, 2], [0, 100, 6]]) {
    assert.equal(env.damage(new env.NPC({ value, max, temp: 1000 })), expected);
  }
});

test("known target HP overrides both states of the manual toggle without multiplying twice", () => {
  const env = setup();
  for (const manualToggle of [true, false]) {
    assert.equal(env.damage(new env.NPC({ value: 49, max: 100 }), { manualToggle }), 6);
    assert.equal(env.damage(new env.NPC({ value: 100, max: 100 }), { manualToggle }), 2);
  }
});

test("target changes, healing and damage are read again for each roll", () => {
  const env = setup();
  const target = new env.NPC({ value: 60, max: 100 });
  assert.equal(env.damage(target), 2);
  target.system.attributes.hp.value = 40;
  assert.equal(env.damage(target), 6);
  assert.equal(env.damage(new env.NPC({ value: 100, max: 100 })), 2);
  target.system.attributes.hp.value = 80;
  assert.equal(env.damage(target), 2);
});

test("without a target or valid HP, the native manual toggle remains available", () => {
  const env = setup();
  for (const target of [null, new env.NPC(null), new env.NPC({ value: 0, max: 0 }),
    new env.NPC({ value: NaN, max: 100 }), new env.NPC({ value: 4, max: Infinity })]) {
    assert.equal(env.damage(target), 2);
    assert.equal(env.damage(target, { manualToggle: true }), 6);
  }
});

test("only the bound ikon with its active spark receives the native damage bonus", () => {
  const env = setup();
  const target = new env.NPC({ value: 1, max: 100 });
  assert.equal(env.damage(target, { spark: false }), 0);
  assert.equal(env.damage(target, { ikon: false }), 0);
  assert.equal(env.damage(target, { critical: true }), 12);
});

test("translated items are recognized by source UUID, unrelated feats are untouched", () => {
  const translated = setup({ slug: "translated", sourceId: "Compendium.pf2e.classfeatures.Item.LfgeEJgJdA8WAKV8" });
  assert.equal(translated.damage(new translated.NPC({ value: 1, max: 10 })), 6);
  const other = setup({ slug: "other-feat" });
  assert.equal(other.damage(new other.NPC({ value: 1, max: 10 })), 2);
});

test("preparation preserves saved rules, binding, and the original manual toggle", () => {
  const env = setup();
  for (let i = 0; i < 3; i++) {
    env.prepare();
    assert.equal(env.damage(new env.NPC({ value: 1, max: 10 })), 6);
    assert.deepEqual(env.feat.system, env.feat._source);
    assert.deepEqual(env.feat.rules.find((rule) => rule.key === "RollOption"), fixture.rules.find((rule) => rule.key === "RollOption"));
  }
  env.setEnabled(false);
  env.prepare();
  assert.equal(env.damage(new env.NPC({ value: 1, max: 10 })), 2);
  assert.equal(env.damage(new env.NPC({ value: 1, max: 10 }), { manualToggle: true }), 6);
});

test("disabling automation preserves native rule behavior and roll options", () => {
  const env = setup({ enabled: false });
  const target = new env.NPC({ value: 1, max: 10 });
  assert.deepEqual(target.getSelfRollOptions("target"), ["target:creature"]);
  assert.equal(env.damage(target), 2);
  assert.equal(env.damage(target, { manualToggle: true }), 6);
});

test("target options cover shared actor subclasses without changing self/origin options or actor data", () => {
  const env = setup();
  for (const Class of [env.NPC, env.Character]) {
    const target = new Class({ value: 1, max: 10 });
    const saved = structuredClone(target);
    assert.ok(target.getSelfRollOptions("target").includes(below));
    assert.ok(target.getSelfRollOptions("target").includes(known));
    assert.deepEqual(target.getSelfRollOptions(), ["self:creature"]);
    assert.deepEqual(target.getSelfRollOptions("origin"), ["origin:creature"]);
    assert.deepEqual(structuredClone(target), saved);
  }
});

test("idempotent initialization does not wrap or multiply twice", () => {
  const env = setup();
  const method = env.Actor.prototype.getSelfRollOptions;
  env.feature.onInit();
  assert.equal(env.Actor.prototype.getSelfRollOptions, method);
  env.prepare();
  const target = new env.NPC({ value: 1, max: 10 });
  assert.equal(target.getSelfRollOptions("target").filter((option) => option === below).length, 1);
  assert.equal(env.damage(target), 6);
});

test("custom extra predicates remain required and future changed multipliers are left native", () => {
  const rules = structuredClone(fixture.rules);
  rules.find((rule) => rule.key === "AdjustModifier").predicate.push("custom-requirement");
  const env = setup({ rules });
  assert.equal(env.damage(new env.NPC({ value: 1, max: 10 })), 2);
  rules.find((rule) => rule.key === "AdjustModifier").value = 4;
  const changed = setup({ rules });
  assert.ok(changed.feat.rules.find((rule) => rule.key === "AdjustModifier").predicate.includes(manual));
});
