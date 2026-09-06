const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const moduleId = "pf2e-eliott-tools";
const clone = (value) => JSON.parse(JSON.stringify(value));
function actor(overrides = {}) {
  return { type: "npc", uuid: "Actor.goblin", name: "Гоблин воин", img: "goblin.webp",
    _stats: { compendiumSource: "Compendium.pf2e.monsters.Actor.goblin" },
    system: { details: { level: { value: 1 }, publicNotes: '<p>Наблюдение</p><section class="secret">СЕКРЕТ</section>', privateNotes: "GM ONLY" },
      traits: { value: ["goblin"], size: { value: "sm" }, rarity: "common" },
      saves: { fortitude: { value: 4 }, reflex: { value: 7 }, will: { value: 3 } },
      attributes: { ac: { value: 16 }, hp: { value: 2, max: 20 }, speed: { value: 25 }, weaknesses: [{ type: "fire", value: 5 }], resistances: [{ type: "physical", value: 3, exceptions: ["silver"] }] } },
    items: [{ id: "bite", name: "Укус", type: "melee", system: { bonus: { value: 8 }, damageRolls: { x: { damage: "1d6+2", damageType: "piercing" } }, traits: { value: ["agile"] } } }, { id: "reaction", name: "Секретный прыжок", type: "action", system: { actionType: { value: "reaction" }, description: { value: "Скрытая способность" } } }], ...overrides };
}
function setup() {
  let counter = 0;
  let failPublish = false;
  const journal = []; journal.get = (id) => journal.find((doc) => doc.id === id);
  const folders = [];
  const gm = { id: "gm", isGM: true, active: true };
  const game = { journal, folders, user: gm, users: { activeGM: gm }, i18n: { localize: (s) => s } };
  function document(input) {
    const doc = { ...clone(input), id: `doc${++counter}`,
      getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
      testUserPermission(user, level) { return user.isGM || (this.ownership?.default ?? 0) >= ({ OBSERVER: 2, OWNER: 3 }[level]); },
      async update(change) {
        if (this.getFlag(moduleId, "bestiary")?.kind === "entry" && failPublish) { failPublish = false; throw new Error("offline"); }
        for (const [key, value] of Object.entries(change)) {
          const path = key.split("."); let target = this;
          for (const part of path.slice(0, -1)) target = target[part] ??= {};
          target[path.at(-1)] = clone(value);
        }
        return this;
      } };
    doc.pages = (input.pages ?? []).map(document);
    return doc;
  }
  const context = vm.createContext({
    pf2eEliottTools: { module: { id: moduleId }, features: {} }, game, CONFIG: { PF2E: {} },
    foundry: { utils: { deepClone: clone }, applications: { api: { ApplicationV2: class {} } } },
    JournalEntry: { create: async (data) => { const doc = document(data); journal.push(doc); return doc; },
      deleteDocuments: async (ids) => { for (let i = journal.length - 1; i >= 0; i--) if (ids.includes(journal[i].id)) journal.splice(i, 1); } },
    Folder: { create: async (data) => { const doc = document(data); folders.push(doc); return doc; } },
    fromUuid: async () => null, console,
  });
  for (const file of ["model", "store", "application"]) vm.runInContext(readFileSync(join(__dirname, `../scripts/features/bestiary/${file}.js`), "utf8"), context);
  return { context, game, feature: context.pf2eEliottTools.features.bestiary, fail: () => { failPublish = true; } };
}
test("snapshot is independent, records max HP, attacks and IWR exceptions, strips GM descriptions", () => {
  const { feature } = setup(); const source = actor(); const snapshot = feature.model.snapshot(source);
  source.system.attributes.hp.max = 999; source.items[0].name = "changed";
  assert.equal(snapshot.fields.find((f) => f.id === "hp").value, "20");
  assert.equal(snapshot.fields.find((f) => f.id === "item-bite").label, "Укус");
  assert.match(snapshot.fields.find((f) => f.id === "resistances-physical-0").value, /silver/);
  assert.doesNotMatch(JSON.stringify(snapshot), /СЕКРЕТ|GM ONLY/);
});
test("player projection always includes name but omits hidden fields, source identifiers and ability count", () => {
  const { feature } = setup(); const snapshot = feature.model.snapshot(actor());
  const projected = feature.model.project({ snapshot, revealed: ["ac"], alias: "Кто-то" });
  assert.equal(projected.name, "Гоблин воин"); assert.equal(projected.fields.length, 1);
  assert.doesNotMatch(JSON.stringify(projected), /Actor\.|Compendium\.|Секретный|goblin.webp|20/);
});
test("same compendium creature and repeated concurrent adds reuse one durable entry", async () => {
  const { feature, game } = setup();
  const [first, second] = await Promise.all([feature.store.addActor(actor()), feature.store.addActor(actor({ uuid: "Scene.test.Token.other.Actor.synthetic" }))]);
  assert.equal(first.doc.id, second.doc.id); assert.equal(second.existing, true);
  assert.equal(game.journal.length, 2);
  const data = feature.store.data(first.doc);
  assert.equal(first.doc.ownership.default, 0);
  assert.equal(game.journal.get(data.publicId).ownership.default, 2);
  assert.equal(game.journal.get(data.publicId).pages[0].ownership.default, 3);
  await assert.rejects(feature.store.refresh(first.doc), /Источник удалён/);
  assert.equal(feature.store.data(first.doc).snapshot.name, "Гоблин воин");
});
test("homebrew synthetic tokens use base actor identity; elite and explicit variants stay separate", async () => {
  const { feature } = setup();
  const homebrew = actor({ _stats: {}, uuid: "Scene.test.Token.one.Actor.synthetic", token: { baseActor: { uuid: "Actor.homebrew" } } });
  const a = await feature.store.addActor(homebrew);
  const b = await feature.store.addActor({ ...homebrew, uuid: "Scene.test.Token.two.Actor.synthetic" });
  assert.equal(a.doc.id, b.doc.id);
  const c = await feature.store.addActor(homebrew, { separate: true }); assert.notEqual(c.doc.id, a.doc.id);
  homebrew.system.attributes.adjustment = "elite";
  const elite = await feature.store.addActor(homebrew); assert.notEqual(elite.doc.id, a.doc.id);
});
test("hiding a previously published field removes its value from the public document", async () => {
  const { feature, game } = setup(); const { doc } = await feature.store.addActor(actor());
  await feature.store.update(doc, (entry) => ({ ...entry, revealed: ["name", "hp", "item-reaction"] }));
  const publicDoc = game.journal.get(feature.store.data(doc).publicId);
  assert.match(JSON.stringify(feature.store.data(publicDoc)), /Секретный/);
  await feature.store.update(doc, (entry) => ({ ...entry, revealed: [] }));
  assert.doesNotMatch(JSON.stringify(feature.store.data(publicDoc)), /Секретный|Скрытая способность/);
  assert.equal(publicDoc.name, "Гоблин воин");
});
test("refresh retains revealed unchanged facts and notes, hides changed and new facts", () => {
  const { feature } = setup(); const snapshot = feature.model.snapshot(actor());
  const entry = { snapshot, publicId: "notes-link", alias: "Зелёный", revealed: ["name", "image", "ac", "hp"] };
  const next = clone(snapshot); next.fields.find((f) => f.id === "hp").value = "100";
  const updated = feature.model.refresh(entry, next);
  assert.deepEqual(Array.from(updated.revealed), ["name", "image", "ac"]);
  assert.equal(updated.publicId, "notes-link"); assert.equal(updated.alias, "Зелёный");
});
test("player cannot modify source; secondary GM cannot race the main GM", async () => {
  const { feature, game } = setup(); const { doc } = await feature.store.addActor(actor());
  game.user = { id: "player", isGM: false };
  await assert.rejects(feature.store.addActor(actor()), /мастеру/);
  await assert.rejects(feature.store.update(doc, (e) => e), /мастеру/);
  game.user = { id: "other-gm", isGM: true };
  await assert.rejects(feature.store.addActor(actor()), /основной активный мастер/);
});
test("interrupted publication can be repaired without losing shared notes", async () => {
  const env = setup(); const { feature, game } = env; const { doc } = await feature.store.addActor(actor());
  const publicDoc = game.journal.get(feature.store.data(doc).publicId);
  await feature.store.saveNotes(publicDoc, "Наблюдение", "");
  env.fail();
  await assert.rejects(feature.store.update(doc, (entry) => ({ ...entry, revealed: ["name"] })), /offline/);
  await feature.store.repair();
  assert.equal(publicDoc.name, "Гоблин воин"); assert.match(publicDoc.pages[0].text.content, /Наблюдение/);
});
test("player notes escape markup and detect an intervening edit", async () => {
  const { feature, game } = setup(); const { doc } = await feature.store.addActor(actor());
  const publicDoc = game.journal.get(feature.store.data(doc).publicId);
  game.user = { id: "player", isGM: false };
  await feature.store.saveNotes(publicDoc, '<img src=x onerror="alert(1)">', "");
  assert.doesNotMatch(publicDoc.pages[0].text.content, /<img/);
  await assert.rejects(feature.store.saveNotes(publicDoc, "overwrite", ""), /другой участник/);
});
test("player UI and search never use the hidden snapshot", async () => {
  const { feature, game } = setup(); await feature.store.addActor(actor());
  game.user = { id: "player", isGM: false };
  const app = new feature.Application();
  assert.match(app.content(), /Гоблин воин/);
  assert.doesNotMatch(app.content(), /Секретный|Атака \+8|data-alias|Обновить из источника/);
  app.query = "goblin"; assert.match(app.content(), /Ничего не найдено/);
  game.user = { id: "gm", isGM: true }; app.preview = true;
  assert.match(app.content(), /Ничего не найдено/);
});

test("saved glossary references resolve recursively and translated HTML remains plain text", () => {
  const { feature, game } = setup();
  const translations = {
    "PF2E.NPC.Abilities.Glossary.FastHealing": "<p>Восстанавливает ОЗ. @Localize[Nested]</p><section class='secret'>СЕКРЕТ</section>",
    Nested: "<strong>В начале хода.</strong>", Cycle: "@Localize[Cycle]", A: "@Localize[B]", B: "@Localize[A]",
  };
  game.i18n.localize = (key) => translations[key] ?? key;
  const displayed = feature.store.displayField({ id: "healing", label: "Исцеление", value: "@Localize[PF2E.NPC.Abilities.Glossary.FastHealing]" });
  assert.equal(displayed.value, "Восстанавливает ОЗ. В начале хода.");
  const source = actor(); source.items[1].system.description.value = "@Localize[PF2E.NPC.Abilities.Glossary.FastHealing]";
  const saved = feature.model.snapshot(source).fields.find((field) => field.id === "item-reaction");
  assert.match(saved.value, /@Localize/);
  assert.equal(feature.store.displayField(saved).value, "Восстанавливает ОЗ. В начале хода.");
  assert.doesNotMatch(feature.model.plain("@Localize[Cycle] @Localize[A] @Localize[Missing]"), /@Localize|СЕКРЕТ/);
});

test("legacy alignment traits are translated in existing snapshots and configured traits use current locale", () => {
  const { feature, game, context } = setup();
  game.i18n.lang = "ru";
  context.CONFIG.PF2E.creatureTraits = { demon: "PF2E.TraitDemon" };
  game.i18n.localize = (key) => key === "PF2E.TraitDemon" ? "Демон" : key;
  const displayed = feature.store.displayField({ id: "traits", label: "Признаки", value: "chaotic, Demon, evil, Нечестивый" });
  assert.equal(displayed.value, "Хаотичный, Демон, Злой, Нечестивый");
  assert.equal(feature.store.localize("creatureTraits", "custom-trait"), "custom-trait");
});

test("spell links open original sheets inside Foundry; hidden spells cannot be opened", async () => {
  const { feature, game, context } = setup();
  const caster = actor({ items: [
    { id: "casting", type: "spellcastingEntry", name: "Врождённые заклинания", system: { spelldc: { dc: 22, value: 12 } } },
    { id: "spell1", type: "spell", name: "Тьма", rank: 4, _stats: { compendiumSource: "Compendium.pf2e.spells-srd.Item.darkness" }, system: { level: { value: 2 }, description: { value: "ПОЛНОЕ ОПИСАНИЕ ЗАКЛИНАНИЯ" } } },
  ] });
  const { doc } = await feature.store.addActor(caster);
  const snapshot = feature.store.data(doc).snapshot;
  assert.equal(snapshot.fields.filter((field) => field.group === "spells").length, 1);
  assert.equal(snapshot.fields.find((field) => field.spell).spell.rank, 4);
  const app = new feature.Application();
  assert.match(app.content(), /class="content-link eb-spell-link"[^>]*>.*Тьма/);
  assert.match(app.content(), /Ранг 4/);
  assert.doesNotMatch(app.content(), /ПОЛНОЕ ОПИСАНИЕ ЗАКЛИНАНИЯ|КС 22/);
  game.user = { id: "player", isGM: false };
  assert.doesNotMatch(app.content(), /Тьма|darkness|ПОЛНОЕ/);
  game.user = game.users.activeGM;
  await feature.store.update(doc, (entry) => ({ ...entry, revealed: ["item-spell1"] }));
  game.user = { id: "player", isGM: false };
  assert.match(app.content(), /Тьма/); assert.doesNotMatch(app.content(), /ПОЛНОЕ/);
  assert.equal(feature.store.data(game.journal.get(feature.store.data(doc).publicId)).projection.fields[0].spell.uuid, "Compendium.pf2e.spells-srd.Item.darkness");
  app.render = async () => {};
  let opened = 0; let raised = 0; const resolved = [];
  const sheet = new context.foundry.applications.api.ApplicationV2();
  sheet.render = async (options) => {
    assert.equal(options.force, true); assert.equal(options.window.detached, false); opened++;
  };
  sheet.bringToFront = () => { raised++; };
  context.fromUuid = async (uuid) => {
    resolved.push(uuid);
    return { type: "spell", testUserPermission: (_user, level) => level === "LIMITED", sheet };
  };
  const spellButton = { dataset: { command: "spell", field: "item-spell1" } };
  const toggleButton = { dataset: { command: "spell-toggle", field: "item-spell1" } };
  await app.command(toggleButton);
  assert.match(app.content(), /aria-expanded="true"/);
  assert.match(app.content(), /eb-spell-description">ПОЛНОЕ ОПИСАНИЕ ЗАКЛИНАНИЯ/);
  assert.equal(opened, 0); assert.equal(resolved.length, 0);
  await app.command(spellButton);
  assert.equal(opened, 1); assert.equal(raised, 1);
  assert.deepEqual(resolved, ["Compendium.pf2e.spells-srd.Item.darkness"]);
  assert.match(app.content(), /eb-spell-description">ПОЛНОЕ ОПИСАНИЕ ЗАКЛИНАНИЯ/);
  await app.command(toggleButton);
  assert.match(app.content(), /aria-expanded="false"/);
  assert.doesNotMatch(app.content(), /ПОЛНОЕ/);
  assert.equal(opened, 1);
  await app.command(toggleButton);
  // ApplicationV1 returns before creating its element. Focus must be scheduled
  // by render, rather than calling bringToTop against an absent DOM element.
  let finishLegacyRender;
  context.fromUuid = async () => ({ type: "spell", testUserPermission: () => true,
    sheet: { render(force, options) {
      assert.equal(force, true); assert.equal(options.focus, true); opened++;
      finishLegacyRender = () => { raised++; };
      return this;
    }, bringToTop: () => assert.fail("Cannot focus ApplicationV1 before its element exists") } });
  await app.command(spellButton);
  assert.equal(opened, 2); assert.equal(raised, 1);
  finishLegacyRender();
  assert.equal(opened, 2); assert.equal(raised, 2);
  game.user = game.users.activeGM;
  await feature.store.update(doc, (entry) => ({ ...entry, revealed: [] }));
  game.user = { id: "player", isGM: false };
  await app.command(spellButton);
  await app.command(toggleButton);
  assert.equal(opened, 2);
  assert.doesNotMatch(app.content(), /Тьма|ПОЛНОЕ|eb-spell-description/);
});

test("Russian units and conditions retain readable labels in saved and localized descriptions", () => {
  const { feature, game } = setup();
  const text = "Дистанция до @Unit[Mile|1]{1 мили}. Видит @Condition[Invisible]{Невидимых}.";
  assert.equal(feature.model.plain(text), "Дистанция до 1 мили. Видит Невидимых.");
  game.i18n.localize = (key) => key === "Spell.Description" ? `<p>${text}</p>` : key;
  assert.equal(feature.model.plain("@Localize[Spell.Description]"), "Дистанция до 1 мили. Видит Невидимых.");
  const stored = feature.model.spellField({ id: "spell", name: "Переход", system: { description: { value: text } } });
  assert.doesNotMatch(stored.value, /@Unit|@Condition/);
  assert.equal(feature.store.displayField({ id: "legacy", label: "Старая запись", value: text }).value, stored.value);
});

test("unavailable or forbidden original spells show a saved fallback inside Foundry", async () => {
  const { feature, context, game } = setup();
  const { doc } = await feature.store.addActor(actor({ items: [{ id: "s", type: "spell", name: "Переход",
    _stats: { compendiumSource: "Compendium.pf2e.spells-srd.Item.missing" },
    system: { level: { value: 5 }, description: { value: "@Unit[Mile|1]{1 мили}" } } }] }));
  await feature.store.update(doc, (entry) => ({ ...entry, revealed: ["item-s"] }));
  game.user = { id: "player", isGM: false };
  const app = new feature.Application(); app.content(); app.render = async () => {};
  const dialogs = [];
  context.foundry.applications.api.DialogV2 = { wait: async (options) => { dialogs.push(options); } };
  await app.command({ dataset: { command: "spell", field: "item-s" } });
  assert.match(dialogs[0].content, /1 мили/); assert.doesNotMatch(dialogs[0].content, /@Unit/);
  context.fromUuid = async () => ({ type: "spell", testUserPermission: () => false,
    sheet: { render: () => assert.fail("Must not open a forbidden original") } });
  await app.command({ dataset: { command: "spell", field: "item-s" } });
  assert.equal(dialogs.length, 2);
});

test("old spell cards migrate without refreshing stats, rank, notes or revealed knowledge", async () => {
  const { feature, context, game } = setup(); const { doc } = await feature.store.addActor(actor());
  const entry = feature.store.data(doc); delete entry.snapshot.presentationVersion;
  entry.snapshot.fields.push({ id: "item-spell1", group: "spells", label: "Тьма · ранг 4", value: "Сохранённое описание" },
    { id: "item-casting", group: "spells", label: "Врождённые заклинания", value: "КС 22" });
  entry.revealed = ["name", "ac", "item-spell1", "item-casting"];
  const publicDoc = game.journal.get(entry.publicId);
  await feature.store.saveNotes(publicDoc, "Наша заметка", "");
  context.fromUuid = async () => actor({ items: [{ id: "spell1", type: "spell", name: "Новое имя", rank: 9, _stats: { compendiumSource: "Compendium.pf2e.spells-srd.Item.darkness" }, system: { description: { value: "НОВЫЙ СЕКРЕТ" } } }] });
  await feature.store.repair();
  const migrated = feature.store.data(doc);
  assert.equal(migrated.snapshot.fields.find((f) => f.id === "ac").value, "16");
  const spell = migrated.snapshot.fields.find((f) => f.id === "item-spell1");
  assert.equal(spell.spell.rank, 4); assert.equal(spell.label, "Тьма"); assert.equal(spell.value, "Сохранённое описание");
  assert.deepEqual(Array.from(migrated.revealed), ["name", "ac", "item-spell1"]);
  assert.match(publicDoc.pages[0].text.content, /Наша заметка/);
  assert.doesNotMatch(JSON.stringify(feature.store.data(publicDoc)), /НОВЫЙ СЕКРЕТ|Новое имя/);
});

test("a removed custom spell source retains a readable saved fallback without an actor link", () => {
  const { feature } = setup();
  const spell = feature.model.spellField({ id: "s", type: "spell", uuid: "Actor.secret.Item.s", name: "Своё заклинание", system: { level: { value: 3 }, description: { value: "Описание" } } });
  assert.equal(spell.spell.uuid, null);
  const snapshot = feature.model.snapshot(actor()); delete snapshot.presentationVersion;
  snapshot.fields.push({ id: "item-s", group: "spells", label: "Своё заклинание · ранг 3", value: "Описание" });
  const updated = feature.model.upgrade({ snapshot, revealed: ["item-s"] }, null);
  assert.equal(updated.snapshot.fields.at(-1).spell.uuid, null);
  assert.equal(updated.snapshot.fields.at(-1).value, "Описание");
});

test("traits, senses, speeds and languages reveal independently and survive list reordering", async () => {
  const { feature, game } = setup(); const source = actor();
  source.system.traits.value = ["goblin", "humanoid"];
  source.system.perception = { senses: [{ type: "darkvision" }, { type: "scent", acuity: "imprecise", range: 30 }] };
  source.system.attributes.speed = { value: 25, otherSpeeds: [{ type: "fly", value: 40 }, { type: "swim", value: 20 }] };
  source.system.details.languages = { value: ["common", "goblin"], details: "Не может говорить" };
  const { doc } = await feature.store.addActor(source);
  const fields = feature.store.data(doc).snapshot.fields;
  const chosen = ["traits", "senses", "speed", "languages"].map((category) => fields.find((f) => f.id.startsWith(category + "-")).id);
  assert.equal(fields.filter((f) => f.id.startsWith("senses-")).length, 2);
  assert.match(fields.find((f) => f.value.includes("scent")).value, /imprecise.*30 фт/);
  assert.equal(fields.filter((f) => f.id.startsWith("speed-")).length, 3);
  assert.equal(fields.filter((f) => f.id.startsWith("languages-")).length, 3);
  await feature.store.update(doc, (entry) => ({ ...entry, revealed: chosen }));
  const projected = feature.store.data(game.journal.get(feature.store.data(doc).publicId)).projection;
  assert.deepEqual(clone(projected.fields.map((f) => f.id)).sort(), [...chosen].sort());
  assert.doesNotMatch(JSON.stringify(projected), /humanoid|scent|imprecise|fly|swim|Не может говорить/);
  source.system.traits.value.reverse(); source.system.perception.senses.reverse(); source.system.details.languages.value.reverse();
  source.system.attributes.speed.otherSpeeds.reverse();
  const refreshed = feature.model.refresh(feature.store.data(doc), feature.model.snapshot(source));
  assert.deepEqual(clone(refreshed.revealed), chosen);
  game.user = { id: "player", isGM: false };
  const app = new feature.Application(); app.query = "humanoid";
  assert.match(app.content(), /Ничего не найдено/);
  app.query = "goblin"; assert.doesNotMatch(app.content(), /Ничего не найдено/);
});

test("empty lists have independently revealable absence, distinct from hidden knowledge", () => {
  const { feature } = setup(); const source = actor();
  source.system.traits.value = [];
  source.system.attributes.weaknesses = []; source.system.attributes.resistances = []; delete source.system.attributes.speed;
  const snapshot = feature.model.snapshot(source);
  for (const category of ["traits", "senses", "speed", "languages", "weaknesses", "resistances", "immunities"]) {
    assert.equal(snapshot.fields.find((f) => f.id === `${category}-none`).value, "Нет");
  }
  const entry = { snapshot, revealed: [] };
  assert.equal(feature.model.project(entry).fields.length, 0);
  entry.revealed = ["languages-none", "immunities-none"];
  assert.equal(feature.model.project(entry).fields.length, 2);
  assert.ok(feature.model.project(entry).fields.every((f) => f.value === "Нет"));
  source.system.details.languages = { value: [], details: "Понимает речь, но не говорит" };
  assert.ok(!feature.model.snapshot(source).fields.some((f) => f.id === "languages-none"));
});

test("legacy combined lists migrate revelation without refreshing saved stats; new languages stay hidden", async () => {
  const { feature, context, game } = setup(); const { doc } = await feature.store.addActor(actor());
  const entry = feature.store.data(doc);
  entry.snapshot.presentationVersion = 2;
  entry.snapshot.fields = entry.snapshot.fields.filter((f) => !/^(traits|senses|speed|languages|immunities)-/.test(f.id));
  entry.snapshot.fields.push({ id: "traits", group: "overview", label: "Признаки", value: "goblin, humanoid" },
    { id: "senses", group: "overview", label: "Чувства", value: "darkvision, scent 30 фт" },
    { id: "speed", group: "overview", label: "Скорость", value: "25 фт, fly 40 фт" });
  entry.revealed = ["traits", "speed", "ac"];
  const source = actor(); source.system.attributes.ac.value = 99;
  source.system.details.languages = { value: ["common", "goblin"] };
  context.fromUuid = async () => source;
  const publicDoc = game.journal.get(entry.publicId); await feature.store.saveNotes(publicDoc, "Заметка", "");
  await feature.store.repair();
  const updated = feature.store.data(doc);
  assert.equal(updated.snapshot.presentationVersion, 3);
  const projection = feature.model.project(updated);
  assert.equal(projection.fields.filter((f) => f.id.startsWith("traits-")).length, 2);
  assert.equal(projection.fields.filter((f) => f.id.startsWith("speed-")).length, 2);
  assert.ok(!projection.fields.some((f) => /^(senses|languages|immunities)-/.test(f.id)));
  assert.equal(projection.fields.find((f) => f.id === "ac").value, "16");
  assert.equal(updated.snapshot.fields.filter((f) => f.id.startsWith("languages-")).length, 2);
  assert.match(publicDoc.pages[0].text.content, /Заметка/);
  const before = JSON.stringify(updated); await feature.store.repair();
  assert.equal(JSON.stringify(feature.store.data(doc)), before);
});

test("migration cannot mistake unavailable legacy languages for absence", () => {
  const { feature } = setup(); const snapshot = feature.model.snapshot(actor());
  snapshot.presentationVersion = 2; snapshot.fields = snapshot.fields.filter((f) => !f.id.startsWith("languages-"));
  const entry = feature.model.upgrade({ snapshot, revealed: [] }, null);
  assert.ok(!entry.snapshot.fields.some((f) => f.id === "languages-none"));
  assert.match(entry.snapshot.fields.find((f) => f.id === "languages-unknown").value, /недоступен/);
  assert.equal(feature.model.project(entry).fields.length, 0);
});

test("reset deletes only marked bestiary documents and embedded notes, including orphan cards", async () => {
  const { feature, context, game } = setup(); const { doc } = await feature.store.addActor(actor());
  const publicDoc = game.journal.get(feature.store.data(doc).publicId);
  await feature.store.saveNotes(publicDoc, "Удаляемая заметка", "");
  const unrelated = await context.JournalEntry.create({ name: "Бестиарий группы", flags: {} });
  const otherFeature = await context.JournalEntry.create({ flags: { [moduleId]: { bestiary: { kind: "other" } } } });
  await context.JournalEntry.create({ flags: { [moduleId]: { bestiary: { kind: "entry", projection: {} } } } });
  game.user = { id: "player", isGM: false };
  await assert.rejects(feature.store.reset(), /мастеру/);
  game.user = { id: "secondary", isGM: true };
  await assert.rejects(feature.store.reset(), /основной активный мастер/);
  game.user = game.users.activeGM;
  assert.equal(await feature.store.reset(), 3);
  assert.deepEqual(game.journal.map((d) => d.id), [unrelated.id, otherFeature.id]);
  await feature.store.repair(); assert.equal(game.journal.length, 2);
  assert.equal(await feature.store.reset(), 0);
});

test("reset macro is created once for GM and API requires confirmation before deleting", async () => {
  const { feature, context, game } = setup(); await feature.store.addActor(actor());
  const hooks = {};
  context.Hooks = { once: (key, fn) => { hooks[key] = fn; }, on: () => {} };
  game.settings = { get: () => true }; const module = {};
  game.modules = { get: () => module }; game.macros = [];
  context.Macro = { create: async (input) => { game.macros.push({ ...input, getFlag: (scope, key) => input.flags[scope][key] }); } };
  const errors = []; context.ui = { notifications: { info: () => {}, error: (message) => errors.push(message) } };
  let accepted = false; let prompts = 0;
  context.foundry.applications.api.DialogV2 = { confirm: async () => { prompts++; return accepted; } };
  const index = readFileSync(join(__dirname, "../scripts/features/bestiary/index.js"), "utf8");
  vm.runInContext(index, context); hooks.ready();
  assert.equal(game.macros.length, 1); assert.equal(game.macros[0].ownership.default, 0);
  assert.match(game.macros[0].command, /await bestiary.reset\(\)/);
  vm.runInContext(index, context); hooks.ready(); assert.equal(game.macros.length, 1);
  await feature.store.repair(); // Drain startup publication before testing destructive operations.
  assert.equal(await module.api.bestiary.reset(), false); assert.equal(game.journal.length, 2);
  accepted = true;
  assert.equal(await module.api.bestiary.reset(), true); assert.equal(game.journal.length, 0);
  assert.equal(prompts, 2); assert.deepEqual(errors, []);
});

test("a reset during startup repair cannot resurrect deleted cards", async () => {
  const { feature, game } = setup();
  await feature.store.addActor(actor()); await feature.store.addActor(actor(), { separate: true });
  const publicDoc = feature.store.publicEntries()[0];
  const update = publicDoc.update.bind(publicDoc);
  let release; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  publicDoc.update = async (change) => { entered(); await paused; return update(change); };
  const repair = feature.store.repair(); await started;
  const reset = feature.store.reset(); release();
  await Promise.all([repair, reset]);
  assert.equal(game.journal.length, 0);
});

test("removing one creature deletes its notes, preserves other entries, and rejects stale edits", async () => {
  const { feature, game, context } = setup();
  const source = actor(); const original = clone(source);
  const { doc } = await feature.store.addActor(source);
  const other = await feature.store.addActor(source, { separate: true });
  const publicId = feature.store.data(doc).publicId;
  await feature.store.saveNotes(game.journal.get(publicId), "Удаляемая заметка", "");
  const keepId = feature.store.data(other.doc).publicId;
  await feature.store.saveNotes(game.journal.get(keepId), "Сохранить заметку", "");
  const unrelated = await context.JournalEntry.create({ name: "Обычный журнал" });
  game.user = { id: "player", isGM: false };
  await assert.rejects(feature.store.remove(doc), /мастеру/);
  game.user = { id: "secondary", isGM: true };
  await assert.rejects(feature.store.remove(doc), /основной активный мастер/);
  game.user = game.users.activeGM;
  await assert.rejects(feature.store.remove(unrelated), /недоступна/);
  await feature.store.remove(doc);
  assert.equal(game.journal.get(doc.id), undefined); assert.equal(game.journal.get(publicId), undefined);
  assert.equal(game.journal.length, 3);
  assert.match(game.journal.get(keepId).pages[0].text.content, /Сохранить заметку/);
  assert.deepEqual(source, original);
  await assert.rejects(feature.store.update(doc, (entry) => entry), /не найдена/);
  await assert.rejects(feature.store.remove(doc), /уже удалена/);
  await feature.store.repair(); assert.equal(game.journal.length, 3);
});

test("removing a damaged card never deletes an unrelated journal referenced by publicId", async () => {
  const { feature, context, game } = setup(); const { doc } = await feature.store.addActor(actor());
  const publicId = feature.store.data(doc).publicId;
  await context.JournalEntry.deleteDocuments([publicId]);
  const unrelated = await context.JournalEntry.create({ name: "Чужой журнал" });
  feature.store.data(doc).publicId = unrelated.id;
  await feature.store.remove(doc);
  assert.equal(game.journal.length, 1); assert.equal(game.journal[0], unrelated);
});

test("delete UI confirms the named card, preserves cancelled drafts and hides destructive controls from players", async () => {
  const { feature, context, game } = setup(); const { doc } = await feature.store.addActor(actor());
  const other = await feature.store.addActor(actor(), { separate: true });
  const publicId = feature.store.data(doc).publicId; const otherId = feature.store.data(other.doc).publicId;
  const app = new feature.Application(); app.selected = doc.id; app.render = async () => {};
  app.drafts.set(publicId, { text: "Удаляемый черновик" }); app.drafts.set(otherId, { text: "Другой черновик" });
  app.expandedSpells.add(`${doc.id}:item-s`); app.expandedSpells.add(`${other.doc.id}:item-s`);
  let accepted = false; let prompts = 0; const errors = [];
  context.ui = { notifications: { info: () => {}, error: (message) => errors.push(message) } };
  context.foundry.applications.api.DialogV2 = { confirm: async (options) => {
    prompts++; assert.match(options.content, /Гоблин воин/); assert.match(options.content, /заметками/); return accepted;
  } };
  assert.match(app.content(), /data-command="remove"/); assert.match(app.content(), /data-command="reset"/);
  await app.command({ dataset: { command: "remove" } });
  assert.equal(game.journal.length, 4); assert.ok(app.drafts.has(publicId));
  accepted = true;
  await app.command({ dataset: { command: "remove" } });
  assert.equal(game.journal.length, 2); assert.ok(!app.drafts.has(publicId)); assert.ok(app.drafts.has(otherId));
  assert.ok(!app.expandedSpells.has(`${doc.id}:item-s`)); assert.ok(app.expandedSpells.has(`${other.doc.id}:item-s`));
  app.content(); assert.equal(app.selected, other.doc.id);
  let resetCalls = 0; context.pf2eEliottTools.bestiary = { reset: async () => { resetCalls++; } };
  await app.command({ dataset: { command: "reset" } }); assert.equal(resetCalls, 1);
  app.preview = true;
  assert.doesNotMatch(app.content(), /data-command="(?:remove|reset)"/);
  await app.command({ dataset: { command: "reset" } }); assert.equal(resetCalls, 1);
  app.preview = false; game.user = { id: "player", isGM: false };
  assert.doesNotMatch(app.content(), /data-command="(?:remove|reset)"/);
  await app.command({ dataset: { command: "remove" } });
  await app.command({ dataset: { command: "reset" } });
  assert.equal(prompts, 2); assert.equal(resetCalls, 1); assert.deepEqual(errors, []);
});
