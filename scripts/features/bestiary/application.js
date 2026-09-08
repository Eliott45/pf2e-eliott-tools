(function () {
  const feature = globalThis.pf2eEliottTools.features.bestiary;
  const { escape: e } = feature.model;
  feature.windows = new Set();
  const button = (action, text, attributes = "") => `<button type="button" data-command="${action}" ${attributes}>${text}</button>`;
  const traits = (display) => display.fields.filter((field) => field.id === "traits" || field.id.startsWith("traits-")).map((field) => field.value).join(", ");
  const listTitles = { traits: "Признаки", senses: "Чувства", speed: "Скорости", languages: "Языки", weaknesses: "Слабости", resistances: "Сопротивления", immunities: "Иммунитеты" };
  class EliottBestiary extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "eliott-bestiary", tag: "div", classes: ["eliott-bestiary"],
      window: { title: "Бестиарий группы", icon: "fa-solid fa-book-open", resizable: true },
      position: { width: 1180, height: 800 },
    };
    selected = null;
    query = "";
    preview = false;
    drafts = new Map();
    expandedSpells = new Set();
    busy = false;
    get gm() { return game.user.isGM && !this.preview; }
    entries() {
      const store = feature.store;
      return (game.user.isGM ? store.privateEntries() : store.publicEntries()).map((doc) => {
        const data = store.data(doc);
        const projection = game.user.isGM ? feature.model.project(data) : data.projection;
        const display = this.gm ? data.snapshot : projection;
        return { doc, data, projection, display: { ...display, fields: display.fields.map(store.displayField) },
          publicDoc: game.user.isGM ? game.journal.get(data.publicId) : doc };
      }).sort((a, b) => a.display.name.localeCompare(b.display.name, "ru"));
    }
    async _renderHTML() { return this.content(); }
    _replaceHTML(html, content) {
      const scroll = [...content.querySelectorAll("[data-scroll]")].map((node) => [node.dataset.scroll, node.scrollTop]);
      const originals = new Set([...content.querySelectorAll("details[data-original][open]")].map((node) => node.dataset.original));
      const input = content.querySelector("[data-search]");
      const focused = input && input === document.activeElement;
      const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
      content.innerHTML = html;
      for (const node of content.querySelectorAll("details[data-original]")) node.open = originals.has(node.dataset.original);
      for (const [key, top] of scroll) content.querySelector(`[data-scroll="${key}"]`)?.scrollTo(0, top);
      if (focused) {
        const next = content.querySelector("[data-search]");
        next.focus();
        next.setSelectionRange(...selection);
      }
    }
    content() {
      const all = this.entries();
      const query = this.query.trim().toLocaleLowerCase("ru");
      const entries = all.filter(({ display }) => `${display.name} ${traits(display)}`.toLocaleLowerCase("ru").includes(query));
      if (!entries.some((entry) => entry.doc.id === this.selected)) this.selected = entries[0]?.doc.id ?? null;
      const entry = entries.find((entry) => entry.doc.id === this.selected);
      return `<div class="eb-shell">
        <header class="eb-top"><div><h1>Бестиарий группы</h1><p>${this.preview ? "Предпросмотр · только известные группе сведения" : this.gm ? "Существа, встречи и знания вашей группы" : "Всё, что вам удалось узнать"}</p></div>
          <div class="eb-top-actions">${game.user.isGM ? button("preview", this.preview ? "Вернуться к мастеру" : "Глазами игрока", `aria-pressed="${this.preview}"`) : ""}${this.gm ? button("reset", '<i class="fa-solid fa-trash-can" aria-hidden="true"></i> Очистить всё', `class="eb-danger" ${this.busy ? "disabled" : ""}`) : ""}<span class="eb-counter">Записей: ${all.length}</span></div></header>
        <div class="eb-body"><aside class="eb-sidebar"><label class="eb-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input data-search type="search" aria-label="Поиск существ" placeholder="Найти существо…" value="${e(this.query)}"></label>
          ${this.gm ? `<div class="eb-add">${button("pick-actor", '<i class="fa-solid fa-plus" aria-hidden="true"></i> Добавить существо', this.busy ? "disabled" : "")}${button("add-selected", "Из выбранных токенов", this.busy ? "disabled" : "")}<label class="eb-check"><input data-separate type="checkbox"> Как отдельную запись</label><p>Или перетащите сюда NPC из акторов или компендиума.</p></div>` : ""}
          <nav class="eb-list" data-scroll="list" aria-label="Существа">${entries.map((row) => `<button type="button" class="eb-creature ${row.doc.id === this.selected ? "is-selected" : ""}" data-command="select" data-id="${e(row.doc.id)}" aria-pressed="${row.doc.id === this.selected}"><img src="${e(row.display.img)}" alt=""><span><strong>${e(row.display.name)}</strong><small>${e(traits(row.display) || "Признаки пока неизвестны")}</small></span></button>`).join("") || `<p class="eb-list-empty">${query ? "Ничего не найдено" : "Здесь появятся ваши встречи"}</p>`}</nav>
          <footer class="eb-sidebar-footer"><i class="fa-solid fa-book-bookmark" aria-hidden="true"></i> Знания сохраняются между сценами</footer></aside>
          <main class="eb-detail" data-scroll="detail">${entry ? this.card(entry) : `<div class="eb-empty"><i class="fa-solid fa-dragon" aria-hidden="true"></i><span class="eb-eyebrow">ПЕРВАЯ ВСТРЕЧА</span><h2>${query ? "Попробуйте другое название" : "У каждого чудовища есть история"}</h2><p>${this.gm ? "Перетащите существо в это окно. Его карточка сохранится здесь, даже если исходного актора больше не будет." : "Мастер добавит встреченных существ и откроет то, что удалось о них узнать."}</p></div>`}</main></div>
        <footer class="eb-status">${this.busy ? "Сохраняем…" : this.gm ? "Кнопки «Скрыто» раскрывают сведения группе." : "Заметки группы доступны всем участникам."}</footer></div>`;
    }
    reveal(id, revealed, label = { name: "Имя", image: "Портрет" }[id], compact = false) {
      const hint = `${revealed ? "Скрыть" : "Раскрыть"}: ${label}`;
      return this.gm ? button("reveal", `<i class="fa-solid ${revealed ? "fa-eye" : "fa-eye-slash"}" aria-hidden="true"></i>${compact ? "" : ` ${revealed ? "Открыто" : "Скрыто"}`}`, `class="eb-visibility ${compact ? "eb-visibility-icon" : ""} ${revealed ? "is-open" : ""}" data-field="${e(id)}" aria-label="${e(hint)}" title="${e(hint)}" aria-pressed="${revealed}" ${this.busy ? "disabled" : ""}`) : "";
    }
    layoutFields(fields) {
      const layout = Object.fromEntries(["level", "profile", "traits", "defenses", "immunities", "weaknesses", "resistances", "saves", "speed", "senses", "languages", "overview", "attacks", "abilities", "spells", "lore"].map((key) => [key, []]));
      for (const field of fields) {
        const category = Object.keys(listTitles).find((key) => field.id === key || field.id.startsWith(`${key}-`));
        const scope = field.id === "level" ? "level" : ["size", "rarity"].includes(field.id) ? "profile" :
          field.id.startsWith("save-") ? "saves" : field.id === "perception" ? "senses" : category ?? (layout[field.group] ? field.group : "overview");
        layout[scope].push(field);
      }
      return layout;
    }
    stat(field, revealed, label = field.label) {
      return `<article class="eb-stat ${this.gm && !revealed.includes(field.id) ? "is-hidden" : ""}"><span class="eb-stat-label">${e(label)}</span><strong class="eb-stat-value">${e(field.value)}</strong>${this.reveal(field.id, revealed.includes(field.id), field.label, true)}</article>`;
    }
    sheetSection(scope, title, fields, revealed, mode = "cards") {
      if (!fields.length) return "";
      const allOpen = fields.every((field) => revealed.includes(field.id));
      const header = `<div class="eb-section-title"><h3>${e(title)}</h3>${this.gm ? button("group", allOpen ? "Скрыть" : "Раскрыть", `data-scope="${scope}" aria-label="${allOpen ? "Скрыть" : "Раскрыть"} раздел: ${e(title)}" ${this.busy ? "disabled" : ""}`) : ""}</div>`;
      const contents = mode === "stats" ? fields.map((field) => ["ac", "hp"].includes(field.id) || field.id.startsWith("save-") ? this.stat(field, revealed, { hp: "ОЗ", "save-fortitude": "Стойк.", "save-reflex": "Рефл.", "save-will": "Воля" }[field.id] ?? field.label) : this.field(field, revealed)).join("") :
        mode === "tags" ? fields.map((field) => `<span class="eb-trait-tag ${this.gm && !revealed.includes(field.id) ? "is-hidden" : ""}"><span>${e(field.value)}</span>${this.reveal(field.id, revealed.includes(field.id), `${title}: ${field.value}`, true)}</span>`).join("") :
        mode === "facts" ? `<ul class="eb-sheet-facts">${fields.map((field) => `<li class="eb-fact-row ${this.gm && !revealed.includes(field.id) ? "is-hidden" : ""}"><span class="eb-value">${field.id === "perception" ? "Восприятие " : ""}${this.description(field)}</span>${this.reveal(field.id, revealed.includes(field.id), `${title}: ${field.value}`, true)}</li>`).join("")}</ul>` : this.fieldGroups(fields, revealed);
      return `<section class="eb-section eb-sheet-section eb-scope-${scope}">${header}<div class="eb-section-content eb-mode-${mode}">${contents}</div></section>`;
    }
    card(entry) {
      const { display, data, publicDoc } = entry;
      const revealed = data.revealed ?? [];
      const page = publicDoc?.pages.find((p) => p.type === "text");
      const notes = this.drafts.get(publicDoc?.id)?.text ?? feature.model.plain(page?.text.content ?? "");
      const editableNotes = !this.preview && page?.testUserPermission(game.user, "OWNER");
      const layout = this.layoutFields(display.fields);
      return `<div class="eb-sheet"><aside class="eb-sheet-sidebar" aria-label="Портрет и защиты"><div class="eb-portrait"><img src="${e(display.img)}" alt="Портрет существа">${this.reveal("image", revealed.includes("image"))}</div>
        ${this.sheetSection("defenses", "Защиты", layout.defenses, revealed, "stats")}
        ${["immunities", "weaknesses", "resistances"].map((scope) => this.sheetSection(scope, listTitles[scope], layout[scope], revealed, "facts")).join("")}
        ${this.sheetSection("saves", "Спасброски", layout.saves, revealed, "stats")}
        ${this.sheetSection("speed", "Скорости", layout.speed, revealed, "facts")}
        </aside><div class="eb-sheet-main"><header class="eb-sheet-heading"><div class="eb-title-row"><h2>${e(display.name)}</h2><div class="eb-level">${layout.level.map((field) => this.stat(field, revealed, "Существо")).join("")}</div></div>
        <div class="eb-profile-meta">${layout.profile.map((field) => `<span class="eb-trait-tag ${this.gm && !revealed.includes(field.id) ? "is-hidden" : ""}"><span>${e(field.value)}</span>${this.reveal(field.id, revealed.includes(field.id), field.label, true)}</span>`).join("")}</div>
        ${this.sheetSection("traits", "Признаки", layout.traits, revealed, "tags")}
        ${this.gm ? `<p class="eb-hint">Сохранённая копия · ${e(new Date(data.snapshot.capturedAt).toLocaleDateString("ru"))}</p>` : `<p class="eb-hint">Известных сведений: ${display.fields.length}</p>`}</header>
        ${this.gm ? `<div class="eb-card-actions">${button("reveal-all", "Открыть всё")}${button("hide-all", "Скрыть всё")}${button("refresh", '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Обновить из источника')}${button("remove", '<i class="fa-solid fa-trash-can" aria-hidden="true"></i> Удалить запись', `class="eb-danger" ${this.busy ? "disabled" : ""}`)}</div>` : ""}
        ${this.sheetSection("senses", "Чувства", layout.senses, revealed, "facts")}
        ${this.sheetSection("languages", "Языки", layout.languages, revealed, "facts")}
        ${this.sheetSection("overview", "Общее", layout.overview, revealed)}
        ${this.sheetSection("attacks", "Атаки", layout.attacks, revealed)}
        ${this.sheetSection("abilities", "Способности", layout.abilities, revealed)}
        ${this.sheetSection("spells", "Заклинания", layout.spells, revealed)}
        ${this.sheetSection("lore", "Описание", layout.lore, revealed)}
        ${!display.fields.length ? `<div class="eb-unknown"><i class="fa-solid fa-compass" aria-hidden="true"></i><h3>Это существо ещё предстоит изучить</h3><p>Открытые мастером сведения появятся здесь.</p></div>` : ""}
        <section class="eb-section eb-notes"><div class="eb-section-title"><h3>Заметки группы</h3><span class="eb-hint">Общие для всех</span></div>${editableNotes ? `<textarea data-notes aria-label="Заметки группы" placeholder="Что вы заметили? Как с ним сражаться?">${e(notes)}</textarea><div class="eb-note-actions"><span class="eb-hint">${this.drafts.has(publicDoc.id) ? "Есть несохранённый текст" : "Записывайте наблюдения и догадки"}</span>${button("save-notes", "Сохранить заметки", this.busy ? "disabled" : "")}</div>` : `<p class="eb-value">${e(notes || "Наблюдений пока нет.")}</p>`}</section></div></div>`;
    }
    fieldGroups(fields, revealed) {
      const blocks = new Map();
      for (const field of fields) {
        const category = Object.keys(listTitles).find((key) => field.id.startsWith(`${key}-`));
        const key = category ?? field.id;
        if (!blocks.has(key)) blocks.set(key, { category, fields: [] });
        blocks.get(key).fields.push(field);
      }
      return [...blocks.values()].map(({ category, fields: rows }) => {
        if (!category) return rows.map((field) => this.field(field, revealed)).join("");
        return `<article class="eb-field eb-fact-list"><h4>${listTitles[category]}</h4><ul>${rows.map((field) => `<li class="eb-fact-row ${this.gm && !revealed.includes(field.id) ? "is-hidden" : ""}"><span class="eb-value">${e(field.value)}</span>${this.reveal(field.id, revealed.includes(field.id), `${listTitles[category]}: ${field.value}`)}</li>`).join("")}</ul></article>`;
      }).join("");
    }
    description(field) {
      return `${e(field.value)}${field.original ? `<details class="eb-original" data-original="${e(`${this.selected}:${field.id}`)}"><summary>Оригинал</summary><div class="eb-original-text">${e(field.original)}</div></details>` : ""}`;
    }
    field(field, revealed) {
      const classes = `eb-field ${this.gm && !revealed.includes(field.id) ? "is-hidden" : ""}`;
      if (field.spell) {
        const expanded = this.expandedSpells.has(`${this.selected}:${field.id}`);
        const uuid = field.spell.uuid;
        const destination = typeof uuid === "string" && uuid.startsWith("Compendium.") ? ` data-uuid="${e(uuid)}"` : "";
        const toggleLabel = `${expanded ? "Свернуть" : "Развернуть"} описание: ${field.label}`;
        const toggle = button("spell-toggle", `<i class="fa-solid ${expanded ? "fa-chevron-up" : "fa-chevron-down"}" aria-hidden="true"></i>`, `class="eb-spell-toggle" data-field="${e(field.id)}" aria-expanded="${expanded}" aria-label="${e(toggleLabel)}" title="${e(toggleLabel)}"`);
        return `<article class="${classes} eb-spell-card"><div class="eb-spell-row">${toggle}<span class="eb-spell-name"><a class="content-link eb-spell-link" href="#" data-command="spell" data-field="${e(field.id)}"${destination} aria-label="Открыть заклинание: ${e(field.label)}"><i class="fa-solid fa-file-lines" aria-hidden="true"></i> ${e(field.label)}</a></span><span class="eb-spell-rank">Ранг ${e(field.spell.rank)}</span>${this.reveal(field.id, revealed.includes(field.id), field.label)}</div>${expanded ? `<div class="eb-value eb-spell-description">${this.description(field)}</div>` : ""}</article>`;
      }
      return `<article class="${classes}"><div class="eb-field-title"><h4>${e(field.label)}</h4>${this.reveal(field.id, revealed.includes(field.id), field.label)}</div><div class="eb-value">${this.description(field)}</div></article>`;
    }
    _onRender(context, options) {
      super._onRender(context, options);
      feature.windows.add(this);
      const root = this.element;
      root.querySelector("[data-search]")?.addEventListener("input", (event) => { this.query = event.target.value; void this.render(); });
      root.querySelector("[data-notes]")?.addEventListener("input", (event) => {
        const row = this.entries().find((entry) => entry.doc.id === this.selected);
        const page = row?.publicDoc?.pages.find((p) => p.type === "text");
        if (page) this.drafts.set(row.publicDoc.id, { text: event.target.value, base: this.drafts.get(row.publicDoc.id)?.base ?? page.text.content ?? "" });
        const hint = root.querySelector(".eb-note-actions .eb-hint");
        if (hint) hint.textContent = "Есть несохранённый текст";
      });
      root.querySelectorAll("[data-command]").forEach((node) => node.addEventListener("click", (event) => {
        event.preventDefault();
        // We handle permission checks and missing-source fallback ourselves;
        // prevent Foundry's delegated content-link handler opening a second sheet.
        if (node.dataset.command === "spell") event.stopPropagation();
        void this.command(node);
      }));
      const shell = root.querySelector(".eb-shell");
      shell.addEventListener("dragover", (event) => { if (this.gm) { event.preventDefault(); shell.classList.add("is-dragover"); } });
      shell.addEventListener("dragleave", (event) => { if (!shell.contains(event.relatedTarget)) shell.classList.remove("is-dragover"); });
      shell.addEventListener("drop", (event) => {
        event.preventDefault(); shell.classList.remove("is-dragover");
        if (!this.gm) return;
        const separate = !!root.querySelector("[data-separate]")?.checked;
        let drop;
        try { drop = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
        void this.perform(async () => {
          if (drop.type !== "Actor" || !drop.uuid) throw new Error("Перетащите NPC из списка акторов или компендиума, либо используйте выбранные токены.");
          const actor = await fromUuid(drop.uuid);
          if (!actor) throw new Error("Не удалось найти существо.");
          await this.add(actor, separate);
        });
      });
    }
    async perform(operation) {
      if (this.busy) return;
      this.busy = true;
      try { await operation(); }
      catch (error) { console.error("PF2E Eliott Tools | Bestiary", error); ui.notifications.error(error.message); }
      finally { this.busy = false; await this.render(); }
    }
    async add(actor, separate) {
      const result = await feature.store.addActor(actor, { separate });
      this.query = "";
      this.selected = result.doc.id;
      ui.notifications.info(result.existing ? "Открыта уже существующая запись." : "Существо сохранено в бестиарии.");
    }
    forgetEntry(sourceId, publicId) {
      this.drafts.delete(sourceId); this.drafts.delete(publicId);
      if (this.selected === sourceId || this.selected === publicId) this.selected = null;
      for (const key of this.expandedSpells) {
        if (key.startsWith(`${sourceId}:`) || (publicId && key.startsWith(`${publicId}:`))) this.expandedSpells.delete(key);
      }
    }
    async command(node) {
      const command = node.dataset.command;
      if (command === "select") { this.selected = node.dataset.id; await this.render(); this.element.querySelector(".eb-detail")?.scrollTo(0, 0); return; }
      if (command === "preview") { this.preview = !this.preview; await this.render(); return; }
      if (command === "reset") {
        if (!this.gm) return;
        return this.perform(() => globalThis.pf2eEliottTools.bestiary.reset());
      }
      if (command === "pick-actor" && this.gm) {
        const actors = game.actors.filter((actor) => actor.type === "npc").sort((a, b) => a.name.localeCompare(b.name, "ru"));
        if (!actors.length) return ui.notifications.info("В мире нет NPC. Перетащите существо из компендиума в бестиарий.");
        const separate = !!this.element.querySelector("[data-separate]")?.checked;
        const actorId = await foundry.applications.api.DialogV2.wait({
          window: { title: "Добавить существо" },
          content: `<label>Существо из мира<select name="bestiary-actor">${actors.map((actor) => `<option value="${e(actor.id)}">${e(actor.name)}</option>`).join("")}</select></label>`,
          buttons: [{ action: "add", label: "Добавить", default: true, callback: (_event, _button, dialog) => dialog.element.querySelector("select").value }, { action: "cancel", label: "Отмена", callback: () => false }],
          rejectClose: false,
        });
        if (actorId) return this.perform(() => this.add(game.actors.get(actorId), separate));
        return;
      }
      if (command === "add-selected") {
        const actors = [...new Set((canvas.tokens?.controlled ?? []).map((token) => token.actor).filter((actor) => actor?.type === "npc"))];
        const separate = !!this.element.querySelector("[data-separate]")?.checked;
        return this.perform(async () => {
          if (!actors.length) throw new Error("Сначала выделите на сцене один или несколько токенов NPC.");
          for (const actor of actors) await this.add(actor, separate);
        });
      }
      const row = this.entries().find((entry) => entry.doc.id === this.selected);
      if (!row) return;
      if (command === "spell-toggle") {
        const field = row.display.fields.find((field) => field.id === node.dataset.field && field.spell);
        if (!field) return;
        const key = `${this.selected}:${field.id}`;
        if (!this.expandedSpells.delete(key)) this.expandedSpells.add(key);
        return this.render();
      }
      if (command === "spell") {
        const field = row.display.fields.find((field) => field.id === node.dataset.field && field.spell);
        if (!field) return;
        return this.perform(async () => {
          const uuid = field.spell.uuid;
          const spell = typeof uuid === "string" && uuid.startsWith("Compendium.") ? await fromUuid(uuid).catch(() => null) : null;
          if (spell?.type === "spell" && spell.testUserPermission(game.user, "LIMITED")) {
            const sheet = spell.sheet;
            // V14 can detach applications into browser windows. Keep this
            // original spell sheet inside the Foundry workspace.
            if (sheet instanceof foundry.applications.api.ApplicationV2) {
              await sheet.render({ force: true, window: { detached: false } });
              sheet.bringToFront();
            } else {
              // ApplicationV1.render returns immediately, before its DOM exists.
              // Let Foundry focus the sheet after its asynchronous render completes.
              sheet.render(true, { focus: true });
            }
            return;
          }
          await foundry.applications.api.DialogV2.wait({ window: { title: field.label }, position: { width: 600 },
            content: `<p>Оригинал недоступен. Сохранённое описание · Ранг ${e(field.spell.rank)}</p><div style="white-space:pre-wrap">${this.description(field)}</div>`,
            buttons: [{ action: "close", label: "Закрыть", default: true }], rejectClose: false });
        });
      }
      if (command === "save-notes") {
        const draft = this.drafts.get(row.publicDoc?.id);
        if (!draft) return;
        return this.perform(async () => { await feature.store.saveNotes(row.publicDoc, draft.text, draft.base); this.drafts.delete(row.publicDoc.id); ui.notifications.info("Заметки сохранены."); });
      }
      if (!this.gm) return;
      if (command === "remove") {
        return this.perform(async () => {
          feature.store.requireGM();
          const accepted = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Удалить запись?" },
            content: `<p>Удалить «${e(row.display.name)}» из бестиария вместе с раскрытыми сведениями и заметками группы? Несохранённые заметки этой записи также будут потеряны.</p><p>Другие записи и исходное существо сохранятся. Отменить удаление нельзя.</p>`,
            yes: { label: "Удалить запись" }, no: { label: "Отмена", default: true }, rejectClose: false,
          });
          if (!accepted) return;
          const removed = await feature.store.remove(row.doc);
          this.forgetEntry(removed.sourceId, removed.publicId);
          ui.notifications.info("Запись удалена из бестиария.");
        });
      }
      if (command === "refresh" || command === "reveal-all") {
        const accepted = await foundry.applications.api.DialogV2.confirm({ window: { title: command === "refresh" ? "Обновить карточку" : "Раскрыть существо" },
          content: `<p>${command === "refresh" ? "Заменить характеристики и описание данными источника? Изменённые сведения снова станут скрытыми. Заметки группы сохранятся." : "Открыть игрокам изображение и все сведения этой карточки?"}</p>` });
        if (!accepted) return;
      }
      return this.perform(async () => {
        if (command === "refresh") return feature.store.refresh(row.doc);
        await feature.store.update(row.doc, (entry) => {
          const keys = command === "reveal" ? [node.dataset.field] : command === "group" ? (node.dataset.scope ? this.layoutFields(entry.snapshot.fields)[node.dataset.scope] ?? [] : entry.snapshot.fields.filter((f) => f.group === node.dataset.group)).map((f) => f.id) : ["image", ...entry.snapshot.fields.map((f) => f.id)];
          const hide = command === "hide-all" || (command !== "reveal-all" && keys.every((key) => entry.revealed.includes(key)));
          entry.revealed = hide ? entry.revealed.filter((key) => !keys.includes(key)) : [...new Set([...entry.revealed, ...keys])];
          return entry;
        });
      });
    }
    async close(options) {
      if (this.drafts.size) {
        const accepted = await foundry.applications.api.DialogV2.confirm({ window: { title: "Несохранённые заметки" }, content: "<p>Закрыть бестиарий и потерять несохранённые заметки?</p>" });
        if (!accepted) return this;
        this.drafts.clear();
      }
      return super.close(options);
    }
    _onClose(options) {
      feature.windows.delete(this);
      return super._onClose(options);
    }
  }
  feature.Application = EliottBestiary;
})();
