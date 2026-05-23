(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const oathOfTheDefender = tools.features.champion.oathOfTheDefender;
  const shieldsOfTheSpirit = tools.features.spells.shieldsOfTheSpirit;
  const criticalDeckTranslation = tools.features.criticalDeckTranslation;
  const combatTrackerEnhancements = tools.features.combatTrackerEnhancements;

  Hooks.once("init", () => {
    registerSettings();

    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      oathOfTheDefender.onInit();
    }

    criticalDeckTranslation.onInit();

    console.log(`${logPrefix} | init`);
  });

  Hooks.once("ready", () => {
    criticalDeckTranslation.onReady();

    console.log(`${logPrefix} | ready`);
  });

  Hooks.on("updateCombat", (...args) => {
    combatTrackerEnhancements.onUpdateCombat(...args);
  });

  Hooks.on("deleteCombat", (...args) => {
    combatTrackerEnhancements.onDeleteCombat(...args);
  });

  Hooks.on("renderCombatTracker", (...args) => {
    combatTrackerEnhancements.onRenderCombatTracker(...args);
  });

  Hooks.on("renderSettingsConfig", (...args) => {
    onRenderSettingsConfig(...args);
  });

  Hooks.on("createChatMessage", (...args) => {
    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      void oathOfTheDefender.onCreateChatMessage(...args);
    }

    if (isSettingEnabled(settings.shieldsOfTheSpiritEnabled)) {
      void shieldsOfTheSpirit.onCreateChatMessage(...args);
    }
  });

  Hooks.on("renderChatMessage", (...args) => {
    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      return oathOfTheDefender.onRenderChatMessage(...args);
    }
  });

  function registerSettings() {
    game.settings.register(moduleId, settings.clearTargetsOnTurnEndEnabled, {
      name: "Сбрасывать цели в конце хода",
      hint: "Автоматически снимает все ваши цели при смене хода или раунда в боевом трекере. Настройка индивидуальна для каждого игрока.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.combatTrackerHpRingEnabled, {
      name: "Показывать HP-кольцо в трекере",
      hint: "Добавляет круговой индикатор здоровья вокруг портрета участника боя, учитывая видимость HP-бара токена.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.oathOfTheDefenderEnabled, {
      name: "Включить фикс Oath of the Defender",
      hint: "Исправляет ауру чемпиона Oath of the Defender: сопротивление применяется только к самому большому подходящему инстансу урона.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.shieldsOfTheSpiritEnabled, {
      name: "Включить автоматизацию Shields of the Spirit",
      hint: "Автоматически бросает spirit-урон по атакующему, когда он делает действие с признаком attack против цели с эффектом Shields of the Spirit.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(moduleId, settings.criticalDeckTranslationEnabled, {
      name: "Включить русский оверрайд крит-колоды",
      hint: "Перенаправляет броски PF2e Critical Hit/Fumble Deck на русские записи журнала из этого модуля.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });
  }

  function getSettingsGroups() {
    return [
      {
        title: "Бой",
        settings: [
          {
            key: settings.clearTargetsOnTurnEndEnabled,
            name: "Сбрасывать цели в конце хода",
            hint: "Автоматически снимает все ваши цели при смене хода или раунда в боевом трекере.",
            scope: "client",
          },
          {
            key: settings.combatTrackerHpRingEnabled,
            name: "Показывать HP-кольцо в трекере",
            hint: "Добавляет круговой индикатор здоровья вокруг портрета участника боя, учитывая видимость HP-бара токена.",
            scope: "world",
          },
        ],
      },
      {
        title: "Чемпион",
        settings: [
          {
            key: settings.oathOfTheDefenderEnabled,
            name: "Фикс Oath of the Defender",
            hint: "Исправляет ауру чемпиона Oath of the Defender: сопротивление применяется только к самому большому подходящему инстансу урона.",
            scope: "world",
          },
        ],
      },
      {
        title: "Автоматизация заклинаний",
        settings: [
          {
            key: settings.shieldsOfTheSpiritEnabled,
            name: "Shields of the Spirit",
            hint: "Автоматически бросает spirit-урон по атакующему, когда он делает действие с признаком attack против цели с эффектом Shields of the Spirit.",
            scope: "world",
          },
        ],
      },
      {
        title: "Перевод и колоды",
        settings: [
          {
            key: settings.criticalDeckTranslationEnabled,
            name: "Русский оверрайд крит-колоды",
            hint: "Перенаправляет броски PF2e Critical Hit/Fumble Deck на русские записи журнала из этого модуля.",
            scope: "world",
          },
        ],
      },
    ];
  }

  function isSettingEnabled(key) {
    return game.settings.get(moduleId, key) !== false;
  }

  function onRenderSettingsConfig(_app, html) {
    const root = getHtmlElement(html);
    if (!root) return;

    root.querySelectorAll(".pf2e-eliott-settings-heading").forEach((heading) => heading.remove());
    hideSettingRowForPlayers(root, settings.combatTrackerHpRingEnabled);

    for (const group of getSettingsGroups()) {
      const firstRow = findSettingRow(root, group.settings[0]?.key);
      if (!firstRow) continue;

      const heading = document.createElement("h2");
      heading.className = "pf2e-eliott-settings-heading";
      heading.textContent = group.title;
      firstRow.before(heading);
    }
  }

  function findSettingRow(root, key) {
    if (!key) return null;

    const input = root.querySelector(`[name="${moduleId}.${key}"], [name="${key}"]`);
    return input?.closest(".form-group")
      ?? input?.closest("fieldset")
      ?? input?.parentElement
      ?? null;
  }

  function hideSettingRowForPlayers(root, key) {
    if (game.user.isGM) return;

    findSettingRow(root, key)?.remove();
  }

  function getHtmlElement(html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (html?.element instanceof HTMLElement) return html.element;
    return null;
  }
})();
