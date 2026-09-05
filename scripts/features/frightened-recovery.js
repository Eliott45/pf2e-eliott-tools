(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const processedRounds = new WeakMap();
  const actorQueues = new Map();

  tools.features ??= {};
  tools.features.frightenedRecovery = { onEndTurn, onUpdateCombat };

  function onUpdateCombat(encounter, changed) {
    if (changed.round !== 0) return;
    for (const combatant of encounter.combatants) processedRounds.delete(combatant);
  }

  function canProcess() {
    return game.user.isGM && game.users.activeGM?.id === game.user.id
      && game.settings.get(moduleId, settings.frightenedRecoveryEnabled) === true;
  }

  async function onEndTurn(combatant, encounter) {
    if (!canProcess() || !encounter?.started || combatant.parent !== encounter) return;
    // The encounter can already be in the NEXT round. PF2e records the round of
    // the completed turn on this combatant before emitting pf2e.endTurn.
    const round = combatant.flags?.pf2e?.roundOfLastTurnEnd;
    if (!Number.isInteger(round) || round < 1) return;
    const rounds = processedRounds.get(combatant) ?? new Set();
    if (rounds.has(round)) return;
    rounds.add(round);
    processedRounds.set(combatant, rounds);

    // A synthetic token must keep its own actor; never fall back to the world actor.
    const actors = new Map([combatant.actor, ...(combatant.tokens ?? []).map((token) => token.actor)]
      .filter((actor) => actor?.isOfType("creature") && !actor.isDead)
      .map((actor) => [actor.uuid, actor]));
    await Promise.all([...actors.values()].map(async (actor) => {
      // All independent sources decay, including a weaker, currently overridden
      // source. Snapshot IDs/values so a later fear application is not decremented.
      const conditions = actor.itemTypes.condition.filter(isReducible)
        .map((condition) => ({ id: condition.id, value: condition._source.system.value.value }));
      if (conditions.length === 0) return;
      const previous = actorQueues.get(actor.uuid) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        for (const snapshot of conditions) {
          if (!canProcess() || !encounter.started || actor.isDead) return;
          const condition = actor.items.get(snapshot.id);
          if (!isReducible(condition) || condition._source.system.value.value !== snapshot.value) continue;
          await actor.decreaseCondition(condition);
        }
      });
      actorQueues.set(actor.uuid, task);
      try {
        await task;
      } catch (error) {
        // Do not replay a partly completed turn and decrement its other sources twice.
        console.error(`${logPrefix} | Frightened recovery failed`, error);
        ui.notifications.error("Не удалось уменьшить испуг в конце хода. Проверьте состояние участника боя.");
      } finally {
        if (actorQueues.get(actor.uuid) === task) actorQueues.delete(actor.uuid);
      }
    }));
  }

  function isReducible(condition) {
    const value = condition?._source?.system?.value?.value;
    return condition?.slug === "frightened" && !condition.isLocked
      && !condition.inMemoryOnly && !condition.readonly
      && Number.isInteger(value) && value > 0;
  }
})();
