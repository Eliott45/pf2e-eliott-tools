(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId } = tools.module;
  const feature = ((tools.features ??= {}).reactions ??= {});

  const physicalTypes = new Set(["bludgeoning", "piercing", "slashing"]);
  // Creatures in these conditions can't use reactions at all.
  const incapacitatingConditions = ["unconscious", "paralyzed", "petrified", "stunned", "confused"];
  const degrees = ["criticalFailure", "failure", "success", "criticalSuccess"];
  const saves = ["fortitude", "reflex", "will"];

  // Extra reactions limited to particular reactions. The general reaction is
  // spent only once every matching extra one is gone.
  const extraPools = [
    { slug: "combat-reflexes", amount: 1, for: ["reactive-strike", "attack-of-opportunity"] },
    { slug: "triple-opportunity", amount: 2, for: ["reactive-strike", "attack-of-opportunity"] },
    { slug: "quick-shield-block", amount: 1, for: ["shield-block"] },
  ];

  // --- Item index ----------------------------------------------------------
  // Each reaction check needs to know whether an actor has some feat or action.
  // A per-actor slug map is built once and dropped when any such item changes:
  // an unlinked token's actor also changes when its base actor does, so the
  // whole cache is reset rather than one entry.
  const indexedTypes = new Set(["feat", "action", "spell"]);
  let indexCache = new WeakMap();

  function sluggify(text) {
    const pf2eSluggify = globalThis.game?.pf2e?.system?.sluggify;
    if (typeof pf2eSluggify === "function") return pf2eSluggify(text);
    return String(text ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function itemIndex(actor) {
    let index = indexCache.get(actor);
    if (index) return index;
    index = new Map();
    for (const type of indexedTypes) {
      for (const item of actor?.itemTypes?.[type] ?? []) {
        if (type === "spell" && item.system?.time?.value !== "reaction") continue;
        // Homebrew items may lack a slug: fall back to the (English) name.
        const slug = item.slug || sluggify(item.name);
        if (slug && !index.has(slug)) index.set(slug, item);
      }
    }
    if (actor) indexCache.set(actor, index);
    return index;
  }

  function invalidate(item) {
    if (!item || indexedTypes.has(item.type)) indexCache = new WeakMap();
  }

  function slugOf(item) {
    return item?.slug || sluggify(item?.name);
  }

  function hasItem(actor, slugs) {
    const index = itemIndex(actor);
    return slugs.some((slug) => index.has(slug));
  }

  function findItem(actor, slugs) {
    const index = itemIndex(actor);
    for (const slug of slugs) {
      const item = index.get(slug);
      if (item && hasUsesLeft(item)) return item;
    }
    return null;
  }

  function hasUsesLeft(item) {
    const frequency = item.system?.frequency;
    if (!frequency || !(Number(frequency.max) > 0)) return true;
    return Number(frequency.value ?? frequency.max) > 0;
  }

  function hasEffect(actor, slugs) {
    return (actor?.itemTypes?.effect ?? []).some((effect) => slugs.includes(effect.slug));
  }

  function hasCondition(actor, slug) {
    return !!actor?.hasCondition?.(slug);
  }

  // --- Reaction pool -------------------------------------------------------
  function readPool(combatant) {
    const state = combatant?.getFlag?.(moduleId, "reactions") ?? {};
    return { spent: Number(state.spent) || 0, pools: { ...(state.pools ?? {}) } };
  }

  function poolsFor(actor, slug) {
    const index = itemIndex(actor);
    return extraPools.filter((pool) => pool.for.includes(slug) && index.has(pool.slug));
  }

  function remaining(combatant, slug) {
    const state = readPool(combatant);
    const general = Math.max(1 - state.spent, 0);
    if (!slug) return general;
    const extra = poolsFor(combatant.actor, slug)
      .reduce((sum, pool) => sum + Math.max(pool.amount - (Number(state.pools[pool.slug]) || 0), 0), 0);
    return general + extra;
  }

  // Returns the new flag state, or null when nothing is left to spend.
  function spendState(combatant, slug) {
    const state = readPool(combatant);
    const pool = poolsFor(combatant.actor, slug)
      .find((entry) => (Number(state.pools[entry.slug]) || 0) < entry.amount);
    if (pool) {
      state.pools[pool.slug] = (Number(state.pools[pool.slug]) || 0) + 1;
      return state;
    }
    if (state.spent >= 1) return null;
    state.spent += 1;
    return state;
  }

  function isIncapacitated(actor) {
    return incapacitatingConditions.some((slug) => hasCondition(actor, slug));
  }

  // --- Geometry ------------------------------------------------------------
  function reachOf(actor) {
    return Number(actor?.getReach?.({ action: "attack" })) || 5;
  }

  function distance(fromTokenDocument, toTokenDocument) {
    const from = fromTokenDocument?.object;
    const to = toTokenDocument?.object;
    if (!from || !to || typeof from.distanceTo !== "function") return Infinity;
    if (from === to) return 0;
    return from.distanceTo(to);
  }

  function within(fromTokenDocument, toTokenDocument, feet) {
    return distance(fromTokenDocument, toTokenDocument) <= feet;
  }

  function isAdjacent(fromTokenDocument, toTokenDocument) {
    return within(fromTokenDocument, toTokenDocument, 5);
  }

  function withinReach(reactorTokenDocument, targetTokenDocument) {
    const from = reactorTokenDocument?.object;
    const to = targetTokenDocument?.object;
    if (!from || !to || typeof from.distanceTo !== "function") return false;
    const reach = reachOf(reactorTokenDocument.actor);
    return from.distanceTo(to, { reach }) <= reach;
  }

  // Distance from the reactor to where a moving token stood before the move.
  function distanceToPoint(reactorTokenDocument, movedTokenDocument, origin, reach = null) {
    const from = reactorTokenDocument?.object;
    if (!from || typeof from.distanceTo !== "function" || !globalThis.PIXI) return Infinity;
    const size = canvas.grid?.size ?? 100;
    const width = Math.max(Number(movedTokenDocument.width) || 1, 1) * size;
    const height = Math.max(Number(movedTokenDocument.height) || 1, 1) * size;
    const ghost = {
      x: origin.x,
      y: origin.y,
      mechanicalBounds: new PIXI.Rectangle(origin.x, origin.y, width, height),
      document: { elevation: movedTokenDocument.elevation ?? 0 },
    };
    return from.distanceTo(ghost, { reach });
  }

  function withinReachOfPoint(reactorTokenDocument, movedTokenDocument, origin) {
    const reach = reachOf(reactorTokenDocument?.actor);
    return distanceToPoint(reactorTokenDocument, movedTokenDocument, origin, reach) <= reach;
  }

  // Squares the moving token left: every square of the path but the last.
  function leftReachAlong(reactorTokenDocument, movedTokenDocument, squares) {
    return (squares ?? []).some((square) => withinReachOfPoint(reactorTokenDocument, movedTokenDocument, square));
  }

  function withinAlong(reactorTokenDocument, movedTokenDocument, squares, feet) {
    return (squares ?? []).some((square) => distanceToPoint(reactorTokenDocument, movedTokenDocument, square) <= feet);
  }

  // Top-left positions of every grid square a token occupies along its path,
  // from `origin` through `waypoints` (Foundry 13+ movement data). Segments the
  // token was displaced along (teleport, undo, paste) are not movement: they
  // break the path instead of filling it with squares.
  function movementSquares(origin, waypoints, tokenDocument) {
    const grid = globalThis.canvas?.grid;
    const size = grid?.size ?? 100;
    const half = (Math.min(Number(tokenDocument?.width) || 1, 1) * size) / 2;
    const squares = [{ x: origin.x, y: origin.y }];
    let previous = origin;
    for (const waypoint of waypoints ?? []) {
      if (waypoint.action !== "displace") {
        const gridded = grid && !grid.isGridless && typeof grid.getDirectPath === "function" && typeof grid.getTopLeftPoint === "function";
        if (gridded) {
          // Path of the token's top-left square: its centre never sits on a grid line.
          const offsets = grid.getDirectPath([
            { x: previous.x + half, y: previous.y + half },
            { x: waypoint.x + half, y: waypoint.y + half },
          ]);
          for (const offset of offsets.slice(1)) squares.push(grid.getTopLeftPoint(offset));
        } else {
          squares.push({ x: waypoint.x, y: waypoint.y });
        }
      }
      previous = waypoint;
      const last = squares.at(-1);
      if (waypoint.action === "displace" || last.x !== waypoint.x || last.y !== waypoint.y) squares.push({ x: waypoint.x, y: waypoint.y, displaced: waypoint.action === "displace" });
    }
    // Drop consecutive repeats.
    return squares.filter((square, index) => index === 0 || square.x !== squares[index - 1].x || square.y !== squares[index - 1].y);
  }

  // Squares actually walked out of: each square followed by a non-displaced step.
  function leftSquares(squares) {
    return squares.filter((square, index) => index < squares.length - 1 && !squares[index + 1].displaced);
  }

  function auraRadius(actor) {
    const radii = [...(actor?.auras?.values?.() ?? [])].map((aura) => Number(aura.radius) || 0);
    return radii.length > 0 ? Math.max(...radii) : 0;
  }

  // --- Message context -----------------------------------------------------
  function degreeIndex(outcome) {
    return degrees.indexOf(outcome);
  }

  // PF2e degree of success for a check against a DC.
  function degreeOf(total, dc, die) {
    let degree = total >= dc + 10 ? 3 : total >= dc ? 2 : total > dc - 10 ? 1 : 0;
    if (die === 20) degree += 1;
    else if (die === 1) degree -= 1;
    return Math.min(Math.max(degree, 0), 3);
  }

  function resolve(uuid) {
    if (!uuid || typeof globalThis.fromUuidSync !== "function") return null;
    try {
      return fromUuidSync(uuid);
    } catch (_error) {
      return null;
    }
  }

  // Effect or attack source recorded by PF2e: who rolled the attack or caused the save.
  function resolveSource(originData) {
    const item = resolve(originData?.uuid ?? originData?.item);
    const actor = resolve(originData?.actor) ?? item?.actor ?? null;
    const token = resolve(originData?.token) ?? actor?.getActiveTokens?.(true, true)?.[0] ?? null;
    return { actor, item, token, type: originData?.type ?? item?.type ?? null };
  }

  function buildContext(message) {
    const pf2e = message?.flags?.pf2e ?? {};
    const context = pf2e.context ?? null;
    const item = message.item ?? null;
    const roll = message.rolls?.[0] ?? null;
    const traits = new Set([
      ...(context?.traits ?? []).map((trait) => trait?.name ?? trait),
      ...(item?.system?.traits?.value ?? []),
    ]);
    const options = new Set([...(context?.options ?? []), ...(pf2e.origin?.rollOptions ?? [])]);
    const domains = new Set(context?.domains ?? []);
    const damageTypes = new Set((roll?.instances ?? []).map((instance) => instance.type).filter(Boolean));
    const die = roll?.dice?.[0]?.total ?? roll?.terms?.[0]?.total ?? null;
    return {
      message,
      type: context?.type ?? null,
      outcome: context?.outcome ?? null,
      options,
      domains,
      traits,
      item,
      damageTypes,
      total: Number(roll?.total),
      die: Number(die),
      dc: Number(context?.dc?.value),
      origin: { actor: message.actor ?? null, token: message.token ?? null },
      target: message.target ?? null,
      // Resolving UUIDs costs lookups most checks never need.
      get source() {
        const value = resolveSource(pf2e.origin);
        Object.defineProperty(this, "source", { value, writable: true, enumerable: true });
        return value;
      },
      set source(value) {
        Object.defineProperty(this, "source", { value, writable: true, enumerable: true });
      },
    };
  }

  function isHit(context) {
    return context.outcome === "success" || context.outcome === "criticalSuccess";
  }

  function isFailure(context) {
    return context.outcome === "failure" || context.outcome === "criticalFailure";
  }

  function isMeleeAttack(context) {
    if (typeof context.item?.isMelee === "boolean") return context.item.isMelee;
    if (context.options.has("item:melee") || context.domains.has("melee-attack-roll") || context.traits.has("melee")) return true;
    return false;
  }

  function isRangedAttack(context) {
    if (typeof context.item?.isRanged === "boolean") return context.item.isRanged;
    if (context.domains.has("ranged-attack-roll") || context.options.has("item:ranged")) return true;
    return !!context.item?.isOfType?.("weapon", "melee") && !isMeleeAttack(context);
  }

  function isStrike(context) {
    return !!context.item?.isOfType?.("weapon", "melee") || context.options.has("action:strike") || context.domains.has("strike-attack-roll") || context.domains.has("strike-damage");
  }

  function isSpell(context) {
    return !!context.item?.isOfType?.("spell") || context.source.type === "spell";
  }

  function isAttack(context) {
    return context.traits.has("attack") || context.options.has("attack") || isStrike(context);
  }

  // Trait of the action, the attack, or the effect a save is made against.
  function hasTrait(context, trait) {
    return context.traits.has(trait)
      || context.options.has(`item:trait:${trait}`)
      || context.options.has(`origin:item:trait:${trait}`)
      || context.source.item?.system?.traits?.value?.includes?.(trait) === true;
  }

  function statistic(context) {
    for (const slug of saves) {
      if (context.domains.has(slug) || context.options.has(`check:statistic:${slug}`)) return slug;
    }
    return null;
  }

  function hasPhysicalDamage(context) {
    for (const type of context.damageTypes) if (physicalTypes.has(type)) return true;
    return false;
  }

  function hasDamageType(context, types) {
    return types.some((type) => context.damageTypes.has(type));
  }

  // Lowered attack outcome if the defender's AC were higher by `bonus`, or null.
  function downgradedOutcome(context, bonus) {
    if (!isHit(context) || !Number.isFinite(context.total) || !Number.isFinite(context.dc)) return null;
    const next = degreeOf(context.total, context.dc + bonus, context.die);
    return next < degreeIndex(context.outcome) ? degrees[next] : null;
  }

  // Attack outcome against another defense, when that turns a hit into something lower.
  function outcomeAgainstDC(context, dc) {
    if (!isHit(context) || !Number.isFinite(context.total) || !Number.isFinite(Number(dc))) return null;
    const next = degreeOf(context.total, Number(dc), context.die);
    return next < degreeIndex(context.outcome) ? degrees[next] : null;
  }

  // Raised outcome if the roll were higher by `bonus`, or null.
  function upgradedOutcome(context, bonus) {
    if (!context.outcome || !Number.isFinite(context.total) || !Number.isFinite(context.dc)) return null;
    const next = degreeOf(context.total + bonus, context.dc, context.die);
    return next > degreeIndex(context.outcome) ? degrees[next] : null;
  }

  // A shield the actor can actually use right now.
  function usableShield(actor) {
    const shield = actor?.heldShield ?? null;
    if (!shield || shield.isBroken || shield.isDestroyed) return null;
    return shield;
  }

  function isShieldRaised(actor) {
    const state = actor?.attributes?.shield;
    return !!state?.raised && !state.broken && !state.destroyed && !!usableShield(actor);
  }

  function heldWeapons(actor) {
    return (actor?.itemTypes?.weapon ?? []).filter((weapon) => weapon.isEquipped && Number(weapon.handsHeld) > 0);
  }

  function isEnemy(actor, other) {
    if (!actor || !other || actor === other) return false;
    return typeof actor.isEnemyOf === "function" ? actor.isEnemyOf(other) : false;
  }

  function isAlly(actor, other) {
    if (!actor || !other || actor === other) return false;
    return typeof actor.isAllyOf === "function" ? actor.isAllyOf(other) : false;
  }

  function hp(actor) {
    return actor?.hitPoints ?? actor?.attributes?.hp ?? null;
  }

  // A damage-taken message that dropped its creature from above 0 to 0 HP.
  function droppedToZero(context, actor) {
    const points = hp(actor);
    if (!points || Number(points.value) !== 0) return false;
    const updates = context.message?.flags?.pf2e?.appliedDamage?.updates ?? [];
    const lost = updates.find((update) => update?.path === "system.attributes.hp.value");
    return Number(lost?.value) > 0;
  }

  function isDead(actor) {
    const dying = actor?.attributes?.dying;
    return !!dying && Number(dying.max) > 0 && Number(dying.value) >= Number(dying.max);
  }

  // Thaumaturge's Exploit Vulnerability target (PF2e effect or pf2e-thaum-vuln flags).
  function isExploitTarget(thaumaturge, creature) {
    return (creature?.itemTypes?.effect ?? []).some((effect) => {
      const slug = effect.slug ?? "";
      if (!["effect-exploit-vulnerability", "mortal-weakness-target", "personal-antithesis-target"].some((prefix) => slug.startsWith(prefix))) return false;
      const origin = effect.flags?.["pf2e-thaum-vuln"]?.EffectOrigin ?? effect.origin?.uuid ?? null;
      return !origin || origin === thaumaturge.uuid;
    });
  }

  const outcomeLabels = {
    criticalSuccess: "критический успех",
    success: "успех",
    failure: "провал",
    criticalFailure: "критический провал",
  };
  const attackLabels = {
    criticalSuccess: "критическое попадание",
    success: "попадание",
    failure: "промах",
    criticalFailure: "критический промах",
  };

  Object.assign(feature, {
    core: {
      extraPools,
      itemIndex,
      invalidate,
      slugOf,
      hasItem,
      findItem,
      hasEffect,
      hasCondition,
      readPool,
      remaining,
      spendState,
      isIncapacitated,
      reachOf,
      distance,
      within,
      isAdjacent,
      withinReach,
      distanceToPoint,
      withinReachOfPoint,
      leftReachAlong,
      withinAlong,
      movementSquares,
      leftSquares,
      auraRadius,
      degreeOf,
      buildContext,
      resolveSource,
      isHit,
      isFailure,
      isMeleeAttack,
      isRangedAttack,
      isStrike,
      isSpell,
      isAttack,
      hasTrait,
      statistic,
      hasPhysicalDamage,
      hasDamageType,
      downgradedOutcome,
      outcomeAgainstDC,
      upgradedOutcome,
      usableShield,
      isShieldRaised,
      heldWeapons,
      isEnemy,
      isAlly,
      hp,
      droppedToZero,
      isDead,
      isExploitTarget,
      outcomeLabels,
      attackLabels,
    },
  });
})();
