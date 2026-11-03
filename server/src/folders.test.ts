import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Organizer } from "./organizer.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const cat = "u" + "d".repeat(32);
const team = "c" + "c".repeat(32);
const work = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const family = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const gym = "11111111-2222-4333-8444-555555555555";
const path = () => join(mkdtempSync(join(tmpdir(), "line-folders-")), "organizer.json");
const layout = (o: Organizer) => o.state().folders.map((f) => [f.name, f.chat_ids]);

test("agent folder changes apply in order and are kept across restarts", () => {
	const file = path();
	const o = new Organizer(file);
	o.replace({ folders: [{ id: work, name: "Work", chat_ids: [amy] }], hidden: [] });
	o.changeFolders([
		{ op: "create", folder_id: family, name: "家人" },
		{ op: "move", chat_ids: [amy, bob], folder_id: family },
		{ op: "position", folder_id: family, index: 0 },
		{ op: "rename", folder_id: work, name: "工作" },
		{ op: "hide", chats: [{ chat_id: cat, name: "Cat" }] },
	]);
	assert.deepEqual(layout(o), [["家人", [amy, bob]], ["工作", []]]);
	assert.equal(o.isHidden(cat), true);
	o.changeFolders([{ op: "move", chat_ids: [bob], folder_id: null }, { op: "delete", folder_id: work }]);
	assert.deepEqual(layout(o), [["家人", [amy]]]);

	const reloaded = new Organizer(file);
	assert.deepEqual(layout(reloaded), [["家人", [amy]]]);
	assert.equal(reloaded.isHidden(cat), true);
	assert.equal("folder_ops" in reloaded.state(), false, "clients never see the log");
	assert.equal(JSON.parse(readFileSync(file, "utf-8")).folder_ops.length, 7);
});

test("a save from a Mac that had not seen an agent's change keeps that change", () => {
	const o = new Organizer(path());
	const synced = o.replace({ folders: [{ id: work, name: "Work", chat_ids: [amy] }], hidden: [] });
	// An agent files bob and team while the Mac is offline …
	o.changeFolders([{ op: "move", chat_ids: [bob], folder_id: work }]);
	o.changeFolders([
		{ op: "create", folder_id: family, name: "家人" },
		{ op: "move", chat_ids: [team], folder_id: family },
		{ op: "hide", chats: [{ chat_id: cat, name: "Cat" }] },
	]);
	// … where the owner renamed Work and moved amy out of it.
	const saved = o.replace({ folders: [{ id: work, name: "Office", chat_ids: [] }], hidden: [] }, synced.rev);
	assert.deepEqual(saved.folders.map((f) => [f.name, f.chat_ids]), [["Office", [bob]], ["家人", [team]]]);
	assert.deepEqual(saved.hidden, [{ chat_id: cat, name: "Cat" }]);

	// A Mac that has seen everything saves as it is: the owner's undo sticks.
	const undone = o.replace({ folders: [{ id: work, name: "Office", chat_ids: [] }], hidden: [] }, saved.rev);
	assert.deepEqual(undone.folders.map((f) => [f.name, f.chat_ids]), [["Office", []]]);
	assert.deepEqual(undone.hidden, []);

	// An older Mac, with no base revision, still overwrites everything.
	o.changeFolders([{ op: "move", chat_ids: [amy], folder_id: work }]);
	assert.deepEqual(o.replace({ folders: [], hidden: [] }).folders, []);
});

test("replayed changes to a folder a Mac deleted do nothing, and same-named folders merge", () => {
	const o = new Organizer(path());
	const base = o.replace({ folders: [{ id: work, name: "Work", chat_ids: [] }], hidden: [] }).rev;
	o.changeFolders([{ op: "move", chat_ids: [amy], folder_id: work }]);
	o.changeFolders([{ op: "create", folder_id: gym, name: "gym" }, { op: "move", chat_ids: [bob], folder_id: gym }]);
	o.changeFolders([{ op: "rename", folder_id: work, name: "Job" }]);
	// The Mac deleted Work and made its own "Gym" meanwhile.
	const saved = o.replace({ folders: [{ id: family, name: "Gym", chat_ids: [cat] }], hidden: [] }, base);
	assert.deepEqual(saved.folders.map((f) => [f.id, f.name, f.chat_ids]), [[family, "Gym", [cat, bob]]]);
	assert.equal(o.folderOf(amy), undefined);
});
