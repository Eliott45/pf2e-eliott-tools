(function () {
  const tools = globalThis.pf2eEliottTools;
  const { flagPath, id: moduleId, logPrefix } = tools.module;
  const oathDamageTypeKey = "PF2E.IWR.Custom.DamageFromSwornCreatures";
  const oathDamageTypeFallback = "damage from sworn creature kind";

  tools.features ??= {};
  tools.features.champion ??= {};

  tools.features.champion.oathOfTheDefender = {
    onCreateChatMessage,
    onRenderChatMessage,
  };

  async function onCreateChatMessage(message) {
    try {
      await maybeFixOathOfTheDefenderAura(message);
    } catch (error) {
      console.error(`${logPrefix} | oath of the defender fix failed`, error);
    }
  }

  function onRenderChatMessage(message, html) {
    try {
      void applyRenderedMessageFixes(message, html);
    } catch (error) {
      console.error(`${logPrefix} | oath of the defender render fix failed`, error);
    }
  }

  async function maybeFixOathOfTheDefenderAura(message) {
    const pf2e = message?.flags?.pf2e;
    if (pf2e?.context?.type !== "damage-taken") return;
    if (foundry.utils.getProperty(message, flagPath)) return;

    const applications = getIwrApplications(message);
    if (applications.length === 0) return;

    const oathApplications = applications.filter(isOathOfTheDefenderApplication);
    if (oathApplications.length < 2) return;

    const totalApplied = oathApplications.reduce(
      (sum, application) => sum + Math.abs(Number(application.adjustment) || 0),
      0
    );
    const intendedApplied = oathApplications.reduce(
      (highest, application) => Math.max(highest, Math.abs(Number(application.adjustment) || 0)),
      0
    );
    const correctionAmount = totalApplied - intendedApplied;
    if (!(correctionAmount > 0)) return;

    const collapsedApplications = collapseOathOfTheDefenderApplications(applications);
    const correctionPlan = buildCorrectionPlan(message.actor ?? null, pf2e.appliedDamage, correctionAmount);
    const content = rewriteMessageContent(
      message.content,
      collapsedApplications,
      correctionPlan.displayDamage
    );

    console.info(`${logPrefix} | correcting oath of the defender aura`, {
      messageId: message.id,
      actor: message.actor?.name ?? null,
      oldApplications: applications,
      newApplications: collapsedApplications,
      correctionAmount,
      actorUpdates: correctionPlan.actorUpdates,
      appliedDamageUpdates: correctionPlan.appliedDamageUpdates,
      displayDamage: correctionPlan.displayDamage,
    });

    if (correctionPlan.actor && correctionPlan.actorUpdates) {
      await correctionPlan.actor.update(correctionPlan.actorUpdates, {
        [`${moduleId}Correction`]: correctionAmount,
      });
    }

    await message.update({
      content,
      "flags.pf2e.appliedDamage.updates": correctionPlan.appliedDamageUpdates,
      [flagPath]: {
        correctionAmount,
        removedEntries: oathApplications.length - 1,
      },
    });

    const messageElement = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
    if (messageElement) {
      await applyRenderedMessageFixes(message, messageElement);
    }
  }

  function getIwrApplications(message) {
    const content = String(message.content ?? "");
    const match = /data-applications="([^"]+)"/.exec(content);
    if (!match) return [];

    try {
      return parseApplicationsAttribute(match[1]);
    } catch (_error) {
      console.warn(`${logPrefix} | failed to parse data-applications`, match[1]);
      return [];
    }
  }

  function parseApplicationsAttribute(serialized) {
    const trimmed = String(serialized ?? "").trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        // Fall through to HTML-decoding path below.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.innerHTML = trimmed;
    const decoded = textarea.value.trim();
    if (!decoded) return [];

    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [];
  }

  function isOathOfTheDefenderApplication(application) {
    if (application?.category !== "resistance") return false;

    const type = normalizeText(application.type);
    return getOathDamageTypePrefixes().some(
      (prefix) => type === prefix || type.startsWith(`${prefix} `)
    );
  }

  function getOathDamageTypePrefixes() {
    const localized = normalizeText(game?.i18n?.localize?.(oathDamageTypeKey));
    return [...new Set([localized, oathDamageTypeFallback].map(normalizeText).filter(Boolean))];
  }

  function collapseOathOfTheDefenderApplications(applications) {
    const oathIndexes = applications
      .map((application, index) => (isOathOfTheDefenderApplication(application) ? index : -1))
      .filter((index) => index >= 0);

    if (oathIndexes.length < 2) return applications;

    const strongest = oathIndexes.reduce((current, index) => {
      const candidate = applications[index];
      if (!current) return candidate;

      return Math.abs(Number(candidate.adjustment) || 0) > Math.abs(Number(current.adjustment) || 0)
        ? candidate
        : current;
    }, null);

    const firstIndex = oathIndexes[0];
    return applications
      .filter((_, index) => !oathIndexes.includes(index) || index === firstIndex)
      .map((application, index) => (index === firstIndex ? strongest : application));
  }

  function buildCorrectionPlan(actor, appliedDamage, correctionAmount) {
    const updates = Array.isArray(appliedDamage?.updates)
      ? foundry.utils.deepClone(appliedDamage.updates)
      : [];
    const actorUpdates = {};
    let remaining = correctionAmount;

    for (const path of [
      "system.attributes.hp.temp",
      "system.attributes.hp.sp.value",
      "system.attributes.hp.value",
    ]) {
      const entry = updates.find((update) => update?.path === path && Number(update.value) > 0);
      if (!entry || remaining <= 0) continue;

      const currentValue = foundry.utils.getProperty(actor, path);
      if (!Number.isFinite(currentValue)) continue;

      const nextValue = Math.max(currentValue - remaining, 0);
      const applied = currentValue - nextValue;
      if (applied <= 0) continue;

      actorUpdates[path] = nextValue;
      entry.value += applied;
      remaining -= applied;
    }

    const hpEntry = updates.find((update) => update?.path === "system.attributes.hp.value");

    return {
      actor,
      actorUpdates: Object.keys(actorUpdates).length > 0 ? actorUpdates : null,
      appliedDamageUpdates: updates.filter((update) => Number(update?.value) !== 0),
      displayDamage: hpEntry ? Number(hpEntry.value) || 0 : null,
    };
  }

  function rewriteMessageContent(content, applications, displayDamage) {
    let updated = replaceApplicationsInContent(content, applications);
    if (Number.isFinite(displayDamage)) {
      updated = replaceDisplayedDamageInHtml(updated, displayDamage);
    }
    return updated;
  }

  function replaceApplicationsInContent(content, applications) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = String(content ?? "");

    const iwr = wrapper.querySelector(".iwr");
    if (!iwr) return wrapper.innerHTML;

    iwr.setAttribute("data-applications", JSON.stringify(applications));
    return wrapper.innerHTML;
  }

  function replaceDisplayedDamageInHtml(content, displayDamage) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = String(content ?? "");

    const statements = wrapper.querySelector(".statements");
    if (!statements) return wrapper.innerHTML;

    replaceDisplayedDamageInElement(statements, displayDamage);
    return wrapper.innerHTML;
  }

  async function applyRenderedMessageFixes(message, html) {
    const correction = foundry.utils.getProperty(message, flagPath);
    if (!correction) return;

    const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!(root instanceof HTMLElement)) return;

    const iwr = root.querySelector(".iwr");
    if (iwr) {
      const applications = parseApplicationsAttribute(iwr.dataset.applications ?? "[]");
      iwr.dataset.applications = JSON.stringify(applications);
      iwr.dataset.tooltipClass = "pf2e";
      iwr.dataset.tooltipHtml = await foundry.applications.handlebars.renderTemplate(
        "systems/pf2e/templates/chat/damage/iwr-breakdown.hbs",
        { applications }
      );
    }

    const displayDamage = Number(
      message.flags?.pf2e?.appliedDamage?.updates?.find(
        (update) => update?.path === "system.attributes.hp.value"
      )?.value
    );
    if (!Number.isFinite(displayDamage)) return;

    const statements = root.querySelector(".statements");
    if (statements) {
      replaceDisplayedDamageInElement(statements, displayDamage);
    }
  }

  function replaceDisplayedDamageInElement(element, displayDamage) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode = null;

    while ((textNode = walker.nextNode())) {
      const text = textNode.nodeValue ?? "";
      const match = /(\d+)/.exec(text);
      if (!match) continue;

      textNode.nodeValue = `${text.slice(0, match.index)}${displayDamage}${text.slice(
        match.index + match[0].length
      )}`;
      return;
    }
  }

  function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
  }
})();
