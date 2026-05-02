(function () {
  const moduleId = "pf2e-eliott-tools";

  const tools = (globalThis.pf2eEliottTools ??= {});
  tools.module = {
    id: moduleId,
    flagPath: `flags.${moduleId}.correction`,
    logPrefix: "PF2E Eliott Tools",
    settings: {
      oathOfTheDefenderEnabled: "oathOfTheDefenderEnabled",
      criticalDeckTranslationEnabled: "criticalDeckTranslationEnabled",
    },
  };
})();
