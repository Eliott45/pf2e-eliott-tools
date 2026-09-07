// node tools/build-macros.cjs <path-to-classic-level> [workspace-relative-output]
// Use a staging directory while Foundry has the installed pack open.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const { ClassicLevel } = require(process.argv[2] || "classic-level");
const macros = [
  { id: "ChaliceDrink0001", name: "Тауматург — Выпить из чаши", icon: "chalice", file: "drink-from-chalice.js" },
  { id: "RegaliaBoost0001", name: "Тауматург — Регалия: усиление уязвимости", icon: "regalia", file: "intensify-regalia.js" },
].map(({ id, name, icon, file }) => ({
  _id: id,
  name,
  type: "script",
  author: null,
  img: `systems/pf2e/icons/features/classes/${icon}.webp`,
  scope: "global",
  command: fs.readFileSync(path.join(root, "scripts/macros", file), "utf8").trim(),
  folder: null, sort: 0, ownership: { default: 2 }, flags: {},
}));
for (const macro of macros) {
  assert.match(macro._id, /^[A-Za-z0-9]{16}$/);
  new vm.Script(`(async () => {${macro.command}\n})`);
}
const output = path.resolve(root, process.argv[3] || "packs/thaumaturge-macros");
assert.ok(output.startsWith(root + path.sep), "Output must stay in the workspace");
(async () => {
  const db = new ClassicLevel(output, { valueEncoding: "json" });
  try {
    await db.open();
    for (const macro of macros) await db.put(`!macros!${macro._id}`, macro);
    await db.compactRange("", "\uffff");
    for (const macro of macros) {
      assert.deepEqual(await db.get(`!macros!${macro._id}`), macro);
      console.log(`Verified macro: ${macro.name} (${macro.command.length} characters)`);
    }
  } finally {
    await db.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
