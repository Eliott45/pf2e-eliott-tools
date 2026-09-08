// Standalone Foundry script macro. Its exact contents are packed by tools/build-macros.cjs.
await (async () => {
  const moduleId = "pf2e-eliott-tools";
  const icon = "systems/pf2e/icons/features/classes/chalice.webp";
  const sourceLink = "https://2e.aonprd.com/Implements.aspx?ID=19";
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  if (game.system.id !== "pf2e") return ui.notifications.warn("Макрос предназначен для Pathfinder 2e.");
  const controlled = canvas.tokens?.controlled ?? [];
  if (controlled.length > 1) return ui.notifications.warn("Выделите только токен тауматурга.");
  const source = controlled[0]?.actor ?? (typeof actor !== "undefined" ? actor : null) ?? game.user.character;
  if (!source?.isOwner || !["character", "npc"].includes(source.type)) {
    return ui.notifications.warn("Выделите своего тауматурга или назначьте персонажа пользователю.");
  }
  const level = Number(source.level);
  if (!Number.isInteger(level) || level < 1) return ui.notifications.warn("У персонажа должен быть указан уровень от 1.");
  const locks = (globalThis[Symbol.for("pf2e-eliott-tools.chaliceLocks")] ??= new Set());
  if (locks.has(source.uuid)) return ui.notifications.warn("Для этого персонажа уже открыта чаша.");
  locks.add(source.uuid);
  try {
    // Deliberately ask the player about conditional benefits. No legacy module flags or combat hooks.
    const recipients = new Map([[source.uuid, source]]);
    let defaultRecipient = source.uuid;
    let hasDefaultTarget = false;
    for (const target of game.user.targets) {
      if (target.actor && ["character", "npc", "familiar"].includes(target.actor.type)) {
        recipients.set(target.actor.uuid, target.actor);
        if (!hasDefaultTarget) {
          defaultRecipient = target.actor.uuid;
          hasDefaultTarget = true;
        }
      }
    }
    const values = (adept, intensified) => ({
      sip: (adept ? 2 * level : Math.max(3, level)) + (intensified ? level : 0),
      drain: (adept ? 5 : 3) * level + (intensified ? 2 * level : 0),
    });
    const readForm = (form) => ({
      recipient: form.elements.recipient.value,
      adept: form.elements.adept.checked,
      intensified: form.elements.intensified.checked,
    });
    const initial = values(false, false);
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: "Тауматург — Выпить из чаши" },
      position: { width: 480 },
      rejectClose: false,
      content: `
        <p><strong>${escape(source.name)}</strong> · уровень ${level}. Держите чашу в руке; действие доступно раз в раунд.</p>
        <div class="form-group"><label>Кто пьёт?</label><select name="recipient">
          ${[...recipients.values()].map((a) => `<option value="${escape(a.uuid)}"${a.uuid === defaultRecipient ? " selected" : ""}>${escape(a.name)}${a.uuid === source.uuid ? " (себе)" : " (цель)"}</option>`).join("")}
        </select></div>
        <p class="hint">Для союзника отметьте его целью перед запуском. Союзник должен стоять рядом.</p>
        <div class="form-group"><label>Применить преимущество адепта?</label><input type="checkbox" name="adept"></div>
        <p class="hint">Если чаша — адепт: пьющий в пределах 30 футов получил рубящий/колющий урон от крита врага либо продолжительный урон кровотечением. Выпить нужно до конца следующего хода тауматурга.</p>
        <div class="form-group"><label>Применить усиление уязвимости?</label><input type="checkbox" name="intensified"></div>
        <p class="hint">Если вы усилили чашу и находитесь в пределах 30 футов от цели своей «Эксплуатации уязвимости».</p>
        <p data-chalice-preview><strong>Глоток: ${initial.sip} временных ОЗ. Осушение: ${initial.drain} ОЗ лечения.</strong></p>
        <p class="hint">Глоток накладывает эффект до конца вашего следующего хода. Осушение отправляет лечение в чат для обычного применения. После осушения нужны 10 минут без питья для наполнения чаши.</p>`,
      render: (_event, dialog) => {
        const form = dialog.element.querySelector("form");
        form.addEventListener("change", () => {
          const selection = readForm(form);
          const amount = values(selection.adept, selection.intensified);
          form.querySelector("[data-chalice-preview]").textContent =
            `Глоток: ${amount.sip} временных ОЗ. Осушение: ${amount.drain} ОЗ лечения.`;
        });
      },
      buttons: [
        { action: "sip", label: "Глоток", icon: "fa-solid fa-wine-glass", default: true,
          callback: (_event, button) => ({ ...readForm(button.form), mode: "sip" }) },
        { action: "drain", label: "Осушить", icon: "fa-solid fa-heart",
          callback: (_event, button) => ({ ...readForm(button.form), mode: "drain" }) },
        { action: "cancel", label: "Отмена", callback: () => null },
      ],
    });
    if (!choice) return;
    const recipient = recipients.get(choice.recipient);
    if (!recipient || !source.isOwner) return;
    if (choice.mode === "sip" && !recipient.isOwner) {
      return ui.notifications.warn(`Нет прав изменять ${recipient.name}. Владелец или мастер может запустить макрос, выбрав тауматурга и эту цель.`);
    }
    const amount = values(choice.adept, choice.intensified);
    const effects = () => source.itemTypes.effect.filter((e) =>
      e.slug === "chalice-drained" || e.flags?.[moduleId]?.chalice?.kind === "drained");
    const activeDrained = effects().filter((e) => !e.isExpired && !e.system.expired &&
      !(e.remainingDuration?.expired ?? false));
    if (choice.mode === "drain" && activeDrained.length) {
      return ui.notifications.warn("Чаша уже осушена. Можно отпить, но это заново отсчитает 10 минут до наполнения.");
    }
    const origin = {
      actor: source.uuid,
      token: controlled[0]?.document?.uuid ?? source.token?.uuid ?? null,
      item: null, spellcasting: null,
    };
    const effectData = (kind, name, duration, rules = []) => ({
      name, type: "effect", img: icon,
      flags: { [moduleId]: { chalice: { kind, origin: source.uuid } } },
      system: {
        slug: kind === "drained" ? "chalice-drained" : "eliott-chalice-temp-hp",
        description: { value: `<p>${escape(name)}. Источник: ${escape(source.name)}.</p><p><a href="${sourceLink}">Правила чаши</a></p>` },
        level: { value: level }, duration: { ...duration, sustained: false },
        start: { value: game.time.worldTime, initiative: source.combatant?.initiative ?? null },
        tokenIcon: { show: true }, rules,
        context: { origin, target: null, roll: null },
      },
    });
    if (choice.mode === "sip") {
      const currentHP = Number(recipient.system.attributes.hp.temp) || 0;
      const currentSource = recipient.system.attributes.hp.tempsource;
      const previous = recipient.itemTypes.effect.filter((e) =>
        e.flags?.[moduleId]?.chalice?.kind === "sip" &&
        e.flags[moduleId].chalice.origin === source.uuid);
      const ownsCurrentHP = previous.some((e) => e.id === currentSource);
      // Keep a stronger source and its original expiry; temporary HP never stack.
      if (currentHP < amount.sip || (currentHP === amount.sip && ownsCurrentHP)) {
        const [effect] = await recipient.createEmbeddedDocuments("Item", [effectData("sip",
          `Чаша: ${amount.sip} временных ОЗ`, { value: 1, unit: "rounds", expiry: "turn-end" },
          [{ key: "TempHP", value: amount.sip }])]);
        if (!effect) throw new Error("PF2e не создала эффект чаши.");
        // PF2e only adopts a TempHP source when the new value is strictly higher.
        // On an equal refresh, move ownership before removing our previous effect.
        if (currentHP === amount.sip && ownsCurrentHP) {
          await recipient.update({ "system.attributes.hp.tempsource": effect.id });
        }
        if (previous.length) await recipient.deleteEmbeddedDocuments("Item", previous.map((e) => e.id));
      } else {
        ui.notifications.info(`${recipient.name}: сохранены текущие ${currentHP} временных ОЗ; глоток даёт ${amount.sip}.`);
      }
      for (const effect of activeDrained) {
        await effect.update({ "system.start": { value: game.time.worldTime,
          initiative: source.combatant?.initiative ?? null } });
      }
    } else {
      const DamageRoll = CONFIG.Dice.rolls.find((roll) => roll.name === "DamageRoll");
      if (!DamageRoll) throw new Error("Не найден бросок урона/лечения PF2e.");
      // Use the system's void-healing attribute, not the undead trait.
      // "healing" here selects the DamageRoll kind (and healing buttons), not an action trait.
      const traits = recipient.system.attributes.hp.negativeHealing ? "healing,void" : "healing,vitality";
      const [drained] = await source.createEmbeddedDocuments("Item", [effectData("drained",
        "Чаша осушена", { value: 10, unit: "minutes", expiry: "turn-start" })]);
      if (!drained) throw new Error("Не удалось отметить осушение чаши.");
      try {
        const roll = new DamageRoll(`{${amount.drain}[${traits}]}`);
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: source }),
          flavor: `<strong>Выпить из чаши — осушить</strong><p>${escape(source.name)} → ${escape(recipient.name)}. ${amount.drain} ОЗ лечения.</p><p>Адепт: ${choice.adept ? "да" : "нет"}. Усиление: ${choice.intensified ? "да" : "нет"}.</p><p>Выделите токен ${escape(recipient.name)} и примените лечение из этого сообщения.</p>`,
          flags: { [moduleId]: { chalice: { recipient: recipient.uuid, origin: source.uuid } } },
        });
      } catch (error) {
        await drained.delete();
        throw error;
      }
      const expired = effects().filter((e) => e.id !== drained.id &&
        (e.isExpired || e.system.expired || e.remainingDuration?.expired));
      if (expired.length) await source.deleteEmbeddedDocuments("Item", expired.map((e) => e.id));
    }
  } catch (error) {
    console.error("PF2E Eliott Tools | Drink from the Chalice", error);
    ui.notifications.error("Не удалось выпить из чаши. Проверьте эффекты персонажа и ошибку в консоли.");
  } finally {
    locks.delete(source.uuid);
  }
})();
