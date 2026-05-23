(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, settings } = tools.module;

  tools.features ??= {};
  tools.features.combatTrackerEnhancements = {
    onUpdateCombat,
    onDeleteCombat,
    onRenderCombatTracker,
  };

  function onUpdateCombat(_combat, changes) {
    if (!isTurnChange(changes)) return;

    clearCurrentTargets();
  }

  function onDeleteCombat() {
    clearCurrentTargets();
  }

  function onRenderCombatTracker(_app, html) {
    if (!isSettingEnabled(settings.combatTrackerHpRingEnabled)) return;
    if (!game.combat) return;

    const root = getHtmlElement(html);
    if (!root) return;

    for (const row of root.querySelectorAll(".combatant[data-combatant-id]")) {
      const combatant = game.combat.combatants.get(row.dataset.combatantId);
      if (!combatant || !shouldShowHpRing(combatant)) continue;

      const tokenImage = row.querySelector(".token-image");
      if (!tokenImage || tokenImage.closest(".eliott-hp-ring-wrapper")) continue;

      const hp = getHpResource(combatant);
      if (!hp) continue;

      const wrapper = document.createElement("div");
      wrapper.className = "eliott-hp-ring-wrapper";
      tokenImage.replaceWith(wrapper);
      wrapper.append(tokenImage, buildHpRing(hp));
    }
  }

  function clearCurrentTargets() {
    if (!isSettingEnabled(settings.clearTargetsOnTurnEndEnabled)) return;
    if (!game.user?.targets?.size) return;

    for (const token of [...game.user.targets]) {
      token.setTarget(false, { releaseOthers: false });
    }

    game.user.targets.clear();
  }

  function isTurnChange(changes) {
    return foundry.utils.hasProperty(changes, "round")
      || foundry.utils.hasProperty(changes, "turn")
      || foundry.utils.hasProperty(changes, "active");
  }

  function shouldShowHpRing(combatant) {
    const token = combatant.token;
    const displayMode = getDisplayModeName(token?.displayBars);

    if (displayMode === "NONE") {
      return game.user.isGM;
    }

    if (displayMode?.includes("OWNER")) {
      return game.user.isGM || combatant.isOwner;
    }

    return displayMode !== null;
  }

  function getHpResource(combatant) {
    const token = combatant.token;
    const attribute = token?.bar1?.attribute || "attributes.hp";
    const resource = token?.getBarAttribute?.(null, { alternative: attribute });

    if (resource?.type !== "bar") return null;

    const current = Number(resource.value);
    const max = Number(resource.max);
    if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return null;

    return { current: Math.max(0, current), max };
  }

  function buildHpRing({ current, max }) {
    const radius = 16;
    const strokeWidth = 4;
    const diameter = radius * 2 + strokeWidth;
    const circumference = radius * 2 * Math.PI;
    const percent = Math.max(0, Math.min(1, current / max));
    const offset = circumference - percent * circumference;
    const colorClass = Math.round((percent * 100) / 10) * 10;
    const position = diameter / 2;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");

    svg.classList.add("eliott-hp-ring", `eliott-hp-ring--${colorClass}`);
    svg.setAttribute("viewBox", `0 0 ${diameter} ${diameter}`);
    svg.setAttribute("width", String(diameter));
    svg.setAttribute("height", String(diameter));

    circle.classList.add("eliott-hp-ring__circle");
    circle.setAttribute("stroke-width", String(strokeWidth));
    circle.setAttribute("stroke-dasharray", String(circumference));
    circle.setAttribute("stroke-dashoffset", String(offset));
    circle.setAttribute("fill", "transparent");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("cx", String(position));
    circle.setAttribute("cy", String(position));
    svg.append(circle);

    return svg;
  }

  function getDisplayModeName(value) {
    const entry = Object.entries(CONST.TOKEN_DISPLAY_MODES).find(([, modeValue]) => modeValue === value);
    return entry?.[0] ?? null;
  }

  function getHtmlElement(html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (html?.element instanceof HTMLElement) return html.element;
    return null;
  }

  function isSettingEnabled(key) {
    return game.settings.get(moduleId, key) !== false;
  }
})();
