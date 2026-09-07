await (async () => {
  const tools = globalThis.pf2eEliottTools;
  if (!tools) return ui.notifications.warn("Включите модуль PF2E Eliott Tools.");
  if (!tools.features?.regaliaIntensify) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = foundry.utils.getRoute("modules/pf2e-eliott-tools/scripts/features/regalia-intensify.js");
      script.onload = resolve;
      script.onerror = () => reject(new Error("Не удалось загрузить макрос регалии."));
      document.head.append(script);
    });
  }
  await tools.features.regaliaIntensify.open(typeof actor !== "undefined" ? actor : game.user.character);
})();
