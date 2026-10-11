(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const optionsSetting = "templateTargetingOptions";
  const defaultOptions = { self: true, neutral: true, dismiss: true };
  const modes = [
    { id: "enemies", label: "Враги", icon: "fa-skull" },
    { id: "allies", label: "Союзники", icon: "fa-shield-heart" },
    { id: "all", label: "Все", icon: "fa-users" },
  ];
  const relations = {
    self: "Вы",
    ally: "Союзник",
    enemy: "Враг",
    neutral: "Нейтральный",
  };
  const animationModuleId = "autoanimations";
  // Areas whose dialog is (or was) open: Automated Animations waits on them before playing.
  const pending = new Map();
  let current = null;

  tools.features ??= {};
  tools.features.templateTargeting = { onInit, collectCandidates, isIncluded, pending };

  function onInit() {
    game.settings.register(moduleId, settings.templateTargetingEnabled, {
      name: "Выбор целей по шаблону заклинания",
      hint: "После размещения области заклинания открывает окно выбора целей: враги, союзники или все существа внутри с учётом стен. Удерживайте Ctrl при размещении, чтобы не открывать окно. Требуются Foundry 14 и PF2e 8. Настройка индивидуальна для каждого игрока.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
      onChange: (value) => { if (!value) current?.close(); },
    });

    game.settings.register(moduleId, settings.templateTargetingAnimationSync, {
      name: "Синхронизация выбора целей с Automated Animations",
      hint: "Анимация шаблона (в том числе из PF2e Animation Macros) ждёт, пока вы подтвердите цели в окне, и играет уже по выбранным целям. Галка «Убрать шаблон» в окне решает, удалит ли анимация шаблон после проигрывания. Без модуля Automated Animations ни на что не влияет.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, optionsSetting, {
      scope: "client",
      config: false,
      type: Object,
      default: defaultOptions,
    });

    ensureStylesheet();
    Hooks.on("createRegion", onCreateRegion);
    Hooks.on("updateRegion", (region) => { if (current?.region === region) current.refresh(); });
    // Animation modules (Automated Animations "Remove Template", PF2e Animation Macros)
    // delete the area right after their effect plays; keep the dialog and its snapshot.
    Hooks.on("deleteRegion", (region) => {
      if (current?.region === region) current.onRegionDeleted();
      const entry = pending.get(region.id);
      if (entry?.settled) pending.delete(region.id);
    });
    Hooks.on("canvasTearDown", () => current?.close());
    Hooks.on("AutomatedAnimations-WorkflowStart", onAnimationWorkflowStart);
    Hooks.on("aa.preDataSanitize", onAnimationPreSanitize);
  }

  function isAnimationSyncEnabled() {
    return game.modules?.get(animationModuleId)?.active === true
      && game.settings.get(moduleId, settings.templateTargetingAnimationSync) !== false;
  }

  function createPending(region) {
    let settle;
    const entry = {
      claimed: false,
      noAnimation: false,
      settled: false,
      result: null,
      promise: new Promise((resolve) => { settle = resolve; }),
      claimWaiters: [],
    };
    entry.settle = (result) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.result = result;
      settle(result);
    };
    entry.decide = () => {
      for (const waiter of entry.claimWaiters.splice(0)) waiter();
    };
    pending.set(region.id, entry);
    // Drop stale entries even if neither AA nor the user ever finishes.
    setTimeout(() => { if (pending.get(region.id) === entry && entry.settled) pending.delete(region.id); }, 120000);
    return entry;
  }

  // Automated Animations awaits `deferrals` before building its handler,
  // so the template animation starts only after the dialog is closed.
  function onAnimationWorkflowStart(data, animationData) {
    const region = data?.isTemplate ? data.templateData : null;
    const entry = region ? pending.get(region.id) : null;
    if (!entry) return;
    if (!animationData) {
      entry.noAnimation = true;
      entry.decide();
      return;
    }
    entry.claimed = true;
    entry.decide();
    if (current?.animation === entry && current.rendered) current.render();
    data.deferrals ??= [];
    data.deferrals.push(entry.promise.then((result) => {
      data.targets = [...result.targets];
      data.hitTargets = [...result.targets];
    }));
  }

  // Runs on AA's own deep clone of the animation settings: the autorec menu itself is untouched.
  function onAnimationPreSanitize(handler, data) {
    const region = handler?.templateData;
    const entry = region ? pending.get(region.id) : null;
    if (!entry?.claimed || !entry.result) return;
    const removeTemplate = entry.result.dismiss;
    for (const options of [data?.primary?.options, data?.data?.options, data?.data?.projectile?.options]) {
      if (options && typeof options === "object") options.removeTemplate = removeTemplate;
    }
  }

  function waitForAnimationClaim(entry, timeout = 2000) {
    if (entry.claimed || entry.noAnimation) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      entry.claimWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  function ensureStylesheet() {
    // A cached manifest may skip the new stylesheet after a browser reload.
    const href = foundry.utils.getRoute(`modules/${moduleId}/styles/template-targeting.css`);
    if ([...document.querySelectorAll("link[rel=stylesheet]")].some((link) => link.getAttribute("href")?.endsWith("styles/template-targeting.css"))) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }

  function isEnabled() {
    return game.settings.get(moduleId, settings.templateTargetingEnabled) !== false;
  }

  function onCreateRegion(region, _options, userId) {
    if (userId !== game.user.id || !isEnabled()) return;
    if (!canvas.ready || region.parent !== canvas.scene || !region.isEffectArea) return;
    if (region.flags?.[moduleId]?.skip || game.keyboard?.isModifierActive?.("Control")) return;

    try {
      current?.close();
      // Registered synchronously: AA reaches its workflow only after awaiting the item lookup.
      const animation = isAnimationSyncEnabled() ? createPending(region) : null;
      current = new TemplateTargetingApp(region, animation);
      current.render({ force: true });
    } catch (error) {
      console.error(`${logPrefix} | Could not open template targeting`, error);
    }
  }

  function loadOptions() {
    const stored = game.settings.get(moduleId, optionsSetting);
    return { ...defaultOptions, ...(stored && typeof stored === "object" ? stored : {}), mode: "all" };
  }

  function saveOptions({ self, neutral, dismiss }) {
    void game.settings.set(moduleId, optionsSetting, { self, neutral, dismiss }).catch((error) => {
      console.error(`${logPrefix} | Could not save template targeting options`, error);
    });
  }

  function resolveSource(region) {
    const flags = region.flags?.pf2e ?? {};
    const origin = flags.origin ?? {};
    const message = region.message ?? game.messages?.get(flags.messageId ?? "") ?? null;
    let item = message?.item ?? null;
    if (!item && origin.uuid) {
      try { item = fromUuidSync(origin.uuid); } catch { item = null; }
    }
    if (item && typeof item.isOfType !== "function") item = null;

    let actor = item?.actor ?? null;
    if (!actor && origin.actor) {
      try { actor = fromUuidSync(origin.actor); } catch { actor = null; }
    }
    actor ??= message?.actor ?? null;

    const selfToken = findSceneToken(actor) ?? findSceneToken(message?.token?.actor);
    return { region, origin, message, item, actor, selfToken };
  }

  function findSceneToken(actor) {
    if (!actor) return null;
    const synthetic = actor.token?.object;
    if (synthetic && synthetic.document.parent === canvas.scene) return synthetic;
    return actor.getActiveTokens?.(true, false).find((token) => token.document.parent === canvas.scene) ?? null;
  }

  function collectCandidates(source) {
    const { region, actor, selfToken } = source;
    const casterAlliance = actor?.alliance ?? (game.user.isGM ? "opposition" : "party");
    const coverage = typeof region.getCoverage === "function" ? region.getCoverage() : null;
    const blockedKeys = new Set((coverage?.blocked ?? []).map(offsetKey));
    const rows = [];

    for (const token of canvas.tokens.placeables) {
      const doc = token.document;
      const targetActor = token.actor;
      if (!targetActor?.isOfType?.("creature", "hazard", "vehicle")) continue;
      if (!game.user.isGM && (doc.hidden || !token.visible)) continue;

      const inside = testInside(doc, region);
      const blocked = !inside && blockedKeys.size > 0 && occupiedOffsets(doc).some((offset) => blockedKeys.has(offsetKey(offset)));
      if (!inside && !blocked) continue;

      const alliance = targetActor.alliance ?? null;
      const relation = token === selfToken ? "self"
        : alliance === null ? "neutral"
          : alliance === casterAlliance ? "ally" : "enemy";
      rows.push({
        id: doc.id,
        token,
        name: displayName(doc),
        img: doc.texture?.src || targetActor.img,
        relation,
        blocked,
        hidden: !!doc.hidden,
        dead: !!targetActor.isDead,
        hp: visibleHitPoints(targetActor),
      });
    }

    const order = { self: 0, enemy: 1, ally: 2, neutral: 3 };
    return rows.sort((a, b) => Number(a.blocked) - Number(b.blocked)
      || order[a.relation] - order[b.relation]
      || a.name.localeCompare(b.name, "ru"));
  }

  function testInside(doc, region) {
    // PF2e 8 overrides this to use its grid coverage: walls, elevation and every occupied square.
    if (typeof doc.testInsideRegion === "function") return doc.testInsideRegion(region);
    return region.tokens?.has?.(doc) ?? false;
  }

  function occupiedOffsets(doc) {
    const grid = canvas.grid;
    const width = Math.max(1, Math.round(doc.width ?? 1));
    const height = Math.max(1, Math.round(doc.height ?? 1));
    const origin = grid.getOffset({
      x: doc.x + Math.min(width * grid.sizeX, grid.sizeX) / 2,
      y: doc.y + Math.min(height * grid.sizeY, grid.sizeY) / 2,
    });
    const offsets = [];
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < width; j++) offsets.push({ i: origin.i + i, j: origin.j + j });
    }
    return offsets;
  }

  function offsetKey({ i, j }) {
    return `${i},${j}`;
  }

  function displayName(doc) {
    if (game.user.isGM || doc.isOwner) return doc.name;
    const modes = CONST.TOKEN_DISPLAY_MODES;
    return [modes.HOVER, modes.ALWAYS].includes(doc.displayName) ? doc.name : "Неизвестное существо";
  }

  function visibleHitPoints(actor) {
    if (!game.user.isGM && !actor.isOwner) return null;
    const hp = actor.hitPoints ?? actor.system?.attributes?.hp;
    if (!hp || !Number.isFinite(hp.max) || hp.max <= 0) return null;
    return { value: hp.value, max: hp.max, ratio: Math.max(0, Math.min(1, hp.value / hp.max)) };
  }

  function isIncluded(row, options) {
    if (row.dead || row.blocked || row.hidden) return false;
    if (row.relation === "self") return options.self && options.mode !== "enemies";
    if (row.relation === "neutral") return options.mode === "all" && options.neutral;
    if (options.mode === "all") return true;
    return options.mode === (row.relation === "ally" ? "allies" : "enemies");
  }

  function describeSource({ item, origin, actor, region }) {
    const name = item?.name ?? origin.name ?? region.name ?? "Область";
    const details = [];
    if (actor?.name) details.push(actor.name);
    const area = item?.system?.area;
    const shape = area?.type ?? region.flags?.pf2e?.areaShape;
    if (shape) {
      const key = `PF2E.Area.Shape.${shape}`;
      const label = game.i18n.has(key) ? game.i18n.localize(key) : shape;
      details.push(area?.value ? `${label} ${area.value} фт` : label);
    }
    if (item?.isOfType?.("spell") && Number.isFinite(item.rank)) details.push(`ранг ${item.rank}`);

    let save = null;
    const defense = item?.system?.defense?.save;
    if (defense?.statistic) {
      const statKey = CONFIG.PF2E?.saves?.[defense.statistic];
      const label = statKey ? game.i18n.localize(statKey) : defense.statistic;
      const dc = item.spellcasting?.statistic?.dc?.value;
      save = { label, dc: Number.isFinite(dc) ? dc : null, basic: !!defense.basic };
    }

    const traitSource = item?.system?.traits?.value ?? origin.traits ?? [];
    const traits = traitSource.slice(0, 6).map((trait) => {
      const key = CONFIG.PF2E?.spellTraits?.[trait] ?? CONFIG.PF2E?.actionTraits?.[trait];
      return key ? game.i18n.localize(key) : trait;
    });

    return { name, img: item?.img ?? "icons/svg/explosion.svg", details, save, traits };
  }

  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function initialPosition() {
    const width = 420;
    const point = canvas.mousePosition;
    const client = point && typeof canvas.clientCoordinatesFromCanvas === "function"
      ? canvas.clientCoordinatesFromCanvas(point) : null;
    if (!client) return { width };
    const left = Math.min(Math.max(client.x + 60, 10), window.innerWidth - width - 320);
    const top = Math.min(Math.max(client.y - 160, 10), window.innerHeight - 560);
    return { width, left: Math.max(left, 10), top: Math.max(top, 10) };
  }

  class TemplateTargetingApp extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      tag: "div",
      classes: ["eliott-template-targets"],
      window: { title: "Цели в области", icon: "fa-solid fa-crosshairs", resizable: false },
      position: { width: 420, height: "auto" },
    };

    constructor(region, animation = null) {
      super({ id: `eliott-template-targets-${region.id}`, position: initialPosition() });
      this.region = region;
      this.animation = animation;
      this.source = resolveSource(region);
      this.summary = describeSource(this.source);
      this.choices = loadOptions();
      this.overrides = new Map();
      this.hovered = null;
      this.rows = collectCandidates(this.source);
    }

    get title() {
      return this.summary?.name ? `Цели: ${this.summary.name}` : "Цели в области";
    }

    refresh() {
      if (!this.rendered || this.regionDeleted) return;
      this.rows = collectCandidates(this.source);
      this.render();
    }

    onRegionDeleted() {
      this.regionDeleted = true;
      if (this.rendered) this.render();
    }

    checked(row) {
      return this.overrides.get(row.id) ?? isIncluded(row, this.choices);
    }

    selection() {
      return this.rows.filter((row) => this.checked(row));
    }

    async _renderHTML() {
      return this.content();
    }

    _replaceHTML(html, content) {
      const list = content.querySelector("[data-list]");
      const scroll = list?.scrollTop ?? 0;
      content.innerHTML = html;
      content.querySelector("[data-list]")?.scrollTo(0, scroll);
    }

    content() {
      const { summary, choices: options } = this;
      const selected = this.selection();
      const hasSelf = this.rows.some((row) => row.relation === "self") || !!this.source.selfToken;
      const counts = Object.fromEntries(modes.map((mode) => [mode.id,
        this.rows.filter((row) => isIncluded(row, { ...options, mode: mode.id })).length]));

      const save = summary.save
        ? `<span class="ett-save"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> ${escape(summary.save.label)}${summary.save.dc ? ` · КС ${summary.save.dc}` : ""}${summary.save.basic ? " · базовый" : ""}</span>`
        : "";
      const traits = summary.traits.length
        ? `<div class="ett-traits">${summary.traits.map((trait) => `<span>${escape(trait)}</span>`).join("")}</div>` : "";

      const modeButtons = modes.map((mode) => `<button type="button" class="ett-mode ${options.mode === mode.id ? "is-active" : ""}" data-mode="${mode.id}" aria-pressed="${options.mode === mode.id}">
          <i class="fa-solid ${mode.icon}" aria-hidden="true"></i><span>${mode.label}</span><b>${counts[mode.id]}</b></button>`).join("");

      const toggle = (key, label, icon, disabled, hint) => `<label class="ett-toggle ${disabled ? "is-disabled" : ""}" title="${escape(hint)}">
          <input type="checkbox" data-option="${key}" ${options[key] ? "checked" : ""} ${disabled ? "disabled" : ""}>
          <span class="ett-switch" aria-hidden="true"></span><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</label>`;

      const rows = this.rows.map((row) => {
        const checked = this.checked(row);
        const auto = isIncluded(row, options);
        const tags = [
          `<span class="ett-tag ett-rel-${row.relation}">${relations[row.relation]}</span>`,
          row.blocked ? `<span class="ett-tag ett-warn" title="Линия эффекта к существу перекрыта стеной"><i class="fa-solid fa-road-barrier" aria-hidden="true"></i> За стеной</span>` : "",
          row.hidden ? `<span class="ett-tag ett-muted"><i class="fa-solid fa-eye-slash" aria-hidden="true"></i> Скрыт</span>` : "",
          row.dead ? `<span class="ett-tag ett-muted"><i class="fa-solid fa-skull-crossbones" aria-hidden="true"></i> Мёртв</span>` : "",
          this.overrides.has(row.id) && checked !== auto ? `<span class="ett-tag ett-manual">вручную</span>` : "",
        ].join("");
        const hp = row.hp
          ? `<span class="ett-hp" title="ОЗ ${row.hp.value} / ${row.hp.max}"><span style="width:${Math.round(row.hp.ratio * 100)}%"></span></span><span class="ett-hp-text">${row.hp.value}/${row.hp.max}</span>`
          : "";
        return `<label class="ett-row ett-rel-${row.relation} ${checked ? "is-checked" : ""} ${row.blocked ? "is-blocked" : ""}" data-row="${escape(row.id)}">
            <input type="checkbox" data-token="${escape(row.id)}" ${checked ? "checked" : ""}>
            <span class="ett-avatar"><img src="${escape(row.img)}" alt=""></span>
            <span class="ett-row-body"><strong>${escape(row.name)}</strong><span class="ett-tags">${tags}</span></span>
            <span class="ett-row-side">${hp}</span>
            <span class="ett-check" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
          </label>`;
      }).join("");

      const confirmLabel = selected.length ? `Выбрать цели <b>${selected.length}</b>` : "Снять все цели";
      return `<div class="ett-shell">
        <header class="ett-spell">
          <img src="${escape(summary.img)}" alt="">
          <div class="ett-spell-text">
            <h2>${escape(summary.name)}</h2>
            <p>${summary.details.map(escape).join(" · ")}</p>
            ${save}
          </div>
        </header>
        ${traits}
        <nav class="ett-modes" aria-label="Кого выбирать">${modeButtons}</nav>
        <div class="ett-toggles">
          ${toggle("self", "Себя", "fa-user", !hasSelf || options.mode === "enemies", hasSelf ? "Включить заклинателя, если он в области" : "Токен заклинателя не найден на сцене")}
          ${toggle("neutral", "Нейтральных", "fa-scale-balanced", options.mode !== "all", "Существа без стороны (союз «нейтральный») — только в режиме «Все»")}
        </div>
        <section class="ett-list-wrap">
          <div class="ett-list-head">
            <span>В области: <b>${this.rows.filter((row) => !row.blocked).length}</b>${this.rows.some((row) => row.blocked) ? ` <em>· за стеной: ${this.rows.filter((row) => row.blocked).length}</em>` : ""}</span>
            <span class="ett-list-actions">
              <button type="button" data-action="check-all" title="Отметить всех в списке"><i class="fa-solid fa-check-double" aria-hidden="true"></i></button>
              <button type="button" data-action="check-none" title="Снять отметки"><i class="fa-regular fa-square" aria-hidden="true"></i></button>
              <button type="button" data-action="reset" title="Сбросить ручные изменения" ${this.overrides.size ? "" : "disabled"}><i class="fa-solid fa-rotate-left" aria-hidden="true"></i></button>
            </span>
          </div>
          <div class="ett-list" data-list>${rows || `<div class="ett-empty"><i class="fa-solid fa-ghost" aria-hidden="true"></i><span>В области нет существ</span></div>`}</div>
        </section>
        <footer class="ett-footer">
          ${this.animation?.claimed && !this.animation.settled
            ? `<p class="ett-anim-wait"><i class="fa-solid fa-film" aria-hidden="true"></i> Анимация начнётся после подтверждения</p>` : ""}
          ${this.regionDeleted
            ?`<p class="ett-gone"><i class="fa-solid fa-wand-sparkles" aria-hidden="true"></i> Шаблон уже убран анимацией — список целей сохранён</p>`
            : `<label class="ett-toggle ett-dismiss"><input type="checkbox" data-option="dismiss" ${options.dismiss ? "checked" : ""}><span class="ett-switch" aria-hidden="true"></span>Убрать шаблон после выбора</label>`}
          <div class="ett-buttons">
            <button type="button" class="ett-cancel" data-action="cancel"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Отмена</button>
            <button type="button" class="ett-confirm" data-action="confirm"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i> ${confirmLabel}</button>
          </div>
          <p class="ett-hint"><kbd>Enter</kbd> подтвердить · <kbd>Esc</kbd> закрыть · <kbd>Ctrl</kbd> при размещении — без окна</p>
        </footer>
      </div>`;
    }

    _onFirstRender(context, options) {
      super._onFirstRender?.(context, options);
      const root = this.element;
      root.addEventListener("click", (event) => this.onClick(event));
      root.addEventListener("change", (event) => this.onChange(event));
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.target.closest?.("button")) return;
        event.preventDefault();
        void this.confirm();
      });
      root.addEventListener("pointerover", (event) => this.hover(event.target.closest?.("[data-row]")?.dataset.row ?? null));
      root.addEventListener("pointerleave", () => this.hover(null));
    }

    _onRender(context, options) {
      super._onRender?.(context, options);
      if (this.focused) return;
      this.focused = true;
      this.element.querySelector(".ett-confirm")?.focus({ preventScroll: true });
    }

    onClick(event) {
      const mode = event.target.closest?.("[data-mode]")?.dataset.mode;
      if (mode) {
        this.choices.mode = mode;
        this.overrides.clear();
        this.render();
        return;
      }
      const action = event.target.closest?.("[data-action]")?.dataset.action;
      if (!action) return;
      event.preventDefault();
      if (action === "confirm") void this.confirm();
      else if (action === "cancel") void this.close();
      else if (action === "check-all" || action === "check-none") {
        for (const row of this.rows) this.overrides.set(row.id, action === "check-all");
        this.render();
      } else if (action === "reset") {
        this.overrides.clear();
        this.render();
      }
    }

    onChange(event) {
      const input = event.target;
      if (input.dataset.option) {
        this.choices[input.dataset.option] = input.checked;
        if (input.dataset.option !== "dismiss") this.overrides.clear();
        this.render();
      } else if (input.dataset.token) {
        this.overrides.set(input.dataset.token, input.checked);
        this.render();
      }
    }

    hover(id) {
      if (this.hovered?.id === id) return;
      setTokenHover(this.hovered?.token, false);
      const row = id ? this.rows.find((entry) => entry.id === id) : null;
      this.hovered = row ?? null;
      setTokenHover(row?.token, true);
    }

    async confirm() {
      const ids = this.selection().map((row) => row.id).filter((id) => canvas.tokens.get(id));
      setTargets(ids);
      saveOptions(this.choices);
      let dismiss = this.choices.dismiss && !this.regionDeleted && !!this.region.parent?.regions?.get(this.region.id);
      const animation = this.animation;
      animation?.settle({ targets: ids.map((id) => canvas.tokens.get(id)), dismiss: this.choices.dismiss });
      await this.close();
      if (dismiss && animation) {
        // A claimed animation removes the area itself once it has played.
        await waitForAnimationClaim(animation);
        dismiss = !animation.claimed && !!this.region.parent?.regions?.get(this.region.id);
      }
      if (dismiss) {
        try {
          await this.region.delete();
        } catch (error) {
          console.error(`${logPrefix} | Could not remove effect area`, error);
        }
      }
    }

    async close(options) {
      this.hover(null);
      // Cancelled or closed: play the animation with the current targets and keep the area.
      this.animation?.settle({ targets: [...(game.user.targets ?? [])], dismiss: false });
      if (current === this) current = null;
      return super.close(options);
    }
  }

  function setTokenHover(token, state) {
    if (!token || token.destroyed) return;
    try {
      if (state) token._onHoverIn?.(new PointerEvent("pointerover"), { hoverOutOthers: false });
      else token._onHoverOut?.(new PointerEvent("pointerout"));
    } catch {
      // Highlighting is cosmetic; the canvas API differs between core versions.
    }
  }

  function setTargets(ids) {
    if (typeof canvas.tokens.setTargets === "function") {
      canvas.tokens.setTargets(ids);
      return;
    }
    const wanted = new Set(ids);
    for (const token of game.user.targets) if (!wanted.has(token.id)) token.setTarget(false, { releaseOthers: false });
    for (const id of ids) canvas.tokens.get(id)?.setTarget(true, { releaseOthers: false });
  }
})();
