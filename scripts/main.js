(function () {
  const tools = globalThis.pf2eEliottTools;
  const { logPrefix } = tools.module;
  const oathOfTheDefender = tools.features.champion.oathOfTheDefender;

  Hooks.once("init", () => {
    console.log(`${logPrefix} | init`);
  });

  Hooks.once("ready", () => {
    console.log(`${logPrefix} | ready`);
  });

  Hooks.on("createChatMessage", oathOfTheDefender.onCreateChatMessage);
  Hooks.on("renderChatMessage", oathOfTheDefender.onRenderChatMessage);
})();
