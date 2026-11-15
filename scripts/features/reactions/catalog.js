(function () {
  const tools = globalThis.pf2eEliottTools;
  const feature = ((tools.features ??= {}).reactions ??= {});
  const core = feature.core;

  // Each reaction declares the events it listens to (`triggers`) and who may
  // react (`scope`):
  //   target — the attacked, damaged or downed creature;
  //   self   — the creature that rolled or acted (for saves: the one saving);
  //   others — anyone but those two;  any — anyone but the one who acted.
  // `check` returns a note for the prompt, or null when the trigger is not met.
  // Shared gates (combatant, item with uses left, unspent reaction, conditions)
  // run before `check`. Requirements a module can't see (awareness, line of
  // sight, free hands) are left to the player and named in the note.
  const L = core.attackLabels;
  const O = core.outcomeLabels;
  const name = (actor) => actor?.name ?? "—";
  const attacker = (context) => context.origin.actor;

  // One activity can post several messages: a Stride card and the token's
  // movement, or a spell card and its attack roll. Reactions to "moving" or to
  // "casting" are offered once per activity, not once per message.
  function activity(context) {
    if (context.type === "move" || (context.type === "action" && context.traits.has("move"))) return "move";
    const spell = context.item?.isOfType?.("spell") ? context.item : null;
    return spell ? `spell:${spell.uuid ?? spell.id}` : null;
  }

  const catalog = [];
  const add = (entry) => catalog.push({ scope: "target", ...entry });

  // --- Attacks against you: bonus to AC ------------------------------------
  // PF2e uses these before the roll; the prompt only appears when the bonus
  // would actually change the result, so it never interrupts for nothing.
  function acDefense(id, slugs, bonus, when = () => true, extra = "") {
    add({
      id, slugs, triggers: ["attack-roll"],
      check(context, reactor) {
        if (!core.isEnemy(reactor.actor, attacker(context)) || !when(context, reactor)) return null;
        const value = typeof bonus === "function" ? bonus(reactor) : bonus;
        if (!(value > 0)) return null;
        const outcome = core.downgradedOutcome(context, value);
        if (!outcome) return null;
        return `+${value} к КБ превратит ${L[context.outcome]} ${name(attacker(context))} в ${L[outcome]}.${extra ? ` ${extra}` : ""}`;
      },
    });
  }

  acDefense("nimble-dodge", ["nimble-dodge"], 2, (_c, r) => !core.hasCondition(r.actor, "encumbered"));
  acDefense("flashy-dodge", ["flashy-dodge"], 2, (_c, r) => !core.hasCondition(r.actor, "encumbered"), "При промахе — панаш.");
  acDefense("farabellus-flip", ["farabellus-flip"], 2, (c) => core.isMeleeAttack(c) && core.isStrike(c));
  acDefense("pirouette", ["pirouette"], 2, (c, r) => core.isStrike(c) && core.hasEffect(r.actor, ["stance-masquerade-of-seasons-stance"]));
  acDefense("hit-the-dirt", ["hit-the-dirt"], 2, (c) => core.isRangedAttack(c) && core.isStrike(c), "После прыжка вы ничком.");
  acDefense("crane-flutter", ["crane-flutter"], 2, (_c, r) => core.hasEffect(r.actor, ["stance-crane-stance"]), "Бонус Стойки журавля растёт до +3.");
  acDefense("inked-panoply", ["inked-panoply"], 1);
  acDefense("deflect-projectile", ["deflect-projectile", "deflect-arrow"], 4, (c) => core.isRangedAttack(c) && core.isStrike(c), "Нужна свободная рука.");
  acDefense("wood-ward", ["wood-ward"], 2, () => true, "Стандартное укрытие.");
  acDefense("reactive-shield", ["reactive-shield"], (r) => (core.isShieldRaised(r.actor) ? 0 : Number(core.usableShield(r.actor)?.acBonus) || 0),
    (c) => core.isMeleeAttack(c) && core.isStrike(c), "Поднять щит.");

  for (const id of ["guardians-deflection-fighter", "guardians-deflection-swashbuckler"]) {
    add({
      id, slugs: [id], triggers: ["attack-roll"], scope: "others",
      check(context, reactor) {
        const ally = context.target;
        if (!core.isAlly(reactor.actor, ally?.actor) || !core.isEnemy(reactor.actor, attacker(context))) return null;
        if (!core.withinReach(reactor.token, ally.token)) return null;
        const outcome = core.downgradedOutcome(context, 2);
        if (!outcome) return null;
        return `+2 к КБ союзника ${name(ally.actor)} превратит ${L[context.outcome]} в ${L[outcome]}.`;
      },
    });
  }

  // --- Attacks against you: another DC instead of AC ------------------------
  function dcDefense(id, slugs, label, dcOf, when = () => true) {
    add({
      id, slugs, triggers: ["attack-roll"],
      check(context, reactor) {
        if (!when(context, reactor)) return null;
        const dc = dcOf(reactor.actor);
        const outcome = core.outcomeAgainstDC(context, dc);
        if (!outcome) return null;
        return `Против ${label} (${dc}) атака ${name(attacker(context))} станет: ${L[outcome]}.`;
      },
    });
  }

  dcDefense("foresee-danger", ["foresee-danger"], "КС Восприятия", (actor) => actor.perception?.dc?.value);
  dcDefense("nights-warning", ["nights-warning"], "КС Оккультизма", (actor) => actor.skills?.occultism?.dc?.value);
  const natureTraits = ["animal", "beast", "elemental", "fey", "fungus", "plant"];
  dcDefense("hunters-defense", ["hunters-defense"], "КС Природы", (actor) => actor.skills?.nature?.dc?.value,
    (context) => natureTraits.some((trait) => attacker(context)?.system?.traits?.value?.includes(trait)));

  // --- Attacks against you: other answers to a hit --------------------------
  function onHit(id, slugs, text, when = () => true) {
    add({
      id, slugs, triggers: ["attack-roll"],
      check(context, reactor) {
        if (!core.isHit(context) || !core.isEnemy(reactor.actor, attacker(context))) return null;
        if (!when(context, reactor)) return null;
        return `${name(attacker(context))}: ${L[context.outcome]} по вам. ${typeof text === "function" ? text(context, reactor) : text}`;
      },
    });
  }

  onHit("eerie-flicker", ["eerie-flicker"], "Вы становитесь скрыты: атакующий бросает плоскую проверку КС 5.", (c) => core.isStrike(c));
  onHit("lucky-escape", ["lucky-escape"], "Атакующий перебрасывает атаку и берёт худший результат.");
  onHit("instinctive-obfuscation", ["instinctive-obfuscation"], "Атакующий бросает плоскую проверку КС 10, иначе бьёт двойника.");
  onHit("disarming-smile", ["disarming-smile"], "Дипломатия против КС Воли атакующего (только если вы не вредили ему).",
    (c) => core.isMeleeAttack(c) && attacker(c)?.system?.traits?.value?.includes("humanoid"));
  onHit("airy-step", ["airy-step"], "Туман делает вас скрытыми для этой атаки.");
  onHit("reflective-defense", ["reflective-defense"], "Атакующий делает спасбросок Рефлекса или ослеплён.",
    (c, r) => core.within(r.token, c.origin.token, 30));
  onHit("reactive-charm", ["reactive-charm"], "Сотворите врождённое ментальное заклинание 1-го ранга до атаки.");
  onHit("you-failed-to-account-for-this", ["you-failed-to-account-for-this"], "Проверка Ремесла вместо КБ.");
  onHit("deflecting-cloud", ["deflecting-cloud"], "Нужны активные крылья дракона.", (c) => core.isRangedAttack(c));
  onHit("ectoplasmic-shield", ["ectoplasmic-shield"], "Эктоплазменный щит против дальнобойной атаки.", (c) => core.isRangedAttack(c));
  onHit("emergency-targe", ["emergency-targe"], "Щит или заклинание Shield против этой атаки.",
    (c, r) => (core.isStrike(c) || core.isSpell(c)) && (!!core.usableShield(r.actor) || (r.actor.itemTypes?.spell ?? []).some((s) => s.slug === "shield")));
  onHit("impossible-technique", ["impossible-technique"], "Атакующий перебрасывает атаку и берёт худший результат.",
    (_c, r) => !core.hasCondition(r.actor, "fatigued") && (!r.actor.wornArmor || r.actor.wornArmor.category === "unarmored"));
  onHit("wicked-thorns", ["wicked-thorns"], "Шипы ранят атакующего.",
    (c) => core.isMeleeAttack(c) && core.isStrike(c) && (c.traits.has("unarmed") || !c.traits.has("reach")));
  onHit("rippling-spin", ["rippling-spin"], "Нужна Стойка отражённой ряби.",
    (c, r) => core.isMeleeAttack(c) && core.hasEffect(r.actor, ["stance-reflective-ripple-stance"]) && core.withinReach(r.token, c.origin.token));
  onHit("fiery-retort", ["fiery-retort"], "Огонь по атакующему.", (c, r) => core.isMeleeAttack(c) && core.isAdjacent(r.token, c.origin.token));

  function onCrit(id, slugs, text, when = () => true) {
    add({
      id, slugs, triggers: ["attack-roll"],
      check(context, reactor) {
        if (context.outcome !== "criticalSuccess" || !core.isEnemy(reactor.actor, attacker(context))) return null;
        if (!when(context, reactor)) return null;
        return `${name(attacker(context))} наносит вам критическое попадание. ${text}`;
      },
    });
  }

  onCrit("storm-retribution", ["storm-retribution"], "Нужен 1 пункт фокусировки.",
    (c, r) => core.isMeleeAttack(c) && core.isAdjacent(r.token, c.origin.token) && Number(r.actor.system?.resources?.focus?.value) > 0);
  onCrit("furious-vengeance", ["furious-vengeance"], "Ответный Удар.",
    (c, r) => core.isMeleeAttack(c) && core.isStrike(c) && core.withinReach(r.token, c.origin.token));
  onCrit("cringe", ["cringe"], "Урон атакующего снижается.", (c) => core.isStrike(c));
  onCrit("vengeful-spite", ["vengeful-spite"], "Ответная атака.");

  function onCritFail(id, slugs, text, when = () => true) {
    add({
      id, slugs, triggers: ["attack-roll"],
      check(context, reactor) {
        if (context.outcome !== "criticalFailure" || !core.isStrike(context)) return null;
        if (!core.isEnemy(reactor.actor, attacker(context)) || !core.withinReach(reactor.token, context.origin.token)) return null;
        if (!when(context, reactor)) return null;
        return `${name(attacker(context))} критически промахивается Ударом по вам. ${text}`;
      },
    });
  }

  onCritFail("opportune-riposte", ["opportune-riposte"], "Удар или Разоружение против атакующего.");
  onCritFail("dueling-riposte", ["dueling-riposte"], "Действует Дуэльное парирование.", (_c, r) => core.hasEffect(r.actor, ["effect-dueling-parry"]));
  onCritFail("twin-riposte", ["twin-riposte"], "Действует Двойное парирование.", (_c, r) => core.hasEffect(r.actor, ["effect-twin-parry", "effect-twin-parry-parry-trait"]));
  onCritFail("knights-retaliation", ["knights-retaliation"], "Атакующий — нежить.", (c) => attacker(c)?.system?.traits?.value?.includes("undead"));

  add({
    id: "mirror-shield", slugs: ["mirror-shield"], triggers: ["attack-roll"],
    check(context, reactor) {
      if (context.outcome !== "criticalFailure" || !core.isSpell(context) || !core.isShieldRaised(reactor.actor)) return null;
      return `${name(attacker(context))} критически промахивается заклинанием: отразите его щитом.`;
    },
  });

  add({
    id: "suspect-of-opportunity", slugs: ["suspect-of-opportunity"], triggers: ["attack-roll"],
    check(context, reactor) {
      if (!core.isEnemy(reactor.actor, attacker(context))) return null;
      return `${name(attacker(context))} атакует вас: Person of Interest, если он не связан с расследованием.`;
    },
  });

  add({
    id: "blood-rising", slugs: ["blood-rising"], triggers: ["attack-roll"],
    check: (context, reactor) => bloodRising(context, reactor),
  });
  add({
    id: "blood-rising-save", slugs: ["blood-rising"], triggers: ["saving-throw"], scope: "self",
    check: (context, reactor) => bloodRising(context, reactor),
  });
  function bloodRising(context, reactor) {
      if (!core.isSpell(context)) return null;
      const caster = context.type === "attack-roll" ? attacker(context) : context.source.actor;
      if (!core.isEnemy(reactor.actor, caster)) return null;
      return `${name(caster)} направляет на вас заклинание. Подходит, если его традиция совпадает с вашей кровью.`;
  }

  // --- Attacks by you ------------------------------------------------------
  add({
    id: "perfect-clarity", slugs: ["perfect-clarity"], triggers: ["attack-roll", "saving-throw"], scope: "self",
    check(context, reactor) {
      if (!core.isFailure(context) || !core.hasEffect(reactor.actor, ["effect-rage"])) return null;
      if (context.type === "saving-throw" && core.statistic(context) !== "will") return null;
      return `${O[context.outcome]}: переброс с +2, затем ярость заканчивается.`;
    },
  });

  add({
    id: "tangle-of-battle", slugs: ["tangle-of-battle"], triggers: ["attack-roll"], scope: "self",
    check(context, reactor) {
      if (context.outcome !== "criticalSuccess" || !core.isEnemy(reactor.actor, context.target?.actor)) return null;
      if (!core.isAdjacent(reactor.token, context.target.token)) return null;
      return `Критическое попадание по соседнему врагу ${name(context.target.actor)}.`;
    },
  });

  add({
    id: "fast-swallow", slugs: ["fast-swallow"], triggers: ["attack-roll"], scope: "self",
    check(context) {
      const effects = context.item?.system?.attackEffects?.value ?? [];
      if (!core.isHit(context) || !effects.includes("improved-grab")) return null;
      return `${name(context.target?.actor)} схвачен: можно сразу проглотить.`;
    },
  });

  add({
    id: "opportune-backstab", slugs: ["opportune-backstab"], triggers: ["attack-roll"], scope: "others",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isHit(context) || !core.isMeleeAttack(context)) return null;
      if (!core.isAlly(reactor.actor, attacker(context)) || !core.isEnemy(reactor.actor, victim?.actor)) return null;
      if (!core.withinReach(reactor.token, victim.token)) return null;
      return `Союзник ${name(attacker(context))} попадает по ${name(victim.actor)} в вашей досягаемости.`;
    },
  });

  add({
    id: "avenging-bite", slugs: ["avenging-bite"], triggers: ["attack-roll"], scope: "others",
    check(context, reactor) {
      if (!core.isEnemy(reactor.actor, attacker(context)) || !core.isAlly(reactor.actor, context.target?.actor)) return null;
      if (!core.withinReach(reactor.token, context.origin.token)) return null;
      return `${name(attacker(context))} атакует союзника ${name(context.target.actor)} в вашей досягаемости.`;
    },
  });

  add({
    id: "fake-out", slugs: ["fake-out"], triggers: ["attack-roll"], scope: "others",
    check(context, reactor) {
      if (!core.isAlly(reactor.actor, attacker(context)) || !core.isEnemy(reactor.actor, context.target?.actor)) return null;
      const loaded = core.heldWeapons(reactor.actor).some((weapon) => ["firearm", "crossbow"].includes(weapon.group));
      if (!loaded) return null;
      const outcome = core.upgradedOutcome(context, 1);
      if (!outcome) return null;
      return `Помощь (+1) превратит ${L[context.outcome]} союзника ${name(attacker(context))} в ${L[outcome]}.`;
    },
  });

  add({
    id: "ring-bell", slugs: ["ring-bell"], triggers: ["attack-roll", "action"], scope: "any",
    check(context, reactor) {
      const enemy = attacker(context);
      if (!core.isExploitTarget(reactor.actor, enemy) || !core.within(reactor.token, context.origin.token, 30)) return null;
      if (context.type === "action" && !core.isSpell(context)) return null;
      if (context.type === "attack-roll") {
        const victim = context.target?.actor;
        if (victim !== reactor.actor && !core.isAlly(reactor.actor, victim)) return null;
      }
      return `Цель Exploit Vulnerability ${name(enemy)} ${context.type === "action" ? "творит заклинание" : "атакует"}.`;
    },
  });

  add({
    id: "everdistant-defense", slugs: ["everdistant-defense", "verdistant-defense"], triggers: ["attack-roll", "move"], scope: "any", activity,
    check(context, reactor) {
      const radius = core.auraRadius(reactor.actor);
      if (!(radius > 0)) return null;
      if (context.type === "move") {
        if (!core.isEnemy(reactor.actor, context.origin.actor)) return null;
        const inside = core.distanceToPoint(reactor.token, context.origin.token, context.from) <= radius
          || core.within(reactor.token, context.origin.token, radius);
        return inside ? `${name(context.origin.actor)} движется через вашу ауру.` : null;
      }
      const victim = context.target;
      if (!core.isRangedAttack(context) || !core.isEnemy(reactor.actor, attacker(context))) return null;
      if (victim?.actor !== reactor.actor && !core.within(reactor.token, victim?.token, radius)) return null;
      return `Дальнобойная атака по ${name(victim?.actor)} в вашей ауре.`;
    },
  });

  // --- Damage against you --------------------------------------------------
  function onDamage(id, slugs, text, when = () => true) {
    add({
      id, slugs, triggers: ["damage-roll"],
      check(context, reactor) {
        if (!when(context, reactor)) return null;
        return `${name(attacker(context))} наносит вам урон. ${typeof text === "function" ? text(context, reactor) : text}`;
      },
    });
  }

  add({
    id: "shield-block", slugs: ["shield-block"], triggers: ["damage-roll"],
    check(context, reactor) {
      if (!core.isAttack(context) || !core.hasPhysicalDamage(context) || !core.isShieldRaised(reactor.actor)) return null;
      const shield = core.usableShield(reactor.actor);
      return `${name(attacker(context))} наносит физический урон. Щит «${shield.name}»: твёрдость ${shield.hardness}, ОЗ ${shield.hitPoints.value}/${shield.hitPoints.max}.`;
    },
  });

  add({
    id: "shield-warden", slugs: ["shield-block"], triggers: ["damage-roll"], scope: "others",
    check(context, reactor) {
      const ally = context.target;
      if (!core.hasItem(reactor.actor, ["shield-warden", "shield-warden-fighter", "shield-warden-champion"])) return null;
      if (!core.isAlly(reactor.actor, ally?.actor) || !core.isAdjacent(reactor.token, ally.token)) return null;
      if (!core.isAttack(context) || !core.hasPhysicalDamage(context) || !core.isShieldRaised(reactor.actor)) return null;
      return `Страж щита: заблокируйте физический урон по союзнику ${name(ally.actor)}.`;
    },
  });

  // Champion reactions. Remaster ties the range to the champion's aura; legacy used 15 feet.
  const auraOf = (actor) => core.auraRadius(actor) || 15;
  add({
    id: "champion-ally", slugs: ["retributive-strike", "glimpse-of-redemption", "flash-of-grandeur", "liberating-step"],
    triggers: ["damage-roll"], scope: "others",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isAlly(reactor.actor, victim?.actor) || !core.isEnemy(reactor.actor, attacker(context))) return null;
      const radius = auraOf(reactor.actor);
      if (!core.within(reactor.token, victim.token, radius) || !core.within(reactor.token, context.origin.token, radius)) return null;
      return `${name(attacker(context))} наносит урон союзнику ${name(victim.actor)}; оба в вашей ауре.`;
    },
  });
  onDamage("champion-self", ["iron-command", "selfish-shield", "destructive-vengeance"], "Враг в вашей ауре.",
    (c, r) => core.isEnemy(r.actor, attacker(c)) && core.within(r.token, c.origin.token, auraOf(r.actor)));

  add({
    id: "amulets-abeyance", slugs: ["amulets-abeyance"], triggers: ["damage-roll"], scope: "any",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isExploitTarget(reactor.actor, attacker(context))) return null;
      if (victim?.actor !== reactor.actor && !(core.isAlly(reactor.actor, victim?.actor) && core.within(reactor.token, victim.token, 15))) return null;
      return `Цель Exploit Vulnerability ${name(attacker(context))} наносит урон ${name(victim.actor)}.`;
    },
  });

  add({
    id: "denier-of-destruction", slugs: ["denier-of-destruction"], triggers: ["damage-roll"], scope: "others",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isAlly(reactor.actor, victim?.actor) || !core.isEnemy(reactor.actor, attacker(context))) return null;
      if (!core.within(reactor.token, victim.token, 30)) return null;
      if (!(reactor.actor.itemTypes?.spell ?? []).some((spell) => spell.slug === "heal")) return null;
      return `Союзник ${name(victim.actor)} получает урон: сотворите на него heal.`;
    },
  });

  add({
    id: "intercept-attack", slugs: ["intercept-attack"], triggers: ["damage-roll"], scope: "others",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isAlly(reactor.actor, victim?.actor) || !core.hasPhysicalDamage(context)) return null;
      if (!core.within(reactor.token, victim.token, 10)) return null;
      return `Союзник ${name(victim.actor)} получает физический урон: шагните и примите его на себя.`;
    },
  });

  add({
    id: "resounding-finale", slugs: ["resounding-finale"], triggers: ["damage-roll"], scope: "any",
    check(context, reactor) {
      const victim = context.target;
      if (!core.hasDamageType(context, ["sonic"])) return null;
      if (victim?.actor !== reactor.actor && !core.isAlly(reactor.actor, victim?.actor)) return null;
      return `${name(victim?.actor)} получает звуковой урон. Подходит, если на нём действует ваша композиция.`;
    },
  });

  onDamage("all-in-my-head", ["all-in-my-head"], "Урон становится ментальным и несмертельным.",
    (c) => (core.isStrike(c) || core.isSpell(c)) && !core.hasTrait(c, "death"));
  onDamage("unexpected-shift", ["unexpected-shift"], "Телепортируйтесь и получите сопротивление.");
  onDamage("negate-damage", ["negate-damage"], "Снизьте урон.");
  onDamage("electric-counter", ["electric-counter"], "Электрический ответ.", (_c, r) => core.hasEffect(r.actor, ["stance-wild-winds-stance"]));
  onDamage("reverberate", ["reverberate"], "Звуковой урон: отразите его.", (c) => core.hasDamageType(c, ["sonic"]));
  onDamage("embrace-the-pain", ["embrace-the-pain"], "Атакующий в вашей досягаемости.",
    (c, r) => core.isMeleeAttack(c) && core.isAttack(c) && core.withinReach(r.token, c.origin.token));
  onDamage("retaliatory-cleansing", ["retaliatory-cleansing"], "Нужна святая вода или бомба с уроном жизненной силой в руке.",
    (c, r) => core.isStrike(c) && core.isAdjacent(r.token, c.origin.token));
  onDamage("reactive-gnaw", ["reactive-gnaw"], "Рубящий урон от соседнего врага.",
    (c, r) => core.hasDamageType(c, ["slashing"]) && core.isEnemy(r.actor, attacker(c)) && core.isAdjacent(r.token, c.origin.token));
  onDamage("sacrifice-armor", ["sacrifice-armor"], "Доспех примет урон на себя.", (c) => core.isStrike(c) && core.hasPhysicalDamage(c));
  onDamage("scars-of-steel", ["scars-of-steel"], "Критический физический урон: снизьте его.",
    (c) => c.outcome === "criticalSuccess" && core.hasPhysicalDamage(c) && core.isEnemy(c.target?.actor, attacker(c)));
  onDamage("reactive-transformation", ["reactive-transformation"], "Превращение под тип урона.",
    (c) => core.hasDamageType(c, ["acid", "cold", "electricity", "fire", "poison", "bludgeoning"]));
  onDamage("verdant-presence", ["verdant-presence"], "Зелень вокруг вас.");
  onDamage("wounded-rage", ["wounded-rage"], "Впадите в ярость.",
    (_c, r) => !core.hasEffect(r.actor, ["effect-rage"]) && !core.hasCondition(r.actor, "fatigued") && core.hasItem(r.actor, ["rage"]));

  add({
    id: "clever-gambit", slugs: ["clever-gambit"], triggers: ["damage-roll"], scope: "self",
    check(context) {
      if (context.outcome !== "criticalSuccess" || !core.isStrike(context)) return null;
      return `Критический Удар по ${name(context.target?.actor)}: Шаг или Перемещение без реакций цели, если вы опознали её Вспомнить знание.`;
    },
  });

  // --- Falling to 0 HP -----------------------------------------------------
  function onDowned(id, slugs, text, { allowDead = false } = {}) {
    add({
      id, slugs, triggers: ["damage-taken"], ignoreIncapacitation: true,
      check(context, reactor) {
        if (!core.droppedToZero(context, reactor.actor) || (!allowDead && core.isDead(reactor.actor))) return null;
        return `${name(reactor.actor)} опускается до 0 ОЗ. ${text}`;
      },
    });
  }

  onDowned("orc-ferocity", ["orc-ferocity"], "Останьтесь с 1 ОЗ и повысьте ранение на 1.");
  onDowned("ferocity", ["ferocity"], "Останьтесь с 1 ОЗ и повысьте ранение на 1.");
  onDowned("entitys-resurgence", ["entitys-resurgence"], "Сущность возвращает вас в бой.");
  onDowned("ruby-resurrection", ["ruby-resurrection"], "Рубиновое воскрешение.");
  onDowned("cheat-death", ["cheat-death"], "Обманите смерть.");
  onDowned("final-spite", ["final-spite"], "Последний удар.", { allowDead: true });

  for (const [id, range] of [["rapid-response", Infinity], ["no", 60]]) {
    add({
      id, slugs: [id], triggers: ["damage-taken"], scope: "others",
      check(context, reactor) {
        const ally = context.target;
        if (!core.isAlly(reactor.actor, ally?.actor) || !core.droppedToZero(context, ally.actor)) return null;
        if (range !== Infinity && !core.within(reactor.token, ally.token, range)) return null;
        return `Союзник ${name(ally.actor)} опускается до 0 ОЗ.`;
      },
    });
  }

  add({
    id: "youre-next", slugs: ["youre-next"], triggers: ["damage-taken"], scope: "self",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isEnemy(reactor.actor, victim?.actor) || !core.droppedToZero(context, victim.actor)) return null;
      return `Вы опустили ${name(victim.actor)} до 0 ОЗ: Запугивание против врага в 60 футах.`;
    },
  });

  add({
    id: "cleave", slugs: ["cleave"], triggers: ["damage-taken"], scope: "self",
    check(context, reactor) {
      const victim = context.target;
      if (!core.isEnemy(reactor.actor, victim?.actor) || !core.droppedToZero(context, victim.actor)) return null;
      if (context.source.item && context.source.item.isMelee === false) return null;
      const next = reactor.combatant.parent?.combatants?.find?.((other) =>
        other.actor && other.actor !== victim.actor && core.isEnemy(reactor.actor, other.actor)
        && Number(core.hp(other.actor)?.value) > 0 && core.isAdjacent(victim.token, other.token));
      if (!next) return null;
      return `${name(victim.actor)} повержен; рядом ${name(next.actor)} — Удар по нему.`;
    },
  });

  // --- Your saving throws --------------------------------------------------
  function onSave(id, slugs, check) {
    add({ id, slugs, triggers: ["saving-throw"], scope: "self", check });
  }

  onSave("schadenfreude", ["schadenfreude"], (context, reactor) =>
    context.outcome === "criticalFailure" && core.isEnemy(reactor.actor, context.source.actor)
      ? `Критический провал спасброска против эффекта ${name(context.source.actor)}.` : null);
  onSave("mental-static", ["mental-static"], (context) =>
    context.outcome === "criticalSuccess" && core.statistic(context) === "will" && core.hasTrait(context, "mental")
      ? "Критический успех Воли против ментального эффекта: отразите его." : null);
  onSave("premonition-of-clarity", ["premonition-of-clarity"], (context) =>
    core.isFailure(context) && core.hasTrait(context, "mental") ? "Провал против ментального эффекта: переброс с +2." : null);
  onSave("grit-and-tenacity", ["grit-and-tenacity"], (context) =>
    core.isFailure(context) && ["fortitude", "will"].includes(core.statistic(context)) ? `${O[context.outcome]} спасброска: переброс.` : null);
  onSave("emergency-targe-save", ["emergency-targe"], (context, reactor) =>
    core.isFailure(context) && core.isSpell(context) && core.isEnemy(reactor.actor, context.source.actor)
      ? "Провал против вражеского заклинания: бонус щита к спасброску." : null);
  onSave("impossible-technique-save", ["impossible-technique"], (context, reactor) =>
    core.isFailure(context) && core.isEnemy(reactor.actor, context.source.actor)
      && !core.hasCondition(reactor.actor, "fatigued") && (!reactor.actor.wornArmor || reactor.actor.wornArmor.category === "unarmored")
      ? "Провал против вражеской способности: переброс, берите лучший." : null);

  add({
    id: "convincing-illusion", slugs: ["convincing-illusion"], triggers: ["saving-throw", "perception-check"], scope: "others",
    check(context, reactor) {
      if (context.outcome !== "success" || context.source.actor !== reactor.actor || !core.hasTrait(context, "illusion")) return null;
      if (!core.within(reactor.token, context.origin.token, 30)) return null;
      return `${name(context.origin.actor)} распознаёт вашу иллюзию: Обман, чтобы убедить его.`;
    },
  });

  // --- Your checks ---------------------------------------------------------
  add({
    id: "spiritual-guides", slugs: ["spiritual-guides"], triggers: ["skill-check", "perception-check"], scope: "self",
    check: (context) => (context.outcome === "failure" ? "Провал проверки: духи подсказывают, переброс." : null),
  });
  add({
    id: "squawk", slugs: ["squawk"], triggers: ["skill-check"], scope: "self",
    check(context) {
      if (context.outcome !== "criticalFailure") return null;
      if (!["deception", "diplomacy", "intimidation"].some((skill) => context.domains.has(skill))) return null;
      if (context.target?.actor?.system?.traits?.value?.includes("tengu")) return null;
      return "Критический провал социальной проверки: обычный провал вместо него.";
    },
  });
  add({
    id: "sense-the-unseen", slugs: ["sense-the-unseen"], triggers: ["perception-check"], scope: "self",
    check: (context) => (core.isFailure(context) && context.options.has("action:seek") ? "Провал Поиска: незамеченные существа становятся скрытыми." : null),
  });

  // --- Spells and actions --------------------------------------------------
  function onAction(id, slugs, scope, check) {
    add({ id, slugs, triggers: ["action"], scope, check });
  }

  const casterTradition = (context) => context.message?.flags?.pf2e?.casting?.tradition ?? context.item?.system?.traits?.traditions?.[0] ?? null;

  onAction("banshee-cry", ["banshee-cry"], "others", (context, reactor) => {
    if (!core.within(reactor.token, context.origin.token, 30)) return null;
    if (core.isSpell(context)) return `${name(context.origin.actor)} творит заклинание в 30 футах.`;
    if (context.item?.isOfType?.("equipment", "weapon", "armor", "consumable") && context.traits.has("concentrate")) return `${name(context.origin.actor)} активирует предмет.`;
    return null;
  });
  onAction("counter-thought", ["counter-thought"], "others", (context, reactor) =>
    core.isSpell(context) && core.hasTrait(context, "mental") && core.isEnemy(reactor.actor, context.origin.actor)
      ? `${name(context.origin.actor)} творит ментальное заклинание.` : null);
  onAction("mage-hunter", ["mage-hunter"], "others", (context, reactor) =>
    core.isSpell(context) && core.isEnemy(reactor.actor, context.origin.actor) && core.withinReach(reactor.token, context.origin.token)
      ? `${name(context.origin.actor)} творит заклинание в вашей досягаемости.` : null);
  onAction("accompany", ["accompany"], "others", (context, reactor) =>
    core.isSpell(context) && core.isAlly(reactor.actor, context.origin.actor) && core.within(reactor.token, context.origin.token, 30)
      ? `Союзник ${name(context.origin.actor)} творит заклинание.` : null);
  onAction("spell-relay", ["spell-relay"], "others", (context, reactor) => {
    if (!core.isSpell(context) || !core.isAlly(reactor.actor, context.origin.actor)) return null;
    const text = String(context.item?.system?.range?.value ?? "");
    const range = /touch/i.test(text) ? 5 : parseInt(text, 10);
    if (Number.isFinite(range) && !core.within(reactor.token, context.origin.token, range)) return null;
    return `Союзник ${name(context.origin.actor)} творит заклинание, вы в его дистанции.`;
  });
  onAction("distracting-explosion", ["distracting-explosion"], "others", (context, reactor) =>
    context.traits.has("concentrate") && core.isEnemy(reactor.actor, context.origin.actor) && core.withinReach(reactor.token, context.origin.token)
      ? `${name(context.origin.actor)} использует действие концентрации в вашей досягаемости.` : null);
  onAction("align-qi", ["align-qi", "align-ki"], "self", (context) =>
    core.isSpell(context) && core.hasTrait(context, "monk") ? "Вы творите заклинание монаха." : null);
  onAction("verdant-presence-cast", ["verdant-presence"], "self", (context) =>
    core.isSpell(context) && casterTradition(context) === "primal" ? "Вы творите природное заклинание." : null);

  // --- Movement and actions in reach ---------------------------------------
  // `on`: which events trigger it — move (leaving a square in reach), actions
  // with the listed traits, and ranged attacks.
  function inReach(id, slugs, { traits = [], move = false, ranged = false, when = () => true, reach = (r, e) => core.withinReach(r.token, e.token) }) {
    add({
      // "any": a ranged attack provokes even when it targets the reactor itself.
      activity,
      id, slugs, triggers: [move && "move", traits.length && "action", ranged && "attack-roll"].filter(Boolean), scope: "any",
      check(context, reactor) {
        const enemy = context.origin;
        if (!enemy?.actor || !core.isEnemy(reactor.actor, enemy.actor) || !when(context, reactor)) return null;
        if (context.type === "move") {
          return core.withinReachOfPoint(reactor.token, enemy.token, context.from) ? `${name(enemy.actor)} покидает клетку в зоне досягаемости.` : null;
        }
        if (!reach(reactor, enemy)) return null;
        if (context.type === "attack-roll") {
          return core.isRangedAttack(context) ? `${name(enemy.actor)} совершает дальнобойную атаку в зоне досягаемости.` : null;
        }
        const trait = traits.find((entry) => context.traits.has(entry));
        if (!trait) return null;
        const labels = { manipulate: "манипуляции", move: "перемещения", concentrate: "концентрации", auditory: "со звуковым эффектом" };
        return `${name(enemy.actor)} использует действие ${labels[trait] ?? trait}${context.item ? ` («${context.item.name}»)` : ""}.`;
      },
    });
  }

  inReach("reactive-strike", ["reactive-strike", "attack-of-opportunity"], { traits: ["manipulate", "move"], move: true, ranged: true });
  inReach("reflexive-courage", ["reflexive-courage"], { traits: ["auditory", "manipulate", "move"], move: true, ranged: true,
    when: (_c, r) => core.hasEffect(r.actor, ["spell-effect-courageous-anthem"]) });
  inReach("courageous-opportunity", ["courageous-opportunity"], { traits: ["auditory", "manipulate", "move"], move: true, ranged: true,
    when: (_c, r) => core.hasEffect(r.actor, ["spell-effect-inspire-courage", "spell-effect-courageous-anthem"]) });
  inReach("stand-still", ["stand-still"], { traits: ["move"], move: true });
  inReach("no-escape", ["no-escape"], { move: true });
  inReach("shoving-sweep", ["shoving-sweep"], { move: true, when: (_c, r) => core.heldWeapons(r.actor).some((weapon) => Number(weapon.handsHeld) >= 2) });
  inReach("implements-interruption", ["implements-interruption"], {
    traits: ["concentrate", "manipulate", "move"], move: true,
    when: (context, reactor) => core.isExploitTarget(reactor.actor, context.origin.actor),
    reach: (reactor, enemy) => core.withinReach(reactor.token, enemy.token) || core.within(reactor.token, enemy.token, 10),
  });

  feature.catalog = catalog;
})();
