(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const manualOption = "barrows-edge:target-below-half";
  const knownOption = "target:eliott-tools:barrows-edge:hp-known";
  const belowOption = "target:eliott-tools:barrows-edge:below-half";
  let installed = false;

  tools.features ??= {};
  tools.features.barrowsEdge = { onInit };

  function enabled() {
    return game.settings.get(moduleId, settings.barrowsEdgeEnabled) !== false;
  }

  function onInit() {
    if (installed) return;
    const featPrototype = CONFIG.PF2E?.Item?.documentClasses?.feat?.prototype;
    let actorPrototype = CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype;
    // Find PF2e's shared Actor implementation, so NPC and synthetic-token targets
    // use the same hook without wrapping inherited methods more than once.
    while (actorPrototype && !Object.hasOwn(actorPrototype, "getSelfRollOptions")) {
      actorPrototype = Object.getPrototypeOf(actorPrototype);
    }
    const Predicate = game.pf2e?.Predicate;
    if (typeof featPrototype?.prepareRuleElements !== "function"
      || typeof actorPrototype?.getSelfRollOptions !== "function" || !Predicate) {
      console.warn(`${logPrefix} | Barrow's Edge automation is unavailable in this PF2e version`);
      return;
    }

    const getSelfRollOptions = actorPrototype.getSelfRollOptions;
    actorPrototype.getSelfRollOptions = function (prefix = "self", ...args) {
      const options = getSelfRollOptions.call(this, prefix, ...args);
      if (!enabled() || prefix !== "target") return options;
      // PF2e requests these from the actual roll-context target, including its
      // contextual clone. Never read a user's globally selected token here.
      const result = options.filter((option) => option !== knownOption && option !== belowOption);
      const hp = this.system.attributes?.hp;
      if (!Number.isFinite(hp?.value) || !Number.isFinite(hp?.max) || hp.max <= 0 || hp.value < 0) return result;
      result.push(knownOption);
      // Strict comparison handles odd maximum HP correctly; temporary HP is not HP.
      if (hp.value < hp.max / 2) result.push(belowOption);
      return result;
    };

    const prepareRuleElements = featPrototype.prepareRuleElements;
    featPrototype.prepareRuleElements = function (...args) {
      const rules = prepareRuleElements.apply(this, args);
      if (!enabled() || !(this.slug === "barrows-edge"
        || this.sourceId === "Compendium.pf2e.classfeatures.Item.LfgeEJgJdA8WAKV8")) return rules;

      for (const rule of rules) {
        if (rule.key !== "AdjustModifier" || rule.slug !== "barrows-edge-immanence"
          || rule.mode !== "multiply" || rule.value !== 3
          || !rule.selectors?.includes("weapon-damage") || !rule.predicate?.includes(manualOption)) continue;
        // Replace only the stock manual condition on the prepared rule. Keep its
        // multiplier, other conditions, weapon binding, spark and critical rules.
        // No saved item/rule data or roll-option toggles are changed.
        rule.predicate = new Predicate(...Array.from(rule.predicate, (statement) => statement === manualOption
          ? { or: [belowOption, { and: [{ not: knownOption }, manualOption] }] }
          : statement));
      }
      return rules;
    };
    installed = true;
  }
})();
