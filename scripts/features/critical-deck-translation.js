(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix } = tools.module;

  const packName = "critical-deck-ru";
  const packId = `${moduleId}.${packName}`;
  const translationPath = `modules/${moduleId}/data/critical-deck-ru.json`;
  const featureFlagPath = `flags.${moduleId}.criticalDeckTranslation`;

  const criticalTableIds = new Set([
    "FTEpsIWWVrDj0jNG",
    "WzMGWMIrrPvSp75D",
  ]);

  let translatedEntryCache = null;

  tools.features ??= {};
  tools.features.criticalDeckTranslation = {
    onInit,
    onReady,
  };

  function onInit() {
    installRollTableDrawPatch();
  }

  function onReady() {
    installRollTableDrawPatch();
  }

  function installRollTableDrawPatch() {
    const rollTablePrototype = CONFIG.RollTable?.documentClass?.prototype ?? globalThis.RollTable?.prototype;
    if (!rollTablePrototype?.draw) return;
    if (rollTablePrototype._pf2eEliottCriticalDeckPatched) return;

    const originalDraw = rollTablePrototype.draw;
    rollTablePrototype.draw = async function (...args) {
      const draw = await originalDraw.call(this, ...args);

      try {
        await maybeRedirectCriticalDeckResults(this, draw);
      } catch (error) {
        console.error(`${logPrefix} | critical deck result redirect failed`, error);
      }

      return draw;
    };

    rollTablePrototype._pf2eEliottCriticalDeckPatched = true;
  }

  async function maybeRedirectCriticalDeckResults(table, draw) {
    if (!isEnabled()) return;
    if (!isSystemCriticalDeckTable(table)) return;

    const results = Array.isArray(draw?.results) ? draw.results : [];
    if (results.length === 0) return;

    const translatedEntries = await getTranslatedEntryMap();
    if (!translatedEntries || translatedEntries.size === 0) return;

    for (const result of results) {
      const sourceName = getResultName(result);
      const translatedEntry = translatedEntries.get(sourceName);
      if (!translatedEntry) continue;

      const update = {
        name: translatedEntry.name,
        text: translatedEntry.name,
        documentUuid: `Compendium.${packId}.JournalEntry.${translatedEntry._id}`,
        documentCollection: packId,
        documentId: translatedEntry._id,
      };

      if (typeof result.updateSource === "function") {
        result.updateSource(update);
      } else {
        Object.assign(result, update);
      }
    }
  }

  function isSystemCriticalDeckTable(table) {
    if (table?.pack !== "pf2e.rollable-tables") return false;
    if (criticalTableIds.has(table.id)) return true;

    const normalizedName = normalizeName(table.name);
    return normalizedName === "criticalhitdeck"
      || normalizedName === "criticalfumbledeck";
  }

  function getResultName(result) {
    return String(result?.name ?? result?.text ?? "").trim();
  }

  function isEnabled() {
    const setting = tools.module.settings?.criticalDeckTranslationEnabled;
    return !setting || game.settings.get(moduleId, setting) !== false;
  }

  async function loadCriticalDeckTranslations() {
    const response = await fetch(translationPath, { cache: "no-cache" });
    if (!response.ok) {
      console.warn(`${logPrefix} | critical deck translation file not found`, translationPath);
      return null;
    }

    const data = await response.json();
    const entries = data?.entries;
    if (!entries || typeof entries !== "object") {
      console.warn(`${logPrefix} | critical deck translation file has no entries`, translationPath);
      return null;
    }

    return entries;
  }

  async function getTranslatedEntryMap() {
    if (translatedEntryCache) return translatedEntryCache;

    const pack = game.packs.get(packId);
    if (!pack) return null;

    const index = await pack.getIndex({ fields: ["name", featureFlagPath] });
    const entriesByResultName = new Map(
      index
        .map((entry) => {
          const sourceName = foundry.utils.getProperty(entry, featureFlagPath)?.sourceName;
          return sourceName ? [sourceName, entry] : null;
        })
        .filter(Boolean)
    );

    const translations = await loadCriticalDeckTranslations();
    const sourceNamesByTranslatedName = new Map(
      Object.entries(translations ?? {})
        .map(([sourceName, translation]) => [translation?.name, sourceName])
        .filter(([translatedName]) => translatedName)
    );

    for (const entry of index) {
      if (entry.name) entriesByResultName.set(entry.name, entry);

      const sourceName = sourceNamesByTranslatedName.get(entry.name);
      if (sourceName) entriesByResultName.set(sourceName, entry);
    }

    translatedEntryCache = entriesByResultName;
    return translatedEntryCache;
  }

  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }
})();
