const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { isDeepStrictEqual } = require("node:util");

const source = readFileSync(join(__dirname, "../scripts/features/weapon-familiarity.js"), "utf8");
const prefix = "eliott-weapon-familiarity-";

// The harness evaluates predicates and selects the highest applicable rank, as PF2e
// does when preparing a Strike. Fixture definitions mirror the system's feat rules.
class Predicate extends Array {
  constructor(statements) { super(...statements); this.isValid = true; }
  test(options) {
    const set = new Set(options);
    const evaluate = (statement) => {
      if (typeof statement === "string") return set.has(statement);
      if (statement.and) return statement.and.every(evaluate);
      if (statement.or) return statement.or.some(evaluate);
      if (statement.nor) return !statement.nor.some(evaluate);
      if (statement.nand) return !statement.nand.every(evaluate);
      if (statement.not) return !evaluate(statement.not);
      if (statement.if) return !evaluate(statement.if) || evaluate(statement.then);
      if (statement.gte) {
        const [key, minimum] = statement.gte;
        return [...set].some((option) => option.startsWith(`${key}:`)
          && Number(option.slice(key.length + 1)) >= minimum);
      }
      throw new Error(`Unsupported test predicate: ${JSON.stringify(statement)}`);
    };
    return this.every(evaluate);
  }
  static get [Symbol.species]() { return Array; }
}

// Optional integration check against the installed system (no Foundry world needed).
// Supply PF2E_TEST_BUNDLE with the path to pf2e.mjs. Use its real predicate evaluator,
// proficiency pruning, and Strike rank selection, instead of the lightweight harness.
let nativePreparation;
let nativeRank;
if (process.env.PF2E_TEST_BUNDLE) {
  const bundle = readFileSync(process.env.PF2E_TEST_BUNDLE, "utf8");
  function section(start, end) {
    const from = bundle.indexOf(start);
    const to = bundle.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `PF2e source section: ${start}`);
    return bundle.slice(from, to);
  }
  const native = vm.createContext({ console,
    P: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    he: isDeepStrictEqual,
    En: ["untrained", "trained", "expert", "master", "legendary"],
    CONFIG: { PF2E: { equivalentWeapons: {} } },
    createProficiencyModifier: ({ actor, rank }) => {
      const value = rank === 0 ? 0 : rank * 2 + (actor.withoutLevel ? 0 : actor.level);
      return { value, label: "Proficiency", signedValue: `+${value}` };
    },
  });
  vm.runInContext(`var Bn = ${section("class Predicate extends Array", ", AutomaticBonusProgression$1 = class")};`, native);
  vm.runInContext(`var preparation = ({${section("prepareMartialProficiencies() {", "\n\tasync toggleInvested(")}}).prepareMartialProficiencies;`, native);
  vm.runInContext(section("function getWeaponProficiencyRank(", "function createForceOpenPenalty("), native);
  Predicate = native.Bn;
  nativePreparation = native.preparation;
  nativeRank = native.getWeaponProficiencyRank;
}

function proficiency(rank, definition, extra = {}) {
  return { rank, definition: new Predicate(definition), label: "Axes", ...extra };
}

function setup({ enabled = true, mastery = 3, ancestry = "orc", withoutLevel = false } = {}) {
  const errors = [];
  let calls = 0;
  class Character {
    constructor() {
      this.level = 9;
      this.withoutLevel = withoutLevel;
      this._source = { name: "Gragur", system: { untouched: true } };
      this.system = { proficiencies: { attacks: {
        simple: { rank: 2 }, martial: { rank: 2 }, advanced: { rank: 1 },
        "advanced-ancestry": proficiency(1, ["item:category:advanced", `item:trait:${ancestry}`], {
          sameAs: "martial", label: "Advanced ancestry weapons",
        }),
        "martial-ancestry": proficiency(1, ["item:category:martial", `item:trait:${ancestry}`], {
          sameAs: "simple", label: "Martial ancestry weapons",
        }),
        "weapon-mastery-simple-martial": proficiency(mastery, [
          "item:group:axe", { or: ["item:category:simple", "item:category:martial", "item:category:unarmed"] },
        ]),
        "weapon-mastery-advanced": proficiency(mastery - 1, ["item:group:axe", "item:category:advanced"]),
      }, defenses: {} } };
      this.rules = ["advanced", "martial"].map((category) => ({
        key: "MartialProficiency", slug: `${category}-ancestry`,
        sameAs: category === "advanced" ? "martial" : "simple",
        item: { slug: `${ancestry}-weapon-familiarity` }, ignored: false,
      }));
    }
    prepareMartialProficiencies(...args) {
      calls++;
      if (nativePreparation) {
        nativePreparation.call(this);
        return args;
      }
      const attacks = this.system.proficiencies.attacks;
      for (const entry of Object.values(attacks)) {
        if (entry.sameAs) entry.rank = Math.min(attacks[entry.sameAs].rank,
          ["untrained", "trained", "expert", "master", "legendary"].indexOf(entry.maxRank ?? "legendary"));
        entry.value = entry.rank === 0 ? 0 : entry.rank * 2 + (withoutLevel ? 0 : this.level);
        entry.breakdown = `Proficiency +${entry.value}`;
      }
      return args;
    }
  }
  const game = { pf2e: { Predicate }, i18n: { localize: (key) => key },
    settings: { get: () => enabled } };
  const context = vm.createContext({ game,
    CONFIG: { PF2E: { Actor: { documentClasses: { character: Character } } } },
    pf2eEliottTools: { module: { id: "test", logPrefix: "test",
      settings: { weaponFamiliarityEnabled: "weaponFamiliarityEnabled" } } },
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
  });
  vm.runInContext(source, context);
  const feature = context.pf2eEliottTools.features.weaponFamiliarity;
  feature.onInit();
  const actor = new Character();
  const attacks = actor.system.proficiencies.attacks;
  function strike({ category = "advanced", group = "axe", trait = ancestry, options = [] } = {}) {
    const rollOptions = [`item:category:${category}`, `item:group:${group}`, `item:trait:${trait}`, ...options];
    const matches = Object.values(attacks).filter((entry) => entry.definition?.test(rollOptions));
    const rank = Math.max(attacks[category]?.rank ?? 0, ...matches.map((entry) => entry.rank));
    if (nativeRank) assert.equal(nativeRank(actor, { category, group, baseType: "butchering-axe" }, rollOptions), rank);
    return { rank, total: 4 + rank * 2 + (withoutLevel ? 0 : actor.level),
      entries: matches.filter((entry) => entry.rank === rank) };
  }
  return { actor, attacks, strike, feature, context, errors,
    setEnabled: (value) => { enabled = value; }, get calls() { return calls; } };
}

test("Orc Butchering Axe uses master +19 instead of expert +17; source data stays unchanged", () => {
  const env = setup();
  const originalData = JSON.stringify(env.actor._source);
  const definitions = JSON.stringify(Object.values(env.attacks).map((entry) => entry.definition));
  env.actor.prepareMartialProficiencies();
  const strike = env.strike();
  assert.equal(strike.rank, 3);
  assert.equal(strike.total, 19);
  assert.equal(strike.entries[0].value, 15);
  assert.equal(strike.entries[0].breakdown, "Proficiency +15");
  assert.equal(JSON.stringify(env.actor._source), originalData);
  assert.equal(JSON.stringify(Object.entries(env.attacks).filter(([key]) => !key.startsWith(prefix))
    .map(([, entry]) => entry.definition)), definitions);
  assert.deepEqual(env.errors, []);
});

test("only the familiar ancestry and mastered weapon group receive the promotion", () => {
  const env = setup();
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike({ trait: "dwarf" }).rank, 2);
  assert.equal(env.strike({ group: "sword" }).rank, 2);
  assert.equal(env.strike({ group: "sword", trait: "dwarf" }).rank, 1);
  assert.equal(env.strike({ category: "martial", trait: "dwarf" }).rank, 3);
});

test("disabled fix preserves the system's expert +17 result", () => {
  const env = setup({ enabled: false });
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 2);
  assert.equal(env.strike().total, 17);
  assert.equal(Object.keys(env.attacks).some((key) => key.startsWith(prefix)), false);
});

test("the same rules support dwarf familiarity and legendary mastery", () => {
  const env = setup({ ancestry: "dwarf", mastery: 4 });
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 4);
  assert.equal(env.strike({ trait: "orc" }).rank, 3);
});

test("no feat, unrelated feat, or ignored rule cannot grant mastery", () => {
  for (const mode of ["missing", "unrelated", "ignored"]) {
    const env = setup();
    if (mode === "missing") env.actor.rules = [];
    if (mode === "unrelated") env.actor.rules.forEach((rule) => { rule.item.slug = "other-feat"; });
    if (mode === "ignored") env.actor.rules.forEach((rule) => { rule.ignored = true; });
    env.actor.prepareMartialProficiencies();
    assert.equal(env.strike().rank, 2, mode);
  }
});

test("rank limits and proficiency without level use the system's value calculation", () => {
  const env = setup({ mastery: 4, withoutLevel: true });
  env.attacks["advanced-ancestry"].maxRank = "master";
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 3);
  assert.equal(env.strike().entries[0].value, 6);
  assert.equal(env.strike().total, 10);
});

test("repeated preparation, level progression, removal, and disabling leave no stale entries", () => {
  const env = setup();
  env.feature.onInit();
  assert.deepEqual(env.actor.prepareMartialProficiencies("argument"), ["argument"]);
  const count = Object.keys(env.attacks).length;
  env.actor.prepareMartialProficiencies();
  assert.equal(env.calls, 2);
  assert.equal(Object.keys(env.attacks).length, count);
  env.attacks["weapon-mastery-simple-martial"].rank = 4;
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 4);
  env.actor.rules = [];
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 2);
  env.setEnabled(false);
  env.actor.prepareMartialProficiencies();
  assert.equal(Object.keys(env.attacks).some((key) => key.startsWith(prefix)), false);
});

test("familiarity does not chain advanced -> martial -> simple", () => {
  const env = setup();
  env.attacks["weapon-mastery-simple-martial"].definition = new Predicate(["item:group:axe", "item:category:simple"]);
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 2);
  assert.equal(env.strike({ category: "martial" }).rank, 3);
});

test("nested category exclusions and other weapon conditions remain effective", () => {
  const env = setup();
  env.attacks["weapon-mastery-simple-martial"].definition = new Predicate([
    "item:group:axe", "item:category:martial", { not: "item:category:advanced" },
    { or: ["item:trait:agile", "item:trait:finesse"] }, { gte: ["item:level", 2] },
  ]);
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 2);
  assert.equal(env.strike({ options: ["item:trait:agile", "item:level:1"] }).rank, 2);
  assert.equal(env.strike({ options: ["item:trait:agile", "item:level:2"] }).rank, 3);
});

test("higher native proficiency is never reduced or added as a flat bonus", () => {
  const env = setup();
  env.attacks["native-fix"] = proficiency(4, ["item:group:axe", "item:trait:orc", "item:category:advanced"]);
  env.actor.prepareMartialProficiencies();
  assert.equal(env.strike().rank, 4);
  assert.equal(env.strike().total, 21);
});
