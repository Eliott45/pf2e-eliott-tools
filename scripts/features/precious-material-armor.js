(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const resultFlag = "preciousMaterialArmor";
  const processed = new WeakSet();
  const actorQueues = new Map();

  // Only materials whose armor entry explicitly specifies this trigger.
  // Dawnsilver counts as silver for damage, not for this non-damage effect.
  const materials = new Map([
    ["cold-iron", {
      weakness: "cold-iron",
      label: "Холодное железо",
      source: "https://2e.aonprd.com/Equipment.aspx?ID=2798",
    }],
    ["silver", {
      weakness: "silver",
      label: "Серебро",
      source: "https://2e.aonprd.com/Equipment.aspx?ID=2803",
    }],
    ["sovereign-steel", {
      weakness: "cold-iron",
      label: "Суверенная сталь",
      source: "https://2e.aonprd.com/Equipment.aspx?ID=777",
    }],
  ]);

  tools.features ??= {};
  tools.features.preciousMaterialArmor = { onCreateChatMessage };

  async function onCreateChatMessage(message) {
    if (!canProcess()) return;
    const context = message.flags?.pf2e?.context;
    if (context?.type !== "attack-roll" || context.outcome !== "criticalFailure") return;
    if (message.flags?.[moduleId]?.[resultFlag] || processed.has(message)) return;
    if (!isUnarmedAttack(message, context)) return;

    processed.add(message);
    try {
      const attacker = message.actor;
      if (!attacker?.isOfType("creature")) return;
      const target = await resolveTarget(message, context);
      if (!target?.isOfType("creature") || target.uuid === attacker.uuid) return;

      // Serialize conditions per actual actor UUID, including synthetic tokens.
      // Two quick strikes must not both create a fresh Sickened condition.
      const previous = actorQueues.get(attacker.uuid) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(() => applyMaterialEffect(message, attacker, target));
      actorQueues.set(attacker.uuid, task);
      try {
        await task;
      } finally {
        if (actorQueues.get(attacker.uuid) === task) actorQueues.delete(attacker.uuid);
      }
    } catch (error) {
      processed.delete(message);
      console.error(`${logPrefix} | Precious material armor automation failed`, error);
      ui.notifications.error("Не удалось обработать эффект материала доспеха. Проверьте состояние атакующего.");
    }
  }

  function canProcess() {
    return game.user.isGM && game.users.activeGM?.id === game.user.id
      && game.settings.get(moduleId, settings.preciousMaterialArmorEnabled) !== false;
  }

  function isUnarmedAttack(message, context) {
    const item = message.item;
    if (item && !item.isOfType("weapon", "melee")) return false;

    // Prefer the roll's snapshot: the actor's current Strike may have changed.
    const options = new Set(context.options ?? []);
    if (options.has("item:category:unarmed") || options.has("item:trait:unarmed")) return true;
    if ([...options].some((option) => option.startsWith("item:category:"))) return false;
    return item?.category === "unarmed" || item?.traits.has("unarmed") === true;
  }

  async function resolveTarget(message, context) {
    if (message.target?.actor) return message.target.actor;
    // Never use the GM's currently selected targets or substitute the base
    // actor for a missing unlinked token: the roll records its own target.
    const uuid = context.target?.token ?? context.target?.actor;
    if (!uuid) return null;
    const document = await fromUuid(uuid);
    return document?.actor ?? document;
  }

  async function applyMaterialEffect(message, attacker, target) {
    if (!canProcess()) return;
    const armor = target.wornArmor;
    if (!armor?.isOfType("armor") || !armor.isEquipped) return;
    const material = armor.system.material?.type;
    const rule = materials.get(material);
    if (!rule) return;
    const weaknesses = attacker.system.attributes.weaknesses;
    if (!weaknesses.some((weakness) => weakness.type === rule.weakness && weakness.value > 0)) return;

    let condition = attacker.getCondition("sickened");
    let status;
    if (attacker.isImmuneTo("sickened")) {
      status = "immune";
    } else if (condition && condition.value >= 1) {
      status = "already-sickened";
    } else {
      condition = await attacker.increaseCondition("sickened", { max: 1 });
      // PF2e may reject condition creation (e.g. through an immunity rule).
      if (!condition) return;
      status = "applied";
    }

    const result = {
      status,
      attacker: attacker.uuid,
      target: target.uuid,
      armor: armor.uuid,
      material,
      condition: condition?.uuid ?? null,
      source: rule.source,
    };
    await message.setFlag(moduleId, resultFlag, result);
    try {
      await postResult(message, attacker, target, rule, result, condition?.value);
    } catch (error) {
      console.error(`${logPrefix} | Could not post armor material result`, error);
      ui.notifications.warn("Эффект материала обработан, но сообщение в чат отправить не удалось.");
    }
  }

  async function postResult(message, attacker, target, rule, result, conditionValue) {
    const outcome = result.status === "immune"
      ? "Тошнота не наложена: у атакующего иммунитет к этому состоянию."
      : result.status === "already-sickened"
        ? `У атакующего уже есть тошнота ${conditionValue}. Значение не изменилось.`
        : "На атакующего наложена <strong>тошнота 1</strong>.";
    const content = `<section class="pf2e-eliott-material-armor">
      <h4>Материал доспеха: ${rule.label}</h4>
      <p><strong>${escapeHtml(attacker.name)}</strong> критически промахивается безоружной атакой по <strong>${escapeHtml(target.name)}</strong>.</p>
      <p>Материал доспеха вызывает тошноту у атакующего с соответствующей уязвимостью. ${outcome}</p>
      <p><a href="${rule.source}" target="_blank" rel="noopener noreferrer">Правило материала</a></p>
    </section>`;

    // Copy the actual audience, not the GM's current roll mode. Non-blind
    // whispers are also visible to their original author, who may be a player.
    const blind = message.blind === true;
    const recipients = new Set((message.whisper ?? []).map((user) => typeof user === "string" ? user : user.id));
    if (blind && recipients.size === 0) {
      for (const user of ChatMessage.getWhisperRecipients("GM")) recipients.add(user.id);
    }
    const author = message.author?.id ?? message.user?.id ?? message.user;
    if (!blind && recipients.size > 0 && typeof author === "string") recipients.add(author);

    await ChatMessage.create({
      speaker: { alias: "Материал доспеха" },
      content,
      whisper: [...recipients],
      blind,
      flags: { [moduleId]: { [resultFlag]: { ...result, triggeredBy: message.uuid } } },
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }
})();
