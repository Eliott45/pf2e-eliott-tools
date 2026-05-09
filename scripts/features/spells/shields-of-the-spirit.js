(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix } = tools.module;

  const featureFlagPath = `flags.${moduleId}.shieldsOfTheSpirit`;
  const spellName = "Shields of the Spirit";
  const spellSlug = "shields-of-the-spirit";
  const spellPackId = "pf2e.spells-srd";
  const damageType = "spirit";
  const fallbackSpellRank = 1;
  const attackActionSlugs = new Set([
    "strike",
    "disarm",
    "escape",
    "grapple",
    "reposition",
    "shove",
    "trip",
  ]);

  tools.features ??= {};
  tools.features.spells ??= {};
  tools.features.spells.shieldsOfTheSpirit = {
    onCreateChatMessage,
  };

  async function onCreateChatMessage(message) {
    if (!isResponsibleUser()) return;

    try {
      await maybeRollRetaliationDamage(message);
    } catch (error) {
      console.error(`${logPrefix} | Shields of the Spirit automation failed`, error);
    }
  }

  async function maybeRollRetaliationDamage(message) {
    if (foundry.utils.getProperty(message, featureFlagPath)?.triggeredBy) return;

    const context = message.flags?.pf2e?.context;
    if (!context || context.type === "damage-roll") return;
    if (!isAttackAction(context)) return;

    const attacker = await getActorFromUuid(context.origin?.actor) ?? message.actor ?? null;
    const target = await getActorFromUuid(context.target?.actor);
    if (!attacker || !target || attacker.uuid === target.uuid) return;

    const effect = getShieldsOfTheSpiritEffect(target);
    if (!effect) return;

    const caster = await getEffectOriginActor(effect);
    const spellRank = await getSpellRank(effect, caster);
    const diceNumber = getDamageDiceNumber(spellRank);
    const formula = `{${diceNumber}d4[${damageType}]}`;
    const roll = await createDamageRoll(formula);
    const rollMode = context.rollMode ?? message.rollMode ?? "roll";

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: target }),
      flavor: await buildFlavor({ attacker, target, caster, spellRank, diceNumber }),
      flags: {
        [moduleId]: {
          shieldsOfTheSpirit: {
            triggeredBy: message.uuid,
            attacker: attacker.uuid,
            target: target.uuid,
            effect: effect.uuid,
            spellRank,
            diceNumber,
            damageType,
          },
        },
        pf2e: {
          context: {
            type: "damage-roll",
            sourceType: "spell",
            actor: target.id,
            target: { actor: attacker.uuid },
            options: ["damage:type:spirit", "origin:spell:shields-of-the-spirit"],
            traits: ["magical", "spirit"],
            title: spellName,
          },
        },
      },
    }, { rollMode });
  }

  function isResponsibleUser() {
    if (!game.user?.active) return false;

    const activeGMs = game.users
      .filter((user) => user.active && user.isGM)
      .sort((a, b) => a.id.localeCompare(b.id));

    return activeGMs.length > 0
      ? game.user.id === activeGMs[0].id
      : game.user.isGM;
  }

  function isAttackAction(context) {
    const traits = new Set(context.traits ?? []);
    if (traits.has("attack")) return true;

    const options = new Set(context.options ?? []);
    if ([...options].some((option) => /(^|:)trait:attack$/.test(option))) return true;

    return [...options].some((option) => {
      const actionSlug = /^self:action:slug:(.+)$/.exec(option)?.[1]
        ?? /^origin:action:slug:(.+)$/.exec(option)?.[1]
        ?? null;
      return actionSlug ? attackActionSlugs.has(actionSlug) : false;
    });
  }

  async function getActorFromUuid(uuid) {
    if (!uuid) return null;

    const document = await fromUuid(uuid);
    return document?.actor ?? document ?? null;
  }

  function getShieldsOfTheSpiritEffect(actor) {
    const effects = actor.itemTypes?.effect ?? actor.items.filter((item) => item.type === "effect");
    return effects.find(isShieldsOfTheSpiritEffect) ?? null;
  }

  function isShieldsOfTheSpiritEffect(effect) {
    if (effect.disabled || effect.isExpired) return false;

    const slug = normalizeSlug(effect.slug ?? effect.system?.slug ?? "");
    if (slug.includes(spellSlug)) return true;

    const sourceId = normalizeSlug(effect.flags?.core?.sourceId ?? effect._stats?.compendiumSource ?? "");
    if (sourceId.includes(spellSlug)) return true;

    const name = normalizeSlug(effect.name);
    return name === spellSlug
      || name === `spell-effect-${spellSlug}`
      || name.endsWith(`-${spellSlug}`);
  }

  async function getSpellRank(effect, originActor = null) {
    const explicitRank = getFirstPositiveInteger([
      effect.flags?.pf2e?.spellRank,
      effect.flags?.pf2e?.castRank,
      effect.flags?.pf2e?.context?.rank,
      effect.flags?.pf2e?.context?.castRank,
      effect.flags?.pf2e?.origin?.rank,
      effect.system?.rank?.value,
      effect.system?.level?.value,
      effect.system?.context?.rank,
      effect.system?.context?.castRank,
      effect.system?.context?.origin?.rank,
      effect.system?.badge?.value,
    ]);
    if (explicitRank) return clampSpellRank(explicitRank);

    const originLevel = Number(originActor?.system?.details?.level?.value);
    if (originLevel > 0) return clampSpellRank(Math.ceil(originLevel / 2));

    return fallbackSpellRank;
  }

  async function getEffectOriginActor(effect) {
    const originUuid = [
      effect.origin,
      effect.flags?.pf2e?.origin?.actor,
      effect.flags?.pf2e?.context?.origin?.actor,
      effect.system?.context?.origin?.actor,
      effect.system?.context?.origin?.uuid,
    ].find((value) => typeof value === "string" && value);

    if (!originUuid) return null;

    const origin = await fromUuid(originUuid);
    return origin?.actor ?? origin ?? null;
  }

  function getFirstPositiveInteger(values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isInteger(number) && number > 0) return number;
    }

    return null;
  }

  function clampSpellRank(rank) {
    return Math.max(1, Math.min(10, Number(rank) || fallbackSpellRank));
  }

  function getDamageDiceNumber(spellRank) {
    return Math.max(1, Math.ceil(clampSpellRank(spellRank) / 2));
  }

  async function createDamageRoll(formula) {
    const DamageRoll = CONFIG.Dice.rolls.find((rollClass) => rollClass.name === "DamageRoll") ?? Roll;
    const rollFormula = DamageRoll === Roll
      ? /^\{([^[]+)/.exec(formula)?.[1] ?? formula.replace(/\[(\w+)\]/g, "")
      : formula;
    return new DamageRoll(rollFormula).evaluate();
  }

  async function buildFlavor({ attacker, target, caster, spellRank, diceNumber }) {
    const section = document.createElement("section");
    section.classList.add("pf2e-eliott-tools", "shields-of-the-spirit");

    const title = document.createElement("h4");
    title.textContent = `${spellName}: ответный урон`;

    const reason = document.createElement("p");
    reason.innerHTML = `Сработал эффект ${await buildSpellLink()}: ${escapeHtml(attacker.name)} совершает действие с признаком <strong>attack</strong> против ${escapeHtml(target.name)}.`;

    const casterText = document.createElement("p");
    casterText.innerHTML = caster
      ? `Кастер щитов: <strong>${escapeHtml(caster.name)}</strong>.`
      : "Кастер щитов не определен.";

    const text = document.createElement("p");
    text.innerHTML = `${escapeHtml(attacker.name)} получает <strong>${diceNumber}d4 spirit-урона</strong>.`;

    const rank = document.createElement("p");
    rank.classList.add("notes");
    rank.textContent = `Урон рассчитан от ранга заклинания: ${spellRank}.`;

    section.append(title, reason, casterText, text, rank);
    return section.outerHTML;
  }

  async function buildSpellLink() {
    const uuid = await getSpellUuid();
    return `<a class="content-link" data-link data-uuid="${uuid}" data-type="Item"><i class="fas fa-suitcase"></i>${spellName}</a>`;
  }

  async function getSpellUuid() {
    if (spellUuidCache) return spellUuidCache;

    const pack = game.packs.get(spellPackId);
    const index = await pack?.getIndex({ fields: ["name", "system.slug"] });
    const entry = index?.find((document) => normalizeSlug(document.system?.slug ?? document.name) === spellSlug);

    spellUuidCache = entry?.uuid ?? `Compendium.${spellPackId}.Item.${spellSlug}`;
    return spellUuidCache;
  }

  function normalizeSlug(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = String(value ?? "");
    return element.innerHTML;
  }
})();
  let spellUuidCache = null;
