(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const entryPrefix = "eliott-weapon-familiarity-";
  const ranks = ["untrained", "trained", "expert", "master", "legendary"];
  let installed = false;

  tools.features ??= {};
  tools.features.weaponFamiliarity = { onInit };

  function onInit() {
    if (installed) return;
    const prototype = CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype;
    if (typeof prototype?.prepareMartialProficiencies !== "function" || !game.pf2e?.Predicate) {
      console.warn(`${logPrefix} | Weapon Familiarity fix is unavailable in this PF2e version`);
      return;
    }

    const original = prototype.prepareMartialProficiencies;
    prototype.prepareMartialProficiencies = function (...args) {
      try {
        addFamiliarityProficiencies(this);
      } catch (error) {
        console.error(`${logPrefix} | Weapon Familiarity fix failed`, error);
      }
      // PF2e calculates values/breakdowns and prepares Strikes using these ranks.
      return original.apply(this, args);
    };
    installed = true;
  }

  function addFamiliarityProficiencies(actor) {
    const attacks = actor.system.proficiencies.attacks;
    for (const key of Object.keys(attacks)) {
      if (key.startsWith(entryPrefix)) delete attacks[key];
    }
    if (game.settings.get(moduleId, settings.weaponFamiliarityEnabled) === false) return;

    // Only active familiarity rules participate. Do not infer feats from translated names
    // or chain sameAs entries (advanced -> martial -> simple would grant too much).
    const sources = actor.rules.filter((rule) => rule.key === "MartialProficiency"
      && !rule.ignored && rule.item?.slug?.endsWith("-weapon-familiarity")
      && ["simple", "martial"].includes(rule.sameAs)
      && attacks[rule.slug]?.sameAs === rule.sameAs);
    if (sources.length === 0) return;

    const targets = Object.entries(attacks).filter(([, entry]) => entry?.definition?.length
      && !entry.sameAs && Number.isInteger(entry.rank));
    const additions = {};
    const Predicate = game.pf2e.Predicate;
    for (const rule of sources) {
      const source = attacks[rule.slug];
      if (!source.definition?.length) continue;
      const maxRank = ranks.indexOf(source.maxRank ?? "legendary");
      if (maxRank < 0) continue;
      const baseline = Math.min(attacks[source.sameAs]?.rank ?? 0, maxRank);
      for (const [targetKey, target] of targets) {
        const rank = Math.min(target.rank, maxRank);
        if (rank <= baseline) continue;
        // Match the original weapon against familiarity, then evaluate the other
        // proficiency as if ONLY its category changed. Group/traits/base stay intact.
        const definition = new Predicate([
          ...source.definition,
          ...target.definition.map((statement) => withCategory(statement, source.sameAs)),
        ]);
        if (!definition.isValid) continue;
        additions[`${entryPrefix}${rule.slug}-${targetKey}`] = {
          definition,
          rank,
          label: `${game.i18n.localize(source.label)} — ${game.i18n.localize(target.label)}`,
          value: 0,
          breakdown: "",
          visible: source.visible !== false && target.visible !== false,
        };
      }
    }
    Object.assign(attacks, additions);
  }

  function withCategory(statement, category) {
    if (typeof statement === "string") {
      if (!statement.startsWith("item:category:")) return statement;
      // Empty AND/OR are PF2e's valid always-true/always-false statements.
      return statement === `item:category:${category}` ? { and: [] } : { or: [] };
    }
    // Comparison operands are values, not nested predicate statements.
    if (["eq", "gt", "gte", "lt", "lte"].some((key) => key in statement)) return statement;
    return Object.fromEntries(Object.entries(statement).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((child) => withCategory(child, category))
        : withCategory(value, category),
    ]));
  }
})();
