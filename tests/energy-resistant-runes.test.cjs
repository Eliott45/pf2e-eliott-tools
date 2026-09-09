const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../scripts/features/energy-resistant-runes.js"), "utf8");
let nativeGetIWR;
if (process.env.PF2E_TEST_BUNDLE) {
  const bundle = readFileSync(process.env.PF2E_TEST_BUNDLE, "utf8");
  const start = bundle.indexOf("getIWR(e) {", bundle.indexOf("ResistanceRuleElement = class"));
  const end = bundle.indexOf("\n}, kc =", start);
  assert.ok(start >= 0 && end > start, "native Resistance.getIWR source found");
  nativeGetIWR = vm.runInNewContext(`({${bundle.slice(start, end)}}).getIWR`, {
    he: isDeepStrictEqual, Resistance: class { constructor(data) { Object.assign(this, data); } },
  });
}

function setup({ enabled = true, runes = ["fireResistant"] } = {}) {
  const errors = [];
  let calls = 0;
  class Resistance {
    constructor(data, options) {
      Object.assign(this, data);
      this.item = options.parent;
      this.label = this.item.name;
      this.options = options;
      this.exceptions = [];
      this.doubleVs = [];
      this.mode = "add";
    }
    get property() { return this.item.actor.system.attributes.resistances; }
    afterPrepareData() {
      if (nativeGetIWR) {
        this.property.push(...nativeGetIWR.call(this, this.value));
      } else {
        for (const type of this.type) {
          const existing = this.property.find((r) => r.type === type && !r.exceptions.length);
          if (existing) existing.value = Math.max(existing.value, this.value);
          else this.property.push({ type, value: this.value, exceptions: [], doubleVs: [], definition: null });
        }
      }
    }
  }
  class Armor {
    constructor() {
      this.name = "Кольчуга";
      this.isEquipped = true;
      this.isInvested = true;
      this.system = { runes: { property: runes }, rules: [{ key: "OtherRule" }] };
      this._source = structuredClone(this.system);
      this.actor = { canHostRuleElements: true, system: { attributes: { resistances: [] } } };
    }
    prepareRuleElements(options) {
      calls++;
      this.originalOptions = options;
      return this.rules = this.system.rules.map((rule) => ({ ...rule }));
    }
  }
  const context = vm.createContext({
    CONFIG: { PF2E: { Item: { documentClasses: { armor: Armor } } } },
    game: { pf2e: { RuleElements: { builtin: { Resistance } } }, settings: { get: () => enabled } },
    pf2eEliottTools: { module: { id: "test", logPrefix: "test", settings: {
      energyResistantRunesEnabled: "energyResistantRunesEnabled",
    } } },
    console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
  });
  vm.runInContext(source, context);
  const feature = context.pf2eEliottTools.features.energyResistantRunes;
  feature.onInit();
  const armor = new Armor();
  const prepare = (base = []) => {
    armor.actor.system.attributes.resistances = structuredClone(base);
    for (const rule of armor.prepareRuleElements()) rule.afterPrepareData?.();
    return armor.actor.system.attributes.resistances;
  };
  return { armor, prepare, feature, errors, setEnabled: (value) => { enabled = value; }, get calls() { return calls; } };
}

test("all eight rune variants grant the specified energy resistance regardless of armor name", () => {
  for (const type of ["acid", "cold", "electricity", "fire"]) {
    for (const greater of [false, true]) {
      const slug = greater ? `greater${type[0].toUpperCase()}${type.slice(1)}Resistant` : `${type}Resistant`;
      const env = setup({ runes: [slug] });
      const result = env.prepare();
      assert.equal(result.length, 1);
      assert.equal(result[0].type, type);
      assert.equal(result[0].value, greater ? 10 : 5);
      assert.deepEqual(env.errors, []);
    }
  }
});

test("different energies coexist and duplicate/base/greater runes never stack", () => {
  const env = setup({ runes: ["acidResistant", "fireResistant", "greaterFireResistant", "fireResistant"] });
  assert.deepEqual(env.prepare().map((r) => [r.type, r.value]), [["acid", 5], ["fire", 10]]);
});

test("unequipped, uninvested, disabled, and ineligible actors do not gain resistance", () => {
  for (const mode of ["unequipped", "uninvested", "disabled", "ineligible"]) {
    const env = setup();
    if (mode === "unequipped") env.armor.isEquipped = false;
    if (mode === "uninvested") env.armor.isInvested = false;
    if (mode === "disabled") env.setEnabled(false);
    if (mode === "ineligible") env.armor.actor.canHostRuleElements = false;
    assert.deepEqual(env.prepare(), [], mode);
    assert.equal(env.armor.rules.length, 1, "original rules remain intact");
  }
});

test("rune replacement, upgrade, removal and equipment changes recalculate without stale resistance", () => {
  const env = setup();
  assert.equal(env.prepare()[0].value, 5);
  env.armor.system.runes.property = ["greaterFireResistant"];
  assert.equal(env.prepare()[0].value, 10);
  env.armor.system.runes.property = ["coldResistant"];
  assert.deepEqual(env.prepare().map((r) => r.type), ["cold"]);
  env.armor.isEquipped = false;
  assert.deepEqual(env.prepare(), []);
  env.armor.isEquipped = true;
  assert.equal(env.prepare()[0].type, "cold");
  env.armor.system.runes.property = [];
  assert.deepEqual(env.prepare(), []);
});

test("repeated initialization/preparation preserves source data, native rules, and preparation options", () => {
  const env = setup();
  const saved = JSON.stringify(env.armor._source);
  const system = JSON.stringify(env.armor.system);
  env.feature.onInit();
  const options = { suppressWarnings: true };
  const rules = env.armor.prepareRuleElements(options);
  assert.equal(env.calls, 1);
  assert.equal(rules, env.armor.rules);
  assert.equal(rules[0].key, "OtherRule");
  assert.equal(rules[1].options.parent, env.armor);
  assert.equal(rules[1].options.suppressWarnings, true);
  assert.equal(env.armor.originalOptions, options);
  assert.equal(env.armor.prepareRuleElements().length, 2);
  assert.equal(JSON.stringify(env.armor._source), saved);
  assert.equal(JSON.stringify(env.armor.system), system);
});

test("unknown runes and runes removed from prepared data (slots/ABP) grant nothing", () => {
  const env = setup({ runes: ["fortification", "sonicResistant"] });
  assert.deepEqual(env.prepare(), []);
  env.armor._source.runes.property = ["greaterFireResistant"];
  env.armor.system.runes.property = [];
  assert.deepEqual(env.prepare(), []);
});

test("native Resistance merges with other sources using the maximum and preserves conditional entries", {
  skip: !nativeGetIWR && "Set PF2E_TEST_BUNDLE to check native PF2e stacking",
}, () => {
  for (const value of [3, 5, 15]) {
    const env = setup();
    const base = [{ type: "fire", value, exceptions: [], doubleVs: [], definition: null }];
    const result = env.prepare(base);
    assert.equal(result.length, 1);
    assert.equal(result[0].value, Math.max(value, 5));
  }
  const env = setup();
  const result = env.prepare([{ type: "fire", value: 15, exceptions: ["magical"], doubleVs: [], definition: null }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].value, 15);
  assert.equal(result[1].value, 5);
});
