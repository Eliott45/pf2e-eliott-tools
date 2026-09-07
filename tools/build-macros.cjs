// node tools/build-macros.cjs <path-to-classic-level>
// Build only the new macro pack. Do not run while Foundry has this pack open.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const { ClassicLevel } = require(process.argv[2] || "classic-level");
const id = "ChaliceDrink0001";
const macro = {
  _id: id,
  name: "Тауматург — Выпить из чаши",
  type: "script",
  author: null,
  img: "systems/pf2e/icons/features/classes/chalice.webp",
  scope: "global",
  command: fs.readFileSync(path.join(root, "scripts/macros/drink-from-chalice.js"), "utf8"),
  folder: null, sort: 0, ownership: { default: 2 }, flags: {},
};
assert.match(id, /^[A-Za-z0-9]{16}$/);
new vm.Script(`(async () => {${macro.command}\n})`);
(async () => {
  const db = new ClassicLevel(path.join(root, "packs/thaumaturge-macros"), { valueEncoding: "json" });
  try {
    await db.open();
    await db.put(`!macros!${id}`, macro);
    await db.compactRange("", "\uffff");
    assert.deepEqual(await db.get(`!macros!${id}`), macro);
    console.log(`Verified macro: ${macro.name} (${macro.command.length} characters)`);
  } finally {
    await db.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
