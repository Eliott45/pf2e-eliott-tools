(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const runes = new Map([
    ["acidResistant", ["acid", 5]],
    ["coldResistant", ["cold", 5]],
    ["electricityResistant", ["electricity", 5]],
    ["fireResistant", ["fire", 5]],
    ["greaterAcidResistant", ["acid", 10]],
    ["greaterColdResistant", ["cold", 10]],
    ["greaterElectricityResistant", ["electricity", 10]],
    ["greaterFireResistant", ["fire", 10]],
  ]);
  let installed = false;

  tools.features ??= {};
  tools.features.energyResistantRunes = { onInit };

  function onInit() {
    if (installed) return;
    const prototype = CONFIG.PF2E?.Item?.documentClasses?.armor?.prototype;
    const Resistance = game.pf2e?.RuleElements?.builtin?.Resistance;
    if (typeof prototype?.prepareRuleElements !== "function" || !Resistance) {
      console.warn(`${logPrefix} | Energy-Resistant rune automation is unavailable in this PF2e version`);
      return;
    }

    const original = prototype.prepareRuleElements;
    prototype.prepareRuleElements = function (options = {}) {
      const rules = original.call(this, options);
      if (game.settings.get(moduleId, settings.energyResistantRunesEnabled) === false
        || !this.actor?.canHostRuleElements || !this.isEquipped || this.isInvested === false) return rules;

      try {
        // Prepared runes already respect available slots and the world's ABP variant.
        // Keep generated rules transient: never alter the armor's saved rule elements.
        const resistances = new Map();
        for (const slug of this.system.runes.property) {
          const rune = runes.get(slug);
          if (!rune) continue;
          const [type, value] = rune;
          resistances.set(type, Math.max(value, resistances.get(type) ?? 0));
        }
        for (const [type, value] of resistances) {
          rules.push(new Resistance({ key: "Resistance", type: [type], value }, {
            ...options, parent: this,
          }));
        }
      } catch (error) {
        console.error(`${logPrefix} | Could not prepare Energy-Resistant runes`, error);
      }
      // Native Resistance rules handle stacking, exceptions, and damage application.
      return rules;
    };
    installed = true;
  }
})();
