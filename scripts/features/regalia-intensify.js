(function () {
  const tools = globalThis.pf2eEliottTools;
  tools.features ??= {};
  if (tools.features.regaliaIntensify) return;
  const moduleId = tools.module.id;
  const flag = "regaliaIntensify";
  const requestFlag = "regaliaRequest";
  const icon = "modules/pf2e-eliott-tools/assets/ability-icons/regalia-ally-bonus-attack.png";
  const processed = new WeakSet();
  const queues = new Map();
  let initialized = false;
  let dialogOpen = false;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const metadata = (effect) => effect.flags?.[moduleId]?.[flag];
  const expired = (effect) => effect.isExpired || effect.system.expired || effect.remainingDuration?.expired;
  const isAlly = (source, other) => source.uuid !== other.uuid && source.isAllyOf(other);

  function initialize() {
    if (initialized) return;
    initialized = true;
    Hooks.on("createChatMessage", (message) => { void onRequest(message); });
  }

  async function open(actor) {
    if (game.system.id !== "pf2e" || dialogOpen) return;
    initialize();
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length > 1) return ui.notifications.warn("Выделите только токен тауматурга.");
    const source = controlled[0] ?? (actor ?? game.user.character)?.getActiveTokens()[0];
    if (!source?.actor?.isOwner) return ui.notifications.warn("Выделите своего тауматурга на сцене.");
    const tokens = canvas.tokens.placeables.filter((t) => t.actor &&
      ["character", "npc", "familiar"].includes(t.actor.type) && (game.user.isGM || t.isVisible));
    const allies = tokens.filter((t) => isAlly(source.actor, t.actor));
    const enemies = tokens.filter((t) => t.actor.uuid !== source.actor.uuid && !source.actor.isAllyOf(t.actor));
    if (!allies.length || !enemies.length) {
      return ui.notifications.warn("На сцене нужны союзник и противник. Проверьте их принадлежность к сторонам.");
    }
    const targets = [...game.user.targets];
    const markedEnemy = source.actor.rules?.find((r) => r.key === "TokenMark" && r.slug === "exploit-vulnerability")?.uuid;
    const legacyEnemy = source.actor.getFlag("pf2e-thaum-vuln", "primaryEVTarget");
    const defaultEnemy = targets.find((t) => enemies.includes(t)) ??
      enemies.find((t) => t.document.uuid === markedEnemy || t.actor.uuid === legacyEnemy || t.document.uuid === legacyEnemy) ?? enemies[0];
    const defaultAlly = targets.find((t) => allies.includes(t)) ?? allies[0];
    const options = (list, selected) => list.map((t) =>
      `<option value="${escape(t.document.uuid)}"${t === selected ? " selected" : ""}>${escape(t.name)}</option>`).join("");
    dialogOpen = true;
    try {
      const read = (button, bonus) => ({ source: source.document.uuid,
        enemy: button.form.elements.enemy.value, ally: button.form.elements.ally.value, bonus });
      const choice = await foundry.applications.api.DialogV2.wait({
        window: { title: "Тауматург — Регалия: усиление уязвимости" },
        position: { width: 480 }, rejectClose: false,
        content: `<p><strong>${escape(source.name)}</strong></p>
          <p>После успешного Удара по цели «Эксплуатации уязвимости», пока регалия усилена, выберите видимого союзника.</p>
          <div class="form-group"><label>Против кого бонус?</label><select name="enemy">${options(enemies, defaultEnemy)}</select></div>
          <div class="form-group"><label>Кому дать бонус?</label><select name="ally">${options(allies, defaultAlly)}</select></div>
          <p class="hint">Обстоятельственный бонус к атакам только против выбранного противника, до начала следующего хода тауматурга.</p>`,
        buttons: [
          { action: "hit", label: "Попадание: +1", default: true, callback: (_event, button) => read(button, 1) },
          { action: "critical", label: "Крит: +2", callback: (_event, button) => read(button, 2) },
          { action: "cancel", label: "Отмена", callback: () => null },
        ],
      });
      if (!choice) return;
      const ally = allies.find((t) => t.document.uuid === choice.ally);
      if (!ally) return;
      // Delegate unowned allies using a server-authored ChatMessage, not a socket's claimed user ID.
      if (ally.actor.isOwner) {
        const result = await apply(choice, game.user);
        ui.notifications.info(result.text);
      } else {
        const gm = game.users.activeGM;
        if (!gm) return ui.notifications.warn("Для наложения эффекта на чужого союзника нужен подключённый мастер.");
        const message = await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: source.actor }),
          whisper: [game.user.id, gm.id],
          content: `<p>Регалия: запрос мастеру на +${choice.bonus} для ${escape(ally.name)}.</p>`,
          flags: { [moduleId]: { [requestFlag]: { ...choice, status: "pending" } } },
        });
        const result = await waitForResult(message);
        if (result?.status === "applied") ui.notifications.info(result.text);
        else ui.notifications.warn(result?.text ?? "Запрос отправлен, но мастер пока не подтвердил наложение. Проверьте сообщение в чате; мастеру может требоваться обновить страницу.");
      }
    } catch (error) {
      console.error(`${moduleId} | Regalia`, error);
      ui.notifications.error(error.message || "Не удалось наложить эффект регалии.");
    } finally {
      dialogOpen = false;
    }
  }

  async function resolve(choice, user) {
    if (![1, 2].includes(choice?.bonus)) throw new Error("Некорректный бонус регалии.");
    const documents = await Promise.all([choice.source, choice.enemy, choice.ally].map((uuid) =>
      typeof uuid === "string" && /^Scene\.[^.]+\.Token\.[^.]+$/.test(uuid) ? fromUuid(uuid) : null));
    const [source, enemy, ally] = documents;
    if (documents.some((d) => d?.documentName !== "Token" || !d.actor)) throw new Error("Один из токенов больше недоступен.");
    if (!source.actor.testUserPermission(user, "OWNER")) throw new Error("Нет прав на тауматурга.");
    if (documents.some((d) => d.parent.id !== source.parent.id) || source.parent.id !== canvas.scene?.id) {
      throw new Error("Тауматург, союзник и противник должны быть на одной сцене, открытой у применяющего эффект.");
    }
    if (!isAlly(source.actor, ally.actor) || source.actor.uuid === enemy.actor.uuid || source.actor.isAllyOf(enemy.actor)) {
      throw new Error("Выберите союзника и противника с подходящей принадлежностью к сторонам.");
    }
    return { source, enemy, ally };
  }

  function effectData(source, enemy, bonus) {
    const mark = `eliott-regalia-${enemy.parent.id.toLowerCase()}-${enemy.id.toLowerCase()}`;
    return {
      name: `Регалия: +${bonus} к атакам против ${enemy.name}`, type: "effect", img: icon,
      flags: { [moduleId]: { [flag]: { source: source.actor.uuid, enemy: enemy.uuid, bonus } } },
      system: {
        slug: "eliott-regalia-intensify", level: { value: Math.max(1, source.actor.level) },
        description: { value: `<p>+${bonus} обстоятельственный бонус к броскам атак против ${escape(enemy.name)} до начала следующего хода ${escape(source.name)}.</p>` },
        duration: { value: 1, unit: "rounds", expiry: "turn-start", sustained: false },
        start: { value: game.time.worldTime, initiative: source.actor.combatant?.initiative ?? null },
        tokenIcon: { show: true },
        context: { origin: { actor: source.actor.uuid, token: source.uuid, item: null, spellcasting: null }, target: null, roll: null },
        rules: [
          { key: "TokenMark", slug: mark, uuid: enemy.uuid },
          { key: "FlatModifier", label: "Усиление регалии", selector: "attack-roll", value: bonus,
            type: "circumstance", predicate: [`target:mark:${mark}`] },
        ],
      },
    };
  }

  async function apply(choice, user) {
    const { source, enemy, ally } = await resolve(choice, user);
    const previousTask = queues.get(ally.actor.uuid) ?? Promise.resolve();
    const task = previousTask.catch(() => {}).then(async () => {
      const effects = ally.actor.itemTypes.effect.filter((e) =>
        metadata(e)?.source === source.actor.uuid && metadata(e)?.enemy === enemy.uuid);
      const existing = effects.find((e) => !expired(e));
      const bonus = Math.max(choice.bonus, existing ? metadata(existing).bonus : 0);
      let effect;
      if (existing) {
        const data = effectData(source, enemy, bonus);
        await existing.update({ name: data.name, img: data.img, "system.rules": data.system.rules,
          "system.description": data.system.description, [`flags.${moduleId}.${flag}.bonus`]: bonus });
        effect = existing;
      } else {
        [effect] = await ally.actor.createEmbeddedDocuments("Item", [effectData(source, enemy, bonus)]);
        if (!effect) throw new Error("PF2e не создала эффект регалии.");
        if (effects.length) await ally.actor.deleteEmbeddedDocuments("Item", effects.map((e) => e.id));
      }
      return { effect: effect.uuid, text: `${ally.name}: +${bonus} к атакам против ${enemy.name} до начала следующего хода ${source.name}.` };
    });
    queues.set(ally.actor.uuid, task);
    try { return await task; }
    finally { if (queues.get(ally.actor.uuid) === task) queues.delete(ally.actor.uuid); }
  }

  async function onRequest(message) {
    const request = message.flags?.[moduleId]?.[requestFlag];
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || request?.status !== "pending" || processed.has(message)) return;
    processed.add(message);
    let result;
    try {
      if (!message.author || Date.now() - message.timestamp > 30000) throw new Error("Запрос регалии устарел; запустите макрос заново.");
      result = { status: "applied", ...await apply(request, message.author) };
    } catch (error) {
      result = { status: "error", text: error.message };
    }
    try {
      await message.update({ content: `<p>${escape(result.text)}</p>`,
        [`flags.${moduleId}.${requestFlag}`]: { ...request, ...result } });
    } catch (error) {
      console.error(`${moduleId} | Regalia acknowledgement`, error);
    }
  }

  function waitForResult(message) {
    const result = () => game.messages.get(message.id)?.flags?.[moduleId]?.[requestFlag];
    if (result()?.status !== "pending") return Promise.resolve(result());
    return new Promise((resolve) => {
      const finish = (value) => { clearTimeout(timer); Hooks.off("updateChatMessage", hook); resolve(value); };
      const hook = Hooks.on("updateChatMessage", (updated) => {
        if (updated.id === message.id && result()?.status !== "pending") finish(result());
      });
      const timer = setTimeout(() => finish(null), 15000);
      if (result()?.status !== "pending") finish(result());
    });
  }

  tools.features.regaliaIntensify = { initialize, open, apply, onRequest, effectData };
})();
