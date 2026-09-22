(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const rollFlag = "drinkFoesRoll";
  const resultFlag = "drinkFoesDamage";
  const requestFlag = "drinkFoesRequest";
  const rollPrefix = "eliott-tools:drink-foes:roll:";
  const applyPrefix = "eliott-tools:drink-foes:apply:";
  const sparkOption = "divine-spark:barrows-edge";
  const frames = new Map();
  const actorFrames = new WeakMap();
  const damageQueues = new WeakMap();
  const requests = new Map();
  const dialogs = new Set();
  const processed = new WeakSet();
  let installed = false;
  const enabled = () => game.settings.get(moduleId, settings.drinkOfMyFoesEnabled) !== false;
  const metadata = (message, key) => message.flags?.[moduleId]?.[key];
  const escape = (text) => foundry.utils.escapeHTML(String(text));
  const currentCombat = () => game.combat?.started
    ? { id: game.combat.id, round: game.combat.round, turn: game.combat.turn } : null;
  const isWeapon = (item) => item?.type === "weapon"
    && item.system.traits?.otherTags?.includes("physical-ikon:barrows-edge");
  const getAction = (actor) => actor.items.find((item) => item.type === "action"
    && (item.slug === "drink-of-my-foes" || item.sourceId === "Compendium.pf2e.actionspf2e.Item.vZwa0PZLQvm3X5ME"));
  const isSuccessfulDamage = (message) => message.flags?.pf2e?.context?.type === "damage-roll"
    && message.flags.pf2e.context.sourceType === "attack"
    && ["success", "criticalSuccess"].includes(message.flags.pf2e.context.outcome)
    && isWeapon(message.item);
  const getKey = (options, prefix) => Array.from(options ?? []).find((option) => option.startsWith(prefix))?.slice(prefix.length);

  function onInit() {
    if (installed) return;
    let prototype = CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype;
    while (prototype && !Object.hasOwn(prototype, "applyDamage")) prototype = Object.getPrototypeOf(prototype);
    if (typeof prototype?.applyDamage !== "function" || typeof prototype?.calculateHealthDelta !== "function") {
      console.warn(`${logPrefix} | Drink of my Foes is unavailable in this PF2e version`);
      return;
    }
    const calculate = prototype.calculateHealthDelta;
    prototype.calculateHealthDelta = function (...args) {
      const result = calculate.apply(this, args);
      const frame = actorFrames.get(this);
      // PF2e computes this after IWR, shield and actor hardness, including damage
      // absorbed by temporary HP and overkill. HP differences would lose both.
      if (frame) frame.damage = result.totalApplied;
      return result;
    };
    const apply = prototype.applyDamage;
    prototype.applyDamage = function (params, ...args) {
      if (!enabled()) return apply.call(this, params, ...args);
      // Serialize calls on the same document so the per-call observation cannot
      // be confused with another damage/healing operation on that instance.
      const previous = damageQueues.get(this) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const rollKey = getKey(params.rollOptions, rollPrefix);
        const track = game.user.isGM && rollKey && isWeapon(params.item)
          && ["success", "criticalSuccess"].includes(params.outcome);
        if (!track) return apply.call(this, params, ...args);
        const trace = foundry.utils.randomID();
        const frame = { rollKey, actor: params.item.actor.uuid, weapon: params.item.uuid,
          target: this.uuid, damage: null, combat: currentCombat() };
        frames.set(trace, frame);
        actorFrames.set(this, frame);
        try {
          return await apply.call(this, { ...params,
            rollOptions: new Set([...(params.rollOptions ?? []), `${applyPrefix}${trace}`]),
          }, ...args);
        } finally {
          frames.delete(trace);
          actorFrames.delete(this);
        }
      });
      damageQueues.set(this, task);
      void task.finally(() => { if (damageQueues.get(this) === task) damageQueues.delete(this); }).catch(() => {});
      return task;
    };
    Hooks.on("preCreateChatMessage", prepareMessage);
    Hooks.on("createChatMessage", (message) => { void onRequest(message); });
    Hooks.on("renderChatMessageHTML", renderMessage);
    Hooks.on("renderChatMessage", renderMessage);
    installed = true;
  }

  function prepareMessage(message) {
    if (!enabled()) return;
    const context = message.flags?.pf2e?.context;
    if (isSuccessfulDamage(message) && getAction(message.actor)) {
      const key = foundry.utils.randomID();
      message.updateSource({ [`flags.${moduleId}.${rollFlag}`]: { key, combat: currentCombat() },
        "flags.pf2e.context.options": [...(context.options ?? []).filter((option) => !option.startsWith(rollPrefix)), `${rollPrefix}${key}`] });
    } else if (game.user.isGM && context?.type === "damage-taken") {
      const frame = frames.get(getKey(context.options, applyPrefix));
      if (!frame || !Number.isFinite(frame.damage) || frame.damage < 0) return;
      message.updateSource({ [`flags.${moduleId}.${resultFlag}`]: { ...frame, state: "available" } });
    }
  }

  function sparkChoices(actor) {
    const toggle = actor.synthetics?.toggles?.all?.["divine-spark"];
    if (!toggle?.enabled) return [];
    const options = toggle.suboptions ?? [];
    const others = options.filter((option) => option.value !== "barrows-edge")
      .map((option) => ({ value: option.value, label: game.i18n.localize(option.label) }));
    // Exemplar Dedication with only one ikon sends the spark back into the soul.
    return others.length ? others : options.some((option) => option.value === "barrows-edge")
      ? [{ value: "", label: "Вернуть искру в душу" }] : [];
  }

  function renderMessage(message, html) {
    const root = html?.querySelector ? html : html?.[0];
    if (!enabled() || !root || message.isContentVisible === false || !metadata(message, rollFlag)
      || !isSuccessfulDamage(message) || !message.actor?.isOwner || !getAction(message.actor)
      || root.querySelector(".eliott-drink-foes")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "eliott-drink-foes";
    button.textContent = "◆ Drink of my Foes";
    button.title = "Восстановить половину фактически нанесённого урона и переместить искру";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void open(message).catch(reportError);
    });
    (root.querySelector(".message-content") ?? root).append(button);
  }

  async function open(message) {
    const actor = message.actor;
    if (!enabled() || !actor?.isOwner || dialogs.has(actor.uuid)) return;
    const gm = game.users.activeGM;
    if (!gm) return ui.notifications.warn("Для расчёта Drink of my Foes нужен подключённый мастер.");
    if (!actor.rollOptions.all[sparkOption]) return ui.notifications.warn("Божественная искра должна находиться в Barrow's Edge.");
    const choices = sparkChoices(actor);
    if (!choices.length) return ui.notifications.warn("Не удалось определить доступные иконы.");
    dialogs.add(actor.uuid);
    try {
      const selection = await foundry.applications.api.DialogV2.wait({
        window: { title: "Drink of my Foes" }, rejectClose: false,
        content: `<p>Это отдельное действие ◆. Последним действием должен быть этот успешный Удар.</p>
          <p>Мастер должен сначала применить урон к цели. Модуль рассчитает лечение без показа её скрытых ОЗ и сопротивлений.</p>
          <div class="form-group"><label>Куда переместить искру?</label><select name="ikon">${choices.map((c) =>
            `<option value="${escape(c.value)}">${escape(c.label)}</option>`).join("")}</select></div>`,
        buttons: [
          { action: "use", label: "Использовать ◆", default: true, callback: (_event, button) => ({ ikon: button.form.elements.ikon.value }) },
          { action: "cancel", label: "Отмена", callback: () => null },
        ],
      });
      if (!selection) return;
      await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
        whisper: [...new Set([game.user.id, gm.id])],
        content: "<p>Drink of my Foes: ожидается расчёт лечения мастером.</p>",
        flags: { [moduleId]: { [requestFlag]: { source: message.id, ikon: selection.ikon, status: "pending" } } },
      });
    } finally { dialogs.delete(actor.uuid); }
  }

  function validateAction(source, user) {
    const actor = source?.actor;
    const roll = metadata(source ?? {}, rollFlag);
    if (!actor || !actor.testUserPermission(user, "OWNER") || !roll || !isSuccessfulDamage(source)) {
      throw new Error("Нет подходящего броска урона Barrow's Edge или прав на персонажа.");
    }
    const action = getAction(actor);
    if (!action || !actor.rollOptions.all[sparkOption]) throw new Error("Нужны Drink of my Foes и активная искра в Barrow's Edge.");
    if (actor.system.attributes.hp.negativeHealing || actor.modeOfBeing === "undead") {
      throw new Error("Персонаж не может получать это витальное исцеление.");
    }
    if (actor.isImmuneTo?.(action)) throw new Error("Персонаж невосприимчив к этому исцелению.");
    if (JSON.stringify(roll.combat) !== JSON.stringify(currentCombat())) throw new Error("Ход изменился; этот Удар больше нельзя использовать.");
    // Detect actions that Foundry actually logged. Unlogged movement/actions still
    // require the player to honor the last-action requirement shown in the dialog.
    const laterAction = game.messages.contents.some((m) => m.timestamp > source.timestamp
      && m.actor?.uuid === actor.uuid && !metadata(m, requestFlag)
      && (m.isCheckRoll || m.flags?.pf2e?.context?.type === "spell-cast"
        || (["action", "feat"].includes(m.item?.type) && m.item?.system.actionType?.value === "action"
          && m.flags?.pf2e?.context?.type !== "damage-taken")));
    if (laterAction) throw new Error("После этого Удара уже записано другое действие персонажа.");
    return { actor, action, roll };
  }

  async function use(request, user) {
    const source = game.messages.get(request.source);
    const { actor, action, roll } = validateAction(source, user);
    const choice = sparkChoices(actor).find((option) => option.value === request.ikon);
    if (!choice) throw new Error("Выбранный икон недоступен для перемещения искры.");
    const records = game.messages.contents.filter((m) => {
      const data = metadata(m, resultFlag);
      return m.author?.isGM && data?.rollKey === roll.key && data.actor === actor.uuid && data.weapon === source.item.uuid;
    });
    if (records.some((m) => metadata(m, resultFlag).state !== "available")) {
      throw new Error("Этот Удар уже использован или его обработка требует проверки мастера.");
    }
    const available = records.filter((m) => !m.flags.pf2e?.appliedDamage?.isReverted);
    if (!available.length) throw new Error("Мастер ещё не применил этот урон к цели, либо применение отменено. Повторите после применения урона.");
    if (available.length !== 1) throw new Error("Этот урон применён несколько раз. Мастеру нужно отменить лишние применения.");
    const record = available[0];
    const data = metadata(record, resultFlag);
    if (!Number.isFinite(data.damage) || data.damage < 0) throw new Error("Нет достоверного результата нанесённого урона.");
    const token = source.token ?? actor.getActiveTokens(true, true).shift();
    if (!token || token.actor?.uuid !== actor.uuid) throw new Error("Токен персонажа недоступен на сцене.");
    const amount = Math.floor(data.damage / 2);
    // Durable claim precedes both updates: a double click, another client or a
    // reload cannot heal twice. On partial failure the GM must review the result.
    await record.update({ [`flags.${moduleId}.${resultFlag}.state`]: "claimed" });
    try {
      if (amount > 0) {
        const options = new Set([...actor.getSelfRollOptions(), ...action.getRollOptions("item"),
          "self:action:slug:drink-of-my-foes", "origin:action:trait:healing", "origin:action:trait:vitality",
          "origin:action:trait:transcendence"]);
        await actor.applyDamage({ damage: -amount, token, item: action, rollOptions: options, skipIWR: true });
      }
      await record.update({ [`flags.${moduleId}.${resultFlag}.state`]: "healed" });
      const toggle = actor.synthetics.toggles.all["divine-spark"];
      const shifted = await actor.toggleRollOption("all", "divine-spark", toggle.itemId, !!choice.value,
        choice.value || "barrows-edge");
      if (shifted !== !!choice.value) throw new Error("Искра не переместилась.");
      await record.update({ [`flags.${moduleId}.${resultFlag}.state`]: "used" });
      return `Drink of my Foes ◆: базовое исцеление ${amount} ОЗ; искра — ${choice.label}.`;
    } catch (error) {
      console.error(`${logPrefix} | Drink of my Foes partial application`, error);
      throw new Error("Обработка прервалась: лечение могло уже примениться. Повтор заблокирован; мастеру нужно проверить ОЗ и искру.");
    }
  }

  async function onRequest(message) {
    const request = metadata(message, requestFlag);
    if (!enabled() || !game.user.isGM || game.users.activeGM?.id !== game.user.id
      || request?.status !== "pending" || processed.has(message)) return;
    processed.add(message);
    const actorId = game.messages.get(request.source)?.actor?.uuid ?? request.source;
    const previous = requests.get(actorId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let status = "applied", text;
      try {
        if (!message.author || Date.now() - message.timestamp > 30000) throw new Error("Запрос устарел. Нажмите кнопку снова.");
        text = await use(request, message.author);
      } catch (error) { status = "error"; text = error.message; }
      await message.update({ content: `<p>${escape(text)}</p>`,
        [`flags.${moduleId}.${requestFlag}.status`]: status });
    });
    requests.set(actorId, task);
    try { await task; }
    catch (error) { reportError(error); }
    finally { if (requests.get(actorId) === task) requests.delete(actorId); }
  }

  function reportError(error) {
    console.error(`${logPrefix} | Drink of my Foes`, error);
    ui.notifications.error(error.message || "Не удалось использовать Drink of my Foes.");
  }
  tools.features ??= {};
  tools.features.drinkOfMyFoes = { onInit };
})();
