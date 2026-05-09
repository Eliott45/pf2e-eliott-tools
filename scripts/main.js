(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const oathOfTheDefender = tools.features.champion.oathOfTheDefender;
  const criticalDeckTranslation = tools.features.criticalDeckTranslation;

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

  Hooks.on("createChatMessage", (...args) => {
    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      return oathOfTheDefender.onCreateChatMessage(...args);
    }
  });

  Hooks.on("renderChatMessage", (...args) => {
    if (isSettingEnabled(settings.oathOfTheDefenderEnabled)) {
      return oathOfTheDefender.onRenderChatMessage(...args);
    }
  });

  function registerSettings() {
    game.settings.register(moduleId, settings.oathOfTheDefenderEnabled, {
      name: "Включить фикс Oath of the Defender",
      hint: "Исправляет ауру чемпиона Oath of the Defender: сопротивление применяется только к самому большому подходящему инстансу урона.",
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

  function isSettingEnabled(key) {
    return game.settings.get(moduleId, key) !== false;
  }
})();
