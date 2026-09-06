(function () {
  const tools = globalThis.pf2eEliottTools;
  const feature = ((tools.features ??= {}).bestiary ??= {});
  const groups = { defenses: "Защиты", attacks: "Атаки", abilities: "Способности", spells: "Заклинания", overview: "Общее", lore: "Описание" };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Descriptions are deliberately plain text: no secret HTML sections, UUID links,
  // executable markup or enrichment which could expose the original actor.
  function plain(value, { localize = true } = {}) {
    let text = String(value ?? "");
    // PF2e glossary descriptions can contain further localization references.
    for (let depth = 0; localize && depth < 8 && /@Localize\[/.test(text); depth++) {
      text = text.replace(/@Localize\[([^\]]+)\]/g, (match, key) => {
        const translated = globalThis.game?.i18n?.localize(key);
        return translated && translated !== key && translated !== match ? translated : "Описание недоступно.";
      });
    }
    if (localize) text = text.replace(/@Localize\[[^\]]+\]/g, "Описание недоступно.");
    return text
      .replace(/<section\b[^>]*class=["'][^"']*\bsecret\b[^"']*["'][^>]*>[\s\S]*?<\/section>/gi, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/@(?:UUID|Compendium)\[[^\]]*\](?:\{([^}]+)\})?/g, (_m, label) => label ?? "")
      .replace(/@(?:Check|Damage|Template)\[([^\]]*)\](?:\{([^}]+)\})?/g, (_m, formula, label) => label ?? formula)
      .replace(/@(?:Trait|Item|Actor|RollTable)\[[^\]]*\]\{([^}]+)\}/g, "$1")
      // The Russian translation supplies the inflected, readable label for
      // units and conditions (e.g. @Unit[Mile|1]{1 мили}).
      .replace(/@(?:Unit|Condition)\[[^\]]*\]\{([^}]+)\}/g, "$1")
      .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  const signed = (v) => Number(v) >= 0 ? `+${v}` : String(v);
  const presentationVersion = 3;
  const listLabels = { traits: "Признак", senses: "Чувство", speed: "Скорость", languages: "Язык", immunities: "Иммунитеты", weaknesses: "Слабости", resistances: "Сопротивления" };
  function listFields(category, values, group = "overview") {
    const unique = [...new Set(values.map((value) => plain(value, { localize: false })).filter(Boolean))];
    // Value-based identifiers keep individual revelations stable when a list is reordered.
    return unique.length ? unique.map((value) => ({ id: `${category}-${encodeURIComponent(value)}`, group, label: listLabels[category], value })) :
      [{ id: `${category}-none`, group, label: { traits: "Признаки", senses: "Чувства", languages: "Языки" }[category] ?? listLabels[category], value: "Нет" }];
  }
  function languageFields(system, localize) {
    const languages = system.languages ?? system.details?.languages ?? {};
    return listFields("languages", [...(languages.value ?? []).map((value) => localize("languages", value)), languages.details ?? ""]);
  }
  function spellField(item) {
    const data = item.system ?? {};
    const origin = item._stats?.compendiumSource ?? item._source?._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? item.uuid;
    return { id: `item-${item.id ?? item._id}`, group: "spells", label: plain(item.name), value: plain(data.description?.value || "Описание отсутствует.", { localize: false }),
      spell: { rank: item.rank ?? data.location?.heightenedLevel ?? data.level?.value ?? 0,
        // Only a standalone compendium spell may be opened by players.
        uuid: typeof origin === "string" && origin.startsWith("Compendium.") ? origin : null } };
  }
  function upgrade(entry, actor, localize = (_table, key) => key) {
    if (entry.snapshot.presentationVersion >= presentationVersion) return entry;
    const revealed = new Set(entry.revealed);
    const fields = entry.snapshot.fields.flatMap((field) => {
      if (["traits", "senses", "speed"].includes(field.id)) {
        const parts = listFields(field.id, field.value.split(/,\s*/));
        if (revealed.delete(field.id)) for (const part of parts) revealed.add(part.id);
        return parts;
      }
      if (field.group !== "spells" || field.spell) return [field];
      const rank = field.label.match(/ · ранг (\d+)$/);
      if (!rank) return []; // Old spellcasting DC/attack headers are no longer displayed.
      const item = actor?.items?.find((item) => `item-${item.id ?? item._id}` === field.id && item.type === "spell");
      const link = item ? spellField(item).spell.uuid : null;
      // Only repair presentation. Keep the saved rank, text and revelation state.
      return [{ ...field, label: field.label.slice(0, rank.index), spell: { rank: Number(rank[1]), uuid: link } }];
    });
    for (const category of ["traits", "senses", "speed", "immunities", "weaknesses", "resistances"]) {
      if (!fields.some((field) => field.id.startsWith(`${category}-`))) fields.push(...listFields(category, [], ["immunities", "weaknesses", "resistances"].includes(category) ? "defenses" : "overview"));
    }
    if (!fields.some((field) => field.id.startsWith("languages-"))) {
      // Earlier snapshots did not capture languages. Never claim absence without a source.
      fields.push(...(actor ? languageFields(actor.system, localize) : [{ id: "languages-unknown", group: "overview", label: "Языки", value: "Не сохранены в старой карточке. Источник недоступен." }]));
    }
    const valid = new Set(["name", "image", ...fields.map((field) => field.id)]);
    return { ...entry, snapshot: { ...entry.snapshot, fields, presentationVersion }, revealed: [...revealed].filter((key) => valid.has(key)) };
  }
  function snapshot(actor, localize = (_table, key) => key) {
    if (actor.type !== "npc") throw new Error("В первой версии можно добавлять только NPC и существ PF2e.");
    const s = actor.system;
    const source = actor._source?.system ?? s;
    const fields = [];
    const add = (id, group, label, value) => {
      if (value !== undefined && value !== null && value !== "") fields.push({ id, group, label: plain(label), value: plain(value, { localize: false }) });
    };
    const list = (table, values = []) => values.map((v) => localize(table, v)).join(", ");
    add("level", "overview", "Уровень", s.details?.level?.value);
    fields.push(...listFields("traits", (s.traits?.value ?? []).map((value) => localize("creatureTraits", value))));
    fields.push(...languageFields(s, localize));
    add("size", "overview", "Размер", localize("actorSizes", s.traits?.size?.value ?? "med"));
    add("rarity", "overview", "Редкость", localize("rarityTraits", s.traits?.rarity ?? "common"));
    add("description", "lore", "Описание", s.details?.publicNotes);
    add("ac", "defenses", "КБ", s.attributes?.ac?.value);
    add("hp", "defenses", "Максимум ОЗ", s.attributes?.hp?.max);
    add("hp-details", "defenses", "Особенности ОЗ", s.attributes?.hp?.details);
    for (const [key, label] of Object.entries({ fortitude: "Стойкость", reflex: "Рефлекс", will: "Воля" })) {
      const value = actor.saves?.[key]?.mod ?? s.saves?.[key]?.totalModifier ?? s.saves?.[key]?.value;
      if (value != null) add(`save-${key}`, "defenses", label, signed(value));
    }
    const perception = actor.perception?.mod ?? s.perception?.mod ?? s.attributes?.perception?.value;
    if (perception != null) add("perception", "overview", "Восприятие", signed(perception));
    fields.push(...listFields("senses", (s.perception?.senses ?? []).map((v) => `${localize("senses", v.type)}${v.acuity ? ` (${localize("senseAcuities", v.acuity)})` : ""}${Number.isFinite(v.range) && v.range > 0 ? ` ${v.range} фт` : ""}`)));
    const speed = source.attributes?.speed;
    fields.push(...listFields("speed", speed ? [speed.value != null ? `${speed.value} фт` : "", ...(speed.otherSpeeds ?? []).map((v) => `${localize("speedTypes", v.type)} ${v.value} фт`), speed.details ?? ""] : []));
    for (const [key, label, table] of [["immunities", "Иммунитет", "immunityTypes"], ["weaknesses", "Слабость", "weaknessTypes"], ["resistances", "Сопротивление", "resistanceTypes"]]) {
      const values = s.attributes?.[key] ?? [];
      if (!values.length) fields.push(...listFields(key, [], "defenses"));
      values.forEach((v, index) => {
        const type = v.type ?? "custom";
        const exceptions = v.exceptions?.length ? `; исключения: ${list(table, v.exceptions)}` : "";
        const double = v.doubleVs?.length ? `; удвоено против: ${list(table, v.doubleVs)}` : "";
        add(`${key}-${type}-${index}`, "defenses", label, `${localize(table, type)}${v.value != null ? ` ${v.value}` : ""}${exceptions}${double}${v.definition?.length ? ` (${plain(v.label ?? "особое условие")})` : ""}`);
      });
    }
    for (const item of actor.items ?? []) {
      const data = item.system ?? {};
      const id = item.id ?? item._id;
      if (item.type === "melee") {
        const action = s.actions?.find((a) => a.item?.id === id);
        const bonus = action?.totalModifier ?? data.bonus?.value;
        const damage = Object.values(data.damageRolls ?? {}).map((v) => `${v.damage} ${localize("damageTypes", v.damageType)}`).join(" + ");
        add(`item-${id}`, "attacks", item.name, [bonus != null ? `Атака ${signed(bonus)}` : "", damage, list("npcAttackTraits", data.traits?.value), data.description?.value].filter(Boolean).join("\n"));
      } else if (item.type === "action") {
        const cost = { reaction: "Реакция", free: "Свободное действие", passive: "Пассивная" }[data.actionType?.value] ?? `${data.actions?.value ?? 1} д.`;
        add(`item-${id}`, "abilities", `${item.name} · ${cost}`, [list("actionTraits", data.traits?.value), data.description?.value || "Описание отсутствует."].filter(Boolean).join("\n"));
      } else if (item.type === "spell") {
        fields.push(spellField(item));
      }
    }
    const origin = actor._stats?.compendiumSource ?? actor._source?._stats?.compendiumSource ?? actor.flags?.core?.sourceId ?? actor.token?.baseActor?.uuid ?? actor.uuid;
    return {
      version: 1, presentationVersion, name: actor.name, img: actor.img || "icons/svg/mystery-man.svg", fields,
      sourceUuid: actor.uuid, origin,
      // An elite/weak variant is not silently merged with its base creature.
      identity: `${origin}|${s.attributes?.adjustment ?? "normal"}`,
      capturedAt: Date.now(),
    };
  }
  function project(entry) {
    return {
      version: 1,
      name: entry.snapshot.name,
      img: entry.revealed.includes("image") ? entry.snapshot.img : "icons/svg/mystery-man.svg",
      fields: entry.snapshot.fields.filter((f) => entry.revealed.includes(f.id)).map(({ id, group, label, value, spell }) => ({ id, group, label, value,
        ...(spell ? { spell: { rank: spell.rank, uuid: typeof spell.uuid === "string" && spell.uuid.startsWith("Compendium.") ? spell.uuid : null } } : {}) })),
    };
  }
  function refresh(entry, next) {
    const valid = new Set(["name", "image", ...next.fields.map((f) => f.id)]);
    // Changed facts return to hidden: a refresh must never silently publish new text.
    const unchanged = (id) => id === "image" ? entry.snapshot.img === next.img : id === "name" ? entry.snapshot.name === next.name :
      entry.snapshot.fields.some((old) => old.id === id && next.fields.some((f) => f.id === id && f.label === old.label && f.value === old.value && JSON.stringify(f.spell) === JSON.stringify(old.spell)));
    return { ...entry, snapshot: next, revealed: entry.revealed.filter((id) => valid.has(id) && unchanged(id)) };
  }
  feature.model = { groups, escape, plain, snapshot, project, refresh, spellField, upgrade, presentationVersion };
})();
