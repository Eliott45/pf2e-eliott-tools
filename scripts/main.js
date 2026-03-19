const MODULE_ID = "pf2e-eliott-tools";
const FLAG_PATH = `flags.${MODULE_ID}.correction`;
const LOG_PREFIX = "PF2E Eliott Tools";

Hooks.once("init", () => {
  console.log(`${LOG_PREFIX} | init`);
});

Hooks.once("ready", () => {
  console.log(`${LOG_PREFIX} | ready`);
});

Hooks.on("createChatMessage", async (message) => {
  try {
    await maybeFixSwornResistance(message);
  } catch (error) {
    console.error(`${LOG_PREFIX} | fix failed`, error);
  }
});

Hooks.on("renderChatMessage", (message, html) => {
  try {
    void applyRenderedMessageFixes(message, html);
  } catch (error) {
    console.error(`${LOG_PREFIX} | render fix failed`, error);
  }
});

async function maybeFixSwornResistance(message) {
  const pf2e = message?.flags?.pf2e;
  if (pf2e?.context?.type !== "damage-taken") return;
  if (foundry.utils.getProperty(message, FLAG_PATH)) return;

  const applications = getIwrApplications(message);
  if (applications.length === 0) return;

  const swornApplications = applications.filter(isSwornResistanceApplication);
  if (swornApplications.length < 2) return;

  const totalApplied = swornApplications.reduce(
    (sum, application) => sum + Math.abs(Number(application.adjustment) || 0),
    0
  );
  const intendedApplied = swornApplications.reduce(
    (highest, application) => Math.max(highest, Math.abs(Number(application.adjustment) || 0)),
    0
  );
  const correctionAmount = totalApplied - intendedApplied;
  if (!(correctionAmount > 0)) return;

  const collapsedApplications = collapseSwornResistanceApplications(applications);
  const correctionPlan = buildCorrectionPlan(actorFromMessage(message), pf2e.appliedDamage, correctionAmount);
  const content = rewriteMessageContent(message.content, applications, collapsedApplications, correctionPlan.displayDamage);

  console.info(`${LOG_PREFIX} | correcting sworn resistance`, {
    messageId: message.id,
    actor: actorFromMessage(message)?.name,
    oldApplications: applications,
    newApplications: collapsedApplications,
    correctionAmount,
    actorUpdates: correctionPlan.actorUpdates,
    appliedDamageUpdates: correctionPlan.appliedDamageUpdates,
    displayDamage: correctionPlan.displayDamage,
  });

  if (correctionPlan.actor && correctionPlan.actorUpdates) {
    await correctionPlan.actor.update(correctionPlan.actorUpdates, {
      [`${MODULE_ID}Correction`]: correctionAmount,
    });
  }

  await message.update({
    content,
    "flags.pf2e.appliedDamage.updates": correctionPlan.appliedDamageUpdates,
    [FLAG_PATH]: {
      correctionAmount,
      removedEntries: swornApplications.length - 1,
    },
  });

  const messageElement = document.querySelector(`li.chat-message[data-message-id="${message.id}"]`);
  if (messageElement) {
    await applyRenderedMessageFixes(message, messageElement);
  }
}

function actorFromMessage(message) {
  return message?.actor ?? null;
}

function getIwrApplications(message) {
  const content = String(message.content ?? "");
  const match = /data-applications="([^"]+)"/.exec(content);
  if (!match) return [];

  try {
    return parseApplicationsAttribute(match[1]);
  } catch (error) {
    console.warn(`${LOG_PREFIX} | failed to parse data-applications`, match[1]);
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

  if (decoded.startsWith("[")) {
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [];
  }

  const parsed = JSON.parse(decoded);
  return Array.isArray(parsed) ? parsed : [];
}

function isSwornResistanceApplication(application) {
  if (application?.category !== "resistance") return false;

  const type = normalizeText(application.type);
  return type === "damage from sworn creature kind" || type.startsWith("damage from sworn creature kind ");
}

function collapseSwornResistanceApplications(applications) {
  const swornIndexes = applications
    .map((application, index) => (isSwornResistanceApplication(application) ? index : -1))
    .filter((index) => index >= 0);

  if (swornIndexes.length < 2) return applications;

  const strongest = swornIndexes.reduce((current, index) => {
    const candidate = applications[index];
    if (!current) return candidate;

    return Math.abs(Number(candidate.adjustment) || 0) > Math.abs(Number(current.adjustment) || 0)
      ? candidate
      : current;
  }, null);

  const firstIndex = swornIndexes[0];
  return applications.filter((_, index) => !swornIndexes.includes(index) || index === firstIndex).map((application, index) =>
    index === firstIndex ? strongest : application
  );
}

function buildCorrectionPlan(actor, appliedDamage, correctionAmount) {
  const updates = Array.isArray(appliedDamage?.updates) ? foundry.utils.deepClone(appliedDamage.updates) : [];
  const actorUpdates = {};
  let remaining = correctionAmount;

  for (const path of [
    "system.attributes.hp.temp",
    "system.attributes.hp.sp.value",
    "system.attributes.hp.value",
  ]) {
    const entry = updates.find((update) => update?.path === path && Number(update.value) > 0);
    if (!entry || remaining <= 0) continue;

    const extraDamage = remaining;
    const currentValue = foundry.utils.getProperty(actor, path);
    if (Number.isFinite(currentValue) && extraDamage > 0) {
      const nextValue = Math.max(currentValue - extraDamage, 0);
      const applied = currentValue - nextValue;
      actorUpdates[path] = nextValue;
      entry.value += applied;
      remaining -= applied;
    }
  }

  const hpPath = "system.attributes.hp.value";
  const hpEntry = updates.find((update) => update?.path === hpPath);
  const displayDamage = hpEntry ? Number(hpEntry.value) || 0 : null;

  return {
    actor,
    actorUpdates: Object.keys(actorUpdates).length > 0 ? actorUpdates : null,
    appliedDamageUpdates: updates.filter((update) => Number(update?.value) !== 0),
    displayDamage,
  };
}

function rewriteMessageContent(content, oldApplications, newApplications, displayDamage) {
  let updated = replaceApplicationsInContent(content, newApplications);
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
  const correction = foundry.utils.getProperty(message, FLAG_PATH);
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

  const displayDamage = Number(message.flags?.pf2e?.appliedDamage?.updates?.find((u) => u?.path === "system.attributes.hp.value")?.value);
  if (Number.isFinite(displayDamage)) {
    const statements = root.querySelector(".statements");
    if (statements) {
      replaceDisplayedDamageInElement(statements, displayDamage);
    }
  }
}

function replaceDisplayedDamageInElement(element, displayDamage) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textNode = null;

  while ((textNode = walker.nextNode())) {
    const text = textNode.nodeValue ?? "";
    const match = /(\d+)/.exec(text);
    if (!match) continue;

    textNode.nodeValue = `${text.slice(0, match.index)}${displayDamage}${text.slice(match.index + match[0].length)}`;
    return;
  }
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}
