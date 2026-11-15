(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const feature = ((tools.features ??= {}).reactions ??= {});
  const core = feature.core;
  const flagKey = "reactions";
  const promptFlag = "reactionPrompt";
  const useAction = "pf2e-eliott-use-reaction";
  const stylesheet = "styles/reactions.css";
  // Last known position of every token, so a move can be measured from where it began.
  const positions = new Map();
  // Prompts already shown this turn for one activity (a move, a spell), keyed per reactor.
  // Cleared on every turn change, so it never grows past one turn's worth.
  const recentPrompts = new Set();
  let entriesByTrigger = null;
  let enabled = false;

  Object.assign(feature, { onInit, isEnabled: () => enabled, handleMessage, handleTokenMove, handleMovement, usedReaction, collectPrompts });
  // Movements that aren't the creature moving itself.
  const ignoredMethods = new Set(["undo", "paste", "config"]);

  function onInit() {
    game.settings.register(moduleId, settings.reactionsEnabled, {
      name: "Подсказки реакций",
      hint: "Во время боя предлагает реакцию её владельцу, только когда условие действительно выполнено: Shield Block — с поднятым целым щитом, Nimble Dodge и другие бонусы к КБ — только если меняют результат атаки, Reactive Strike — по движению и действиям в досягаемости, а также реакции на урон, 0 ОЗ, спасброски и заклинания (около сотни реакций). Отмечает потраченную реакцию в трекере боя и восстанавливает её в начале хода. После изменения перезагрузите страницу.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true,
    });

    enabled = game.settings.get(moduleId, settings.reactionsEnabled) !== false;
    if (!enabled) return;

    ensureStylesheet();
    Hooks.on("createChatMessage", (message) => { void handleMessage(message).catch(logError); });
    // Foundry 13+ reports the whole path of a move; older versions only the end point.
    if (Number(game.release?.generation) >= 13) {
      Hooks.on("moveToken", (token, movement, _operation, user) => { void handleMovement(token, movement, user?.id ?? user).catch(logError); });
    } else {
      Hooks.on("updateToken", (token, changes, _options, userId) => { void handleTokenMove(token, changes, userId).catch(logError); });
    }
    Hooks.on("createToken", rememberPosition);
    Hooks.on("deleteToken", (token) => positions.delete(token.id));
    Hooks.on("canvasReady", () => {
      positions.clear();
      for (const token of canvas.scene?.tokens ?? []) rememberPosition(token);
    });
    Hooks.on("updateCombat", (combat, changes) => { void onUpdateCombat(combat, changes).catch(logError); });
    Hooks.on("combatStart", (combat) => { void resetAll(combat).catch(logError); });
    Hooks.on("deleteCombat", () => recentPrompts.clear());
    Hooks.on("renderCombatTracker", onRenderCombatTracker);
    const renderHook = Number(game.release?.generation) >= 13 ? "renderChatMessageHTML" : "renderChatMessage";
    Hooks.on(renderHook, onRenderChatMessage);
    // Loaded late by main.js on a cached manifest: the scene is already drawn.
    for (const token of globalThis.canvas?.scene?.tokens ?? []) rememberPosition(token);
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
      Hooks.on(hook, (item) => core.invalidate(item));
    }
  }

  function logError(error) {
    console.error(`${logPrefix} | reactions`, error);
  }

  // All clients receive the same hooks; only one may write flags or post prompts:
  // the active GM, or without one the author of the triggering message/update.
  function isResponsibleClient(authorId) {
    const activeGM = game.users?.activeGM;
    if (activeGM) return activeGM.id === game.user.id;
    return authorId === game.user.id;
  }

  // For events without an author (turn changes): the active GM, or else the
  // first active user, so the clients don't all write the same flag.
  function isPrimaryClient() {
    const activeGM = game.users?.activeGM;
    if (activeGM) return activeGM.id === game.user.id;
    const first = [...(game.users ?? [])].filter((user) => user.active).sort((a, b) => a.id.localeCompare(b.id))[0];
    return first?.id === game.user.id;
  }

  function messageAuthor(message) {
    return message?.author?.id ?? message?.user?.id ?? message?.user ?? null;
  }

  function activeCombat() {
    const combat = game.combat;
    return combat?.started ? combat : null;
  }

  function entriesFor(type) {
    if (!entriesByTrigger) {
      entriesByTrigger = new Map();
      for (const entry of feature.catalog) {
        for (const trigger of entry.triggers) {
          if (!entriesByTrigger.has(trigger)) entriesByTrigger.set(trigger, []);
          entriesByTrigger.get(trigger).push(entry);
        }
      }
    }
    return entriesByTrigger.get(type) ?? [];
  }

  // --- Chat messages -------------------------------------------------------
  async function handleMessage(message) {
    if (!enabled || !isResponsibleClient(messageAuthor(message))) return;
    if (message.getFlag?.(moduleId, promptFlag)) return;
    const combat = activeCombat();
    if (!combat) return;

    const used = usedReaction(message);
    if (used) {
      await spend(combat, used.actor, used.item);
      return;
    }

    // Most chat messages (initiative, flat checks, plain text) trigger nothing:
    // skip them before building the full context.
    const pf2eContext = message.flags?.pf2e?.context;
    const rawType = pf2eContext?.type ?? null;
    const type = rawType === "damage-taken" ? rawType
      : !rawType || rawType === "spell-cast" ? (message.flags?.pf2e?.origin ? "action" : null)
        : rawType;
    if (!type || entriesFor(type).length === 0) return;
    if (pf2eContext?.options?.includes?.("ignore-reaction")) return;

    const context = core.buildContext(message);
    context.type = type;
    if (type === "damage-taken") {
      // The message speaks for the damaged creature; PF2e records the damage source as origin.
      context.target = context.origin;
      context.origin = { actor: context.source.actor, token: context.source.token };
    } else if (type === "action" && (!context.item || !context.origin.actor)) {
      return;
    }
    await postPrompts(combat, collectPrompts(combat, context));
  }

  // A reaction item card posted by its owner spends the reaction.
  function usedReaction(message) {
    const contextType = message?.flags?.pf2e?.context?.type;
    if (contextType && contextType !== "spell-cast") return null;
    if (!message?.flags?.pf2e?.origin) return null;
    const item = message.item;
    const actor = item?.actor ?? message.actor;
    if (!item || !actor) return null;
    const isReaction = item.isOfType?.("action", "feat")
      ? item.system?.actionType?.value === "reaction"
      : item.isOfType?.("spell") && item.system?.time?.value === "reaction";
    return isReaction ? { actor, item } : null;
  }

  async function spend(combat, actor, item) {
    const combatant = combatantOf(combat, actor);
    if (!combatant) return;
    const state = core.spendState(combatant, core.slugOf(item));
    if (!state) {
      ui.notifications?.warn(`${actor.name}: реакция уже потрачена в этом раунде.`);
      return;
    }
    await combatant.setFlag(moduleId, flagKey, state);
  }

  function combatantOf(combat, actor) {
    if (!actor) return null;
    return combat.combatants.find((combatant) => combatant.actor === actor)
      ?? combat.combatants.find((combatant) => combatant.actor?.uuid === actor.uuid)
      ?? null;
  }

  // --- Movement ------------------------------------------------------------
  function rememberPosition(token) {
    positions.set(token.id, { x: token.x, y: token.y });
  }

  // Foundry 12: only the start and end of the move are known.
  async function handleTokenMove(token, changes, userId = game.user?.id) {
    if (!("x" in changes) && !("y" in changes)) return;
    const from = positions.get(token.id);
    rememberPosition(token);
    if (!from || (from.x === token.x && from.y === token.y)) return;
    await promptMove(token, [from, { x: token.x, y: token.y }], userId);
  }

  // Foundry 13+: every square along the path, including squares passed through.
  async function handleMovement(token, movement, userId) {
    if (!movement?.origin || ignoredMethods.has(movement.method)) return;
    const squares = core.movementSquares(movement.origin, movement.passed?.waypoints ?? [], token);
    rememberPosition(token);
    if (squares.length < 2) return;
    await promptMove(token, squares, userId);
  }

  async function promptMove(token, squares, userId) {
    if (!enabled || !isResponsibleClient(userId)) return;
    const combat = activeCombat();
    // Only the creature taking its turn moves on its own; other moves are forced or GM repositioning.
    if (!combat || combat.combatant?.tokenId !== token.id) return;
    const left = core.leftSquares(squares);
    if (left.length === 0) return;
    const mover = { actor: token.actor, token };
    const context = { type: "move", from: squares[0], squares, left, mover, origin: mover, target: null };
    await postPrompts(combat, collectPrompts(combat, context));
  }

  // --- Matching ------------------------------------------------------------
  function collectPrompts(combat, context) {
    const prompts = [];
    const entries = entriesFor(context.type);
    if (entries.length === 0) return prompts;

    const offered = new Set();
    const turnKey = `${combat.id}.${combat.round}.${combat.turn}`;
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      const token = combatant.token;
      if (!actor || !token) continue;
      const isTarget = !!context.target?.actor && (context.target.actor === actor || context.target.token === token);
      const isSelf = !!context.origin?.actor && (context.origin.actor === actor || context.origin.token === token);
      const reactor = { actor, token, combatant };
      let incapacitated;
      for (const entry of entries) {
        if (!inScope(entry.scope, isTarget, isSelf)) continue;
        // PF2e marks a downed NPC defeated at once; only "falling to 0 HP" reactions still apply.
        if (combatant.defeated && !entry.ignoreIncapacitation) continue;
        const item = core.findItem(actor, entry.slugs);
        if (!item) continue;
        const offerKey = `${combatant.id}.${item.id}`;
        if (offered.has(offerKey)) continue;
        if (core.remaining(combatant, core.slugOf(item)) <= 0) continue;
        if (!entry.ignoreIncapacitation && (incapacitated ??= core.isIncapacitated(actor))) continue;
        let note = null;
        try {
          note = entry.check(context, reactor);
        } catch (error) {
          console.warn(`${logPrefix} | reaction check ${entry.id} failed`, error);
        }
        if (!note) continue;
        const activity = entry.activity?.(context);
        if (activity) {
          const key = `${turnKey}.${offerKey}.${activity}`;
          if (recentPrompts.has(key)) continue;
          recentPrompts.add(key);
        }
        offered.add(offerKey);
        prompts.push({ entry, reactor, item, note });
      }
    }
    return prompts;
  }

  function inScope(scope, isTarget, isSelf) {
    switch (scope) {
      case "target": return isTarget;
      case "self": return isSelf;
      case "others": return !isTarget && !isSelf;
      case "any": return !isSelf;
      default: return false;
    }
  }

  async function postPrompts(combat, prompts) {
    if (prompts.length === 0) return;
    const gmIds = game.users.filter((user) => user.isGM).map((user) => user.id);
    const players = game.users.filter((user) => !user.isGM);
    const data = prompts.map(({ reactor, item, note }) => ({
      speaker: ChatMessage.getSpeaker({ token: reactor.token, actor: reactor.actor }),
      whisper: [...gmIds, ...players.filter((user) => reactor.actor.testUserPermission?.(user, "OWNER")).map((user) => user.id)],
      content: promptContent(item, note, core.remaining(reactor.combatant, core.slugOf(item))),
      flags: { [moduleId]: { [promptFlag]: { actor: reactor.actor.uuid, item: item.id, combat: combat.id } } },
    }));
    // One request for all prompts of a trigger.
    if (typeof ChatMessage.createDocuments === "function") await ChatMessage.createDocuments(data);
    else for (const entry of data) await ChatMessage.create(entry);
  }

  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  // Chat content is enriched on render: the link opens the item sheet and shows its tooltip.
  function itemLink(item) {
    const label = escape(String(item.name ?? "").replace(/[{}[\]]/g, ""));
    return item.uuid ? `@UUID[${item.uuid}]{${label}}` : label;
  }

  function promptContent(item, note, left) {
    return `<div class="pf2e-eliott-reaction">
  <header><img src="${escape(item.img)}" alt=""><h3>Реакция: ${itemLink(item)}</h3></header>
  <p>${escape(note)}</p>
  <footer><span>Доступно реакций: ${left}</span><button type="button" data-action="${useAction}">Использовать</button></footer>
</div>`;
  }

  // Prompt's actor, item and combatant as this client sees them, or null.
  function promptState(data) {
    const actor = typeof fromUuidSync === "function" ? fromUuidSync(data.actor) : null;
    const item = actor?.items?.get(data.item) ?? null;
    const combat = game.combats?.get?.(data.combat) ?? game.combat;
    const combatant = combat ? combatantOf(combat, actor) : null;
    return { actor, item, combatant };
  }

  function onRenderChatMessage(message, html) {
    const data = message.getFlag?.(moduleId, promptFlag);
    if (!data) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const button = root?.querySelector?.(`[data-action="${useAction}"]`);
    if (!button) return;
    const initial = promptState(data);
    if (!initial.item || (initial.combatant && core.remaining(initial.combatant, core.slugOf(initial.item)) <= 0)) {
      button.disabled = true;
      button.textContent = initial.item ? "Реакция потрачена" : "Недоступно";
    }
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        const { actor, item, combatant } = promptState(data);
        if (!item) throw new Error("Реакция больше не найдена у персонажа.");
        if (combatant && core.remaining(combatant, core.slugOf(item)) <= 0) {
          ui.notifications.warn(`${actor.name}: реакция уже потрачена.`);
          button.textContent = "Реакция потрачена";
          return;
        }
        await item.toMessage(event);
      } catch (error) {
        button.disabled = false;
        logError(error);
        ui.notifications.error(error.message);
      }
    });
  }

  // --- Refresh and tracker -------------------------------------------------
  async function onUpdateCombat(combat, changes) {
    if (!("turn" in changes) && !("round" in changes)) return;
    recentPrompts.clear();
    if (!combat.started || !isPrimaryClient()) return;
    const combatant = combat.combatant;
    if (combatant?.getFlag(moduleId, flagKey)) await combatant.unsetFlag(moduleId, flagKey);
  }

  async function resetAll(combat) {
    if (!isPrimaryClient()) return;
    const updates = combat.combatants
      .filter((combatant) => combatant.getFlag(moduleId, flagKey))
      .map((combatant) => ({ _id: combatant.id, [`flags.${moduleId}.-=${flagKey}`]: null }));
    if (updates.length > 0) await combat.updateEmbeddedDocuments("Combatant", updates);
  }

  function onRenderCombatTracker(app, html) {
    const combat = app?.viewed ?? game.combat;
    const root = html instanceof HTMLElement ? html : html?.[0] ?? app?.element;
    if (!combat || !root?.querySelectorAll) return;
    for (const row of root.querySelectorAll("[data-combatant-id]")) {
      const combatant = combat.combatants.get(row.dataset.combatantId);
      if (!combatant?.actor || !(game.user.isGM || combatant.actor.isOwner || combatant.hasPlayerOwner)) continue;
      row.querySelector(".pf2e-eliott-reaction-state")?.remove();
      const left = core.remaining(combatant);
      const icon = document.createElement("a");
      icon.className = `pf2e-eliott-reaction-state${left > 0 ? "" : " spent"}`;
      icon.dataset.tooltip = left > 0 ? "Реакция доступна" : "Реакция потрачена";
      icon.innerHTML = '<i class="fa-solid fa-reply"></i>';
      if (game.user.isGM) {
        icon.dataset.tooltip += " (щелчок — переключить)";
        icon.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const state = left > 0 ? { spent: 1, pools: core.readPool(combatant).pools } : null;
          void (state ? combatant.setFlag(moduleId, flagKey, state) : combatant.unsetFlag(moduleId, flagKey)).catch(logError);
        });
      }
      const anchor = row.querySelector(".token-name, .combatant-name, h4") ?? row;
      anchor.append(icon);
    }
  }

  function ensureStylesheet() {
    const href = foundry.utils.getRoute(`modules/${moduleId}/${stylesheet}`);
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }
})();
