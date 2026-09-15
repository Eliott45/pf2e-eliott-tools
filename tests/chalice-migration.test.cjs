const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");
const vm = require("node:vm");
const code = readFileSync(join(__dirname, "../scripts/features/chalice.js"), "utf8");
const command = readFileSync(join(__dirname, "../scripts/macros/drink-from-chalice.js"), "utf8").trim();

function setup({ locked = true, failUpdate = false, isGM = true } = {}) {
  const updates = [], locks = [];
  const macro = { command: "old pack command", async update(data) {
    assert.equal(pack.locked, false);
    if (failUpdate) throw new Error("write failed");
    this.command = data.command;
    updates.push("pack");
  } };
  const pack = { locked, async getDocument(id) { assert.equal(id, "ChaliceDrink0001"); return macro; },
    async configure({ locked }) { this.locked = locked; locks.push(locked); } };
  const world = (value) => ({ type: "script", command: value,
    async update(data) { this.command = data.command; updates.push("world"); } });
  const original = world("chaliceLocks original"), custom = world("chaliceLocks edited by user");
  const context = vm.createContext({
    pf2eEliottTools: { module: { id: "pf2e-eliott-tools" } },
    game: { user: { id: "gm", isGM }, users: { activeGM: { id: "gm" } },
      packs: new Map([["pf2e-eliott-tools.thaumaturge-macros", pack]]), macros: { contents: [original, custom] } },
    foundry: { utils: { getRoute: (path) => path } },
    fetch: async () => ({ ok: true, text: async () => command }),
    TextEncoder, crypto: webcrypto,
  });
  vm.runInContext(code, context);
  return { context, pack, macro, original, custom, updates, locks,
    run: () => context.pf2eEliottTools.features.chalice.updateMacros() };
}

test("pack update restores its lock, preserves custom world macros, and is idempotent", async () => {
  const env = setup();
  await env.run();
  await env.run();
  assert.equal(env.macro.command, command);
  assert.equal(env.pack.locked, true);
  assert.deepEqual(env.locks, [false, true]);
  assert.deepEqual(env.updates, ["pack"]);
  assert.equal(env.custom.command, "chaliceLocks edited by user");
});

test("only a world macro with the known legacy digest is updated in place", async () => {
  const env = setup();
  // Isolate migration selection from hashing; production uses the native SHA-256 implementation.
  env.context.crypto = { subtle: { digest: async (algorithm, bytes) => {
    const source = new TextDecoder().decode(bytes);
    if (source === env.original.command) {
      return Uint8Array.from(Buffer.from("619bb9b989ce4ee0bea1490e3ce7dcf7bb1ff2d5982183a3666d8a2d40a3c527", "hex")).buffer;
    }
    return webcrypto.subtle.digest(algorithm, bytes);
  } } };
  await env.run();
  assert.equal(env.original.command, command);
  assert.equal(env.custom.command, "chaliceLocks edited by user");
  assert.deepEqual(env.updates, ["pack", "world"]);
});

test("failed compendium writes restore the lock", async () => {
  const env = setup({ failUpdate: true });
  await assert.rejects(env.run(), /write failed/);
  assert.equal(env.pack.locked, true);
  assert.deepEqual(env.locks, [false, true]);
});

test("unlocked packs remain unlocked and HTTP clients without WebCrypto still update the pack", async () => {
  const env = setup({ locked: false });
  env.context.crypto = undefined;
  await env.run();
  assert.equal(env.macro.command, command);
  assert.equal(env.pack.locked, false);
  assert.deepEqual(env.locks, []);
  assert.deepEqual(env.updates, ["pack"]);
});

test("players and secondary GMs never migrate macros", async () => {
  for (const isGM of [false, true]) {
    const env = setup({ isGM });
    if (isGM) env.context.game.user.id = "secondary";
    await env.run();
    assert.deepEqual(env.updates, []);
  }
});
