(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id } = tools.module;
  const feature = tools.features.bestiary;
  const flag = "bestiary";
  let pending = Promise.resolve();
  const data = (doc) => doc?.getFlag(id, flag);
  const privateEntries = () => game.journal.filter((doc) => data(doc)?.kind === "source");
  const publicEntries = () => game.journal.filter((doc) => data(doc)?.kind === "entry" && doc.testUserPermission(game.user, "OBSERVER"));
  function localize(table, key) {
    if (!key) return "";
    const slug = String(key).toLowerCase();
    const config = CONFIG.PF2E[table] ?? {};
    const translation = config[key] ?? config[slug];
    if (translation) return game.i18n.localize(translation);
    // Alignment traits were removed from modern PF2e configuration, but still
    // exist on legacy actors and in older bestiary snapshots.
    const legacy = { chaotic: "Хаотичный", lawful: "Принципиальный", evil: "Злой", good: "Добрый" };
    if (legacy[slug] && ["creatureTraits", "actionTraits", "npcAttackTraits", "damageTypes", "immunityTypes", "weaknessTypes", "resistanceTypes"].includes(table)) {
      return game.i18n.lang?.startsWith("ru") ? legacy[slug] : slug[0].toUpperCase() + slug.slice(1);
    }
    return game.i18n.localize(key);
  }
  function displayField(field) {
    const text = feature.model.description(field.value);
    const original = [text.original, feature.model.plain(field.original)].filter(Boolean).join("\n\n");
    return { ...field, ...text, ...(original ? { original } : {}), label: feature.model.plain(field.label), value: field.id === "traits" || field.id.startsWith("traits-")
      ? field.value.split(",").map((trait) => localize("creatureTraits", trait.trim())).join(", ")
      : text.value };
  }
  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  function requireGM() {
    if (!game.user.isGM) throw new Error("Это действие доступно только мастеру.");
    const active = game.users.activeGM ?? game.users.find((user) => user.active && user.isGM);
    if (active && active.id !== game.user.id) throw new Error("Изменять бестиарий сейчас может основной активный мастер.");
  }
  async function folder(kind, name) {
    return game.folders.find((f) => f.type === "JournalEntry" && f.getFlag(id, "bestiaryFolder") === kind) ??
      await Folder.create({ name, type: "JournalEntry", color: kind === "source" ? "#455266" : "#357c70", flags: { [id]: { bestiaryFolder: kind } } });
  }
  async function publish(doc) {
    let entry = data(doc);
    if (!(entry.snapshot.presentationVersion >= feature.model.presentationVersion)) {
      let actor = await fromUuid(entry.snapshot.sourceUuid).catch(() => null);
      if (!actor && entry.snapshot.origin !== entry.snapshot.sourceUuid) actor = await fromUuid(entry.snapshot.origin).catch(() => null);
      entry = feature.model.upgrade(entry, actor, localize);
      await doc.update({ [`flags.${id}.${flag}`]: entry }, { recursive: false });
    }
    const projection = feature.model.project(entry);
    let publicDoc = game.journal.get(entry.publicId);
    if (!publicDoc) {
      const parent = await folder("entry", "Бестиарий группы");
      publicDoc = await JournalEntry.create({
        name: projection.name, folder: parent.id, ownership: { default: 2 },
        flags: { [id]: { [flag]: { kind: "entry", projection } } },
        pages: [{ name: "Заметки группы", type: "text", ownership: { default: 3 }, text: { content: "", format: 1 } }],
      });
      await doc.update({ [`flags.${id}.${flag}.publicId`]: publicDoc.id });
    } else {
      // Replace the complete flag, rather than deep-merging removed secret fields.
      await publicDoc.update({ name: projection.name, [`flags.${id}.${flag}`]: { kind: "entry", projection } }, { recursive: false });
    }
    return publicDoc;
  }
  async function addActor(actor, { separate = false } = {}) {
    return serialize(async () => {
      requireGM();
      const snapshot = feature.model.snapshot(actor, localize);
      if (!separate) {
        const existing = privateEntries().find((doc) => data(doc).snapshot.identity === snapshot.identity);
        if (existing) {
          await publish(existing);
          return { doc: existing, existing: true };
        }
      }
      const parent = await folder("source", "Бестиарий · данные мастера");
      const doc = await JournalEntry.create({ name: snapshot.name, folder: parent.id, ownership: { default: 0 },
        flags: { [id]: { [flag]: { kind: "source", version: 1, snapshot, alias: separate ? "Особое существо" : "Неизвестное существо", revealed: ["image"] } } } });
      await publish(doc);
      return { doc, existing: false };
    });
  }
  async function update(doc, change) {
    return serialize(async () => {
      requireGM();
      const current = data(game.journal.get(doc.id));
      if (current?.kind !== "source") throw new Error("Запись бестиария не найдена.");
      const next = await change(foundry.utils.deepClone(current));
      await doc.update({ name: next.snapshot.name, [`flags.${id}.${flag}`]: next }, { recursive: false });
      await publish(doc);
    });
  }
  async function refresh(doc) {
    return update(doc, async (current) => {
      let actor = await fromUuid(current.snapshot.sourceUuid).catch(() => null);
      if (!actor && current.snapshot.origin !== current.snapshot.sourceUuid) actor = await fromUuid(current.snapshot.origin).catch(() => null);
      if (!actor) throw new Error("Источник удалён или недоступен. Сохранённая карточка продолжает работать.");
      const next = feature.model.snapshot(actor, localize);
      if (next.identity !== current.snapshot.identity) throw new Error("Источник теперь соответствует другому варианту. Перетащите нужного актора как отдельную запись.");
      return feature.model.refresh(current, next);
    });
  }
  async function saveNotes(publicDoc, value, expected) {
    const page = publicDoc?.pages.find((p) => p.type === "text");
    if (!page?.testUserPermission(game.user, "OWNER")) throw new Error("Нет права редактировать заметки.");
    if ((page.text.content ?? "") !== expected) throw new Error("Заметки изменил другой участник. Скопируйте свой текст, обновите карточку и объедините записи.");
    await page.update({ "text.content": `<p>${feature.model.escape(value).replace(/\n/g, "<br>")}</p>` });
  }
  async function repair() {
    if (!game.user.isGM || (game.users.activeGM && game.users.activeGM.id !== game.user.id)) return;
    // Restores interrupted publication and resynchronizes on the next GM login.
    // Keep the whole pass in the queue so a concurrent reset cannot be undone
    // by publication of a previously captured document after its deletion.
    return serialize(async () => {
      requireGM();
      for (const doc of privateEntries()) await publish(doc);
    });
  }
  async function reset() {
    return serialize(async () => {
      requireGM();
      const ids = game.journal.filter((doc) => ["source", "entry"].includes(data(doc)?.kind)).map((doc) => doc.id);
      // Delete only this feature's marked documents, including orphan public cards.
      // Embedded notes are deleted with their journal; actors and other journals are untouched.
      if (ids.length) await JournalEntry.deleteDocuments(ids);
      return ids.length;
    });
  }
  async function remove(doc) {
    return serialize(async () => {
      requireGM();
      const current = data(game.journal.get(doc.id));
      if (current?.kind !== "source") throw new Error("Запись бестиария уже удалена или недоступна.");
      const publicDoc = game.journal.get(current.publicId);
      const ids = [doc.id];
      if (data(publicDoc)?.kind === "entry") ids.push(publicDoc.id);
      // Delete one saved creature and its embedded group notes, never the actor.
      await JournalEntry.deleteDocuments(ids);
      return { sourceId: doc.id, publicId: current.publicId };
    });
  }
  feature.store = { data, privateEntries, publicEntries, addActor, update, refresh, saveNotes, repair, reset, remove, requireGM, localize, displayField };
})();
