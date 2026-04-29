(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix } = tools.module;

  const packName = "hero-action-deck";
  const packId = `${moduleId}.${packName}`;
  const sourcePackId = "pf2e.journals";
  const sourceJournalId = "BSp4LUSaOmUyjBko";
  const deckFlagPath = `flags.${moduleId}.heroActionDeck`;
  const imageBase = `modules/${moduleId}/assets/hero-decks/hero-deck-ru`;
  const backImage = `${imageBase}/00_back.png`;
  const syncVersion = 1;
  const cardCount = 52;

  tools.features ??= {};
  tools.features.heroActionDeck = {
    onReady,
    syncCompendium,
  };

  async function onReady() {
    if (!game.user?.isGM) return;

    try {
      await syncCompendium();
    } catch (error) {
      console.error(`${logPrefix} | hero action deck sync failed`, error);
      ui.notifications?.error?.(`${logPrefix}: Hero Action Deck sync failed. See console for details.`);
    }
  }

  async function syncCompendium() {
    const pack = game.packs.get(packId);
    if (!pack) {
      console.warn(`${logPrefix} | hero action deck pack not found`, packId);
      return;
    }

    const sourcePages = await getHeroPointDeckPages();
    if (!sourcePages) return;

    const wasLocked = pack.locked;

    if (wasLocked) {
      await pack.configure({ locked: false });
    }

    try {
      const deck = await getOrCreateDeck(pack);
      await syncDeckDocument(deck, sourcePages);
    } finally {
      if (wasLocked) {
        await pack.configure({ locked: true });
      }
    }
  }

  async function getHeroPointDeckPages() {
    const sourcePack = game.packs.get(sourcePackId);
    if (!sourcePack) {
      console.warn(`${logPrefix} | PF2e journals pack not found`, sourcePackId);
      return null;
    }

    const journal = await sourcePack.getDocument(sourceJournalId)
      ?? await findHeroPointDeckJournal(sourcePack);
    const pages = Array.from(journal?.pages ?? []);

    if (pages.length === 0) {
      console.warn(`${logPrefix} | Hero Point Deck journal has no pages`);
      return null;
    }

    return pages.filter((page) => normalizeName(page.name) !== "rules");
  }

  async function findHeroPointDeckJournal(sourcePack) {
    const index = await sourcePack.getIndex({ fields: ["name"] });
    const entry = index.find((document) => normalizeName(document.name) === "heropointdeck");
    return entry ? sourcePack.getDocument(entry._id) : null;
  }

  async function getOrCreateDeck(pack) {
    const index = await pack.getIndex({ fields: ["name", deckFlagPath] });
    const entry = index.find((document) => foundry.utils.getProperty(document, deckFlagPath)?.deck)
      ?? index.find((document) => document.name === "Hero Action Deck");

    if (entry) {
      return pack.getDocument(entry._id);
    }

    return Cards.create(
      {
        name: "Hero Action Deck",
        type: "deck",
        description: "",
        img: backImage,
        system: {},
        cards: [],
        flags: {
          [moduleId]: {
            heroActionDeck: {
              deck: true,
              syncVersion,
              source: `Compendium.${sourcePackId}.JournalEntry.${sourceJournalId}`,
            },
          },
        },
      },
      { pack: packId }
    );
  }

  async function syncDeckDocument(deck, sourcePages) {
    const cardSources = sourcePages
      .slice(0, cardCount)
      .map((page, index) => ({
        number: String(index + 1).padStart(2, "0"),
        page,
        sort: index,
      }));
    const existingCards = new Map(
      deck.cards.map((card) => [foundry.utils.getProperty(card, deckFlagPath)?.number, card])
    );
    const expectedNumbers = new Set(cardSources.map((card) => card.number));

    await deck.update({
      name: "Hero Action Deck",
      img: backImage,
      [deckFlagPath]: {
        deck: true,
        syncVersion,
        source: `Compendium.${sourcePackId}.JournalEntry.${sourceJournalId}`,
      },
    });

    const toCreate = [];
    const updates = [];

    for (const cardSource of cardSources) {
      const data = buildCardData(cardSource);
      const existing = existingCards.get(cardSource.number);

      if (existing) {
        updates.push({ _id: existing.id, ...data });
      } else {
        toCreate.push(data);
      }
    }

    if (toCreate.length > 0) {
      await deck.createEmbeddedDocuments("Card", toCreate);
    }

    if (updates.length > 0) {
      await deck.updateEmbeddedDocuments("Card", updates);
    }

    const staleCards = deck.cards
      .filter((card) => {
        const flag = foundry.utils.getProperty(card, deckFlagPath);
        return flag && !expectedNumbers.has(flag.number);
      })
      .map((card) => card.id);

    if (staleCards.length > 0) {
      await deck.deleteEmbeddedDocuments("Card", staleCards);
    }

    if (sourcePages.length !== cardCount) {
      console.warn(`${logPrefix} | unexpected Hero Point Deck page count`, {
        expected: cardCount,
        actual: sourcePages.length,
      });
    }

    console.info(`${logPrefix} | hero action deck synchronized`, {
      pack: packId,
      cards: cardSources.length,
    });
  }

  function buildCardData(cardSource) {
    const page = cardSource.page;
    const sourceUuid = page
      ? `Compendium.${sourcePackId}.JournalEntry.${sourceJournalId}.JournalEntryPage.${page.id}`
      : null;
    const name = page?.name ?? `Hero Action ${cardSource.number}`;
    const text = page?.text?.content ?? "";

    return {
      name,
      type: "base",
      description: "",
      faces: [
        {
          name,
          text,
          img: `${imageBase}/${getImageFileName(cardSource.number)}`,
        },
      ],
      face: 0,
      back: {
        name: "Back",
        text: "",
        img: backImage,
      },
      drawn: false,
      origin: null,
      rotation: 0,
      sort: cardSource.sort * 100000,
      system: {},
      suit: "",
      value: null,
      flags: {
        [moduleId]: {
          heroActionDeck: {
            number: cardSource.number,
            sourceUuid,
            syncVersion,
          },
        },
      },
    };
  }

  function getImageFileName(number) {
    const numericNumber = Number(number);
    const existingUnpaddedNumbers = new Set([4, 5, 6, 7, 8, 9]);

    return existingUnpaddedNumbers.has(numericNumber)
      ? `${numericNumber}.png`
      : `${number}.png`;
  }

  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/&amp;/g, "and")
      .replace(/[^a-z0-9]+/g, "");
  }
})();
