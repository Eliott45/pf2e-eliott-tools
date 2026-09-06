(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id } = tools.module;
  const feature = tools.features.bestiary;
  let app;
  let initialized = false;
  let ready = false;
  async function reset() {
    try {
      feature.store.requireGM();
      const accepted = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Сбросить бестиарий?" },
        content: "<p>Удалить все записи бестиария, раскрытые сведения и заметки группы в этом мире? Это действие необратимо. Несохранённые заметки также будут потеряны.</p><p>Акторы, токены, компендиумы и прочие журналы сохранятся.</p>",
        yes: { label: "Удалить данные бестиария" }, no: { label: "Отмена", default: true }, rejectClose: false,
      });
      if (!accepted) return false;
      await feature.store.reset();
      for (const window of feature.windows) {
        window.drafts.clear(); window.expandedSpells.clear(); window.selected = null; window.query = "";
        if (window.rendered) await window.render();
      }
      ui.notifications.info("Данные бестиария сброшены.");
      return true;
    } catch (error) {
      console.error("PF2E Eliott Tools | Bestiary reset", error);
      ui.notifications.error(error.message);
      return false;
    }
  }
  async function ensureResetMacro() {
    if (!game.user.isGM || (game.users.activeGM && game.users.activeGM.id !== game.user.id)) return;
    if (game.macros.some((macro) => macro.getFlag(id, "bestiaryReset"))) return;
    await Macro.create({ name: "Бестиарий — сброс данных", type: "script", img: "icons/svg/trash.svg", ownership: { default: 0 },
      flags: { [id]: { bestiaryReset: true } },
      command: 'const bestiary = game.modules.get("pf2e-eliott-tools")?.api?.bestiary;\nif (bestiary?.reset) await bestiary.reset();\nelse ui.notifications.warn("Обновите страницу Foundry с включённым модулем PF2E Eliott Tools.");' });
  }
  function open() {
    if (!game.settings.get(id, "bestiaryEnabled")) return ui.notifications.warn("Бестиарий отключён в настройках модуля.");
    app ??= new feature.Application();
    void app.render({ force: true }).then(() => app.bringToFront()).catch((error) => {
      console.error("PF2E Eliott Tools | Bestiary window", error);
      ui.notifications.error("Не удалось открыть бестиарий.");
    });
    return app;
  }
  function addButton(_application, html) {
    if (!game.settings.get(id, "bestiaryEnabled")) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector(".eliott-bestiary-launch")) return;
    const target = root.querySelector(".directory-header") ?? root.querySelector("header");
    if (!target) return;
    const button = document.createElement("button");
    button.type = "button"; button.className = "eliott-bestiary-launch";
    button.innerHTML = '<i class="fa-solid fa-book-open" aria-hidden="true"></i> Бестиарий группы';
    button.addEventListener("click", open);
    target.append(button);
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    game.settings.register(id, "bestiaryEnabled", { name: "Включить бестиарий группы", hint: "Каталог встреченных существ с общими заметками и раскрытием сведений. Открывается из списка акторов, журналов или Shift+B.", scope: "world", config: true, type: Boolean, default: true, requiresReload: true });
    game.settings.registerMenu(id, "bestiary", { name: "Бестиарий группы", label: "Открыть бестиарий", hint: "Существа и накопленные знания группы.", icon: "fas fa-book-open", type: feature.Application, restricted: false });
    if (game.ready) onReady();
  }
  function onReady() {
    if (ready) return;
    ready = true;
    tools.bestiary = { open, addActor: (actor, options) => feature.store.addActor(actor, options), reset };
    game.modules.get(id).api = { ...game.modules.get(id).api, bestiary: tools.bestiary };
    if (game.settings.get(id, "bestiaryEnabled")) void feature.store.repair().catch((error) => { console.error("PF2E Eliott Tools | Bestiary publication", error); ui.notifications.error("Не удалось синхронизировать бестиарий. Откройте карточку и повторите раскрытие."); });
    if (game.settings.get(id, "bestiaryEnabled")) void ensureResetMacro().catch((error) => { console.error("PF2E Eliott Tools | Bestiary macro", error); ui.notifications.error("Не удалось создать макрос сброса бестиария."); });
  }
  feature.initialize = initialize;
  Hooks.once("init", initialize);
  Hooks.once("ready", onReady);
  Hooks.on("renderActorDirectory", addButton);
  Hooks.on("renderJournalDirectory", addButton);
  for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry", "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"]) {
    Hooks.on(hook, (doc) => {
      if (!feature.store.data(doc) && !feature.store.data(doc.parent)) return;
      if (hook === "deleteJournalEntry") {
        for (const window of feature.windows) window.forgetEntry(doc.id, feature.store.data(doc)?.publicId);
      }
      for (const window of feature.windows) if (window.rendered && !window.busy) void window.render();
    });
  }
})();
