(function () {
  const tools = globalThis.pf2eEliottTools;
  tools.features ??= {};
  if (tools.features.chalice) return;
  const moduleId = tools.module.id;
  const requestFlag = "chaliceRequest";
  const processed = new WeakSet();
  const queues = new Map();
  let initialized = false;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const metadata = (effect) => effect.flags?.[moduleId]?.chalice;

  function initialize() {
    if (initialized) return;
    initialized = true;
    Hooks.on("createChatMessage", (message) => { void onRequest(message); });
  }

  async function updateMacros() {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    const response = await fetch(foundry.utils.getRoute(`modules/${moduleId}/scripts/macros/drink-from-chalice.js`), { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось прочитать обновлённый макрос чаши.");
    const command = (await response.text()).trim();
    const normalize = (value) => value.replace(/\r\n/g, "\n").trim();
    // The official pack is updated through Foundry, which owns its open LevelDB.
    const pack = game.packs.get(`${moduleId}.thaumaturge-macros`);
    if (pack) {
      const macro = await pack.getDocument("ChaliceDrink0001");
      if (macro && normalize(macro.command) !== normalize(command)) {
        const locked = pack.locked;
        try {
          if (locked) await pack.configure({ locked: false });
          await macro.update({ command });
        } finally {
          if (locked) await pack.configure({ locked: true });
        }
      }
    }
    // Upgrade only exact copies of the shipped old script; retain edited macros.
    // On insecure HTTP without WebCrypto, the updated pack can be re-imported.
    if (!globalThis.crypto?.subtle) return;
    const legacyHash = "619bb9b989ce4ee0bea1490e3ce7dcf7bb1ff2d5982183a3666d8a2d40a3c527";
    for (const macro of game.macros.contents) {
      if (macro.type !== "script" || !macro.command.includes("chaliceLocks")) continue;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(macro.command)));
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash === legacyHash) await macro.update({ command });
    }
  }

  async function applySip(choice, user) {
    if (typeof choice?.adept !== "boolean" || typeof choice?.intensified !== "boolean") {
      throw new Error("Некорректные параметры чаши.");
    }
    const [source, recipient] = await Promise.all([choice.source, choice.recipient].map((uuid) =>
      typeof uuid === "string" && /^(Actor\.[^.]+|Scene\.[^.]+\.Token\.[^.]+\.Actor\.[^.]+)$/.test(uuid)
        ? fromUuid(uuid) : null));
    if (source?.documentName !== "Actor" || recipient?.documentName !== "Actor" ||
      !["character", "npc"].includes(source.type) || !["character", "npc", "familiar"].includes(recipient.type)) {
      throw new Error("Тауматург или цель больше недоступны.");
    }
    if (!user || !source.testUserPermission(user, "OWNER")) throw new Error("Нет прав на тауматурга.");
    const level = Number(source.level);
    if (!Number.isInteger(level) || level < 1) throw new Error("У персонажа должен быть указан уровень от 1.");
    let token = null;
    if (choice.token != null) {
      if (typeof choice.token !== "string" || !/^Scene\.[^.]+\.Token\.[^.]+$/.test(choice.token)) {
        throw new Error("Некорректный токен тауматурга.");
      }
      token = await fromUuid(choice.token);
      if (token?.documentName !== "Token" || token.actor?.uuid !== source.uuid) {
        throw new Error("Токен тауматурга больше недоступен.");
      }
    }
    // Only this fixed effect is delegated. Amount, rules and duration are built by the GM.
    const amount = (choice.adept ? 2 * level : Math.max(3, level)) + (choice.intensified ? level : 0);
    const previousTask = queues.get(recipient.uuid) ?? Promise.resolve();
    const task = previousTask.catch(() => {}).then(async () => {
      const hp = recipient.system.attributes.hp;
      const currentHP = Number(hp.temp) || 0;
      const previous = recipient.itemTypes.effect.filter((e) =>
        metadata(e)?.kind === "sip" && metadata(e)?.origin === source.uuid);
      const ownsCurrentHP = previous.some((e) => e.id === hp.tempsource);
      let text;
      if (currentHP < amount || (currentHP === amount && ownsCurrentHP)) {
        const name = `Чаша: ${amount} временных ОЗ`;
        const [effect] = await recipient.createEmbeddedDocuments("Item", [{
          name, type: "effect", img: "systems/pf2e/icons/features/classes/chalice.webp",
          flags: { [moduleId]: { chalice: { kind: "sip", origin: source.uuid } } },
          system: {
            slug: "eliott-chalice-temp-hp", level: { value: level },
            description: { value: `<p>${escape(name)}. Источник: ${escape(source.name)}.</p><p><a href="https://2e.aonprd.com/Implements.aspx?ID=19">Правила чаши</a></p>` },
            duration: { value: 1, unit: "rounds", expiry: "turn-end", sustained: false },
            start: { value: game.time.worldTime, initiative: source.combatant?.initiative ?? null },
            tokenIcon: { show: true }, rules: [{ key: "TempHP", value: amount }],
            context: { origin: { actor: source.uuid, token: token?.uuid ?? null, item: null, spellcasting: null }, target: null, roll: null },
          },
        }]);
        if (!effect) throw new Error("PF2e не создала эффект чаши.");
        // Equal refresh must transfer TempHP ownership before deleting the old effect.
        if (currentHP === amount && ownsCurrentHP) {
          await recipient.update({ "system.attributes.hp.tempsource": effect.id });
        }
        if (previous.length) await recipient.deleteEmbeddedDocuments("Item", previous.map((e) => e.id));
        text = `${recipient.name}: ${amount} временных ОЗ до конца следующего хода ${source.name}.`;
      } else {
        text = `${recipient.name}: сохранены текущие ${currentHP} временных ОЗ; глоток даёт ${amount}.`;
      }
      for (const effect of source.itemTypes.effect.filter((e) =>
        (e.slug === "chalice-drained" || metadata(e)?.kind === "drained") &&
        !e.isExpired && !e.system.expired && !e.remainingDuration?.expired)) {
        await effect.update({ "system.start": { value: game.time.worldTime,
          initiative: source.combatant?.initiative ?? null } });
      }
      return { text };
    });
    queues.set(recipient.uuid, task);
    try { return await task; }
    finally { if (queues.get(recipient.uuid) === task) queues.delete(recipient.uuid); }
  }

  async function sip(source, recipient, choice, token) {
    initialize();
    const request = { source: source.uuid, recipient: recipient.uuid, token,
      adept: choice.adept, intensified: choice.intensified };
    if (recipient.isOwner) {
      const result = await applySip(request, game.user);
      ui.notifications.info(result.text);
      return;
    }
    const gm = game.users.activeGM;
    if (!gm) return ui.notifications.warn("Для глотка чаши по чужой цели нужен подключённый мастер.");
    const message = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: source }), whisper: [game.user.id, gm.id],
      content: `<p>Чаша: запрос мастеру на глоток для ${escape(recipient.name)}.</p>`,
      flags: { [moduleId]: { [requestFlag]: { ...request, status: "pending" } } },
    });
    const result = await waitForResult(message);
    if (result?.status === "applied") ui.notifications.info(result.text);
    else ui.notifications.warn(result?.text ?? "Запрос чаши отправлен, но результат пока не получен. Проверьте сообщение в чате; мастеру может требоваться обновить страницу.");
  }

  async function onRequest(message) {
    const request = message.flags?.[moduleId]?.[requestFlag];
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || request?.status !== "pending" || processed.has(message)) return;
    processed.add(message);
    let result;
    try {
      if (!message.author || Date.now() - message.timestamp > 30000) throw new Error("Запрос чаши устарел; запустите макрос заново.");
      result = { status: "applied", ...await applySip(request, message.author) };
    } catch (error) {
      result = { status: "error", text: error.message };
    }
    try {
      await message.update({ content: `<p>${escape(result.text)}</p>`,
        [`flags.${moduleId}.${requestFlag}`]: { ...request, ...result } });
    } catch (error) {
      console.error(`${moduleId} | Chalice acknowledgement`, error);
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

  tools.features.chalice = { initialize, updateMacros, sip, applySip, onRequest };
})();
