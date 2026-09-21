import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { MemoryIndexedDB } from "./support/memoryIndexedDB.mjs";

// Compile with the project's existing compiler so these tests require no extra dependencies.
async function moduleUrl(path, replacements = {}) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replace(from, to);
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const mediaStoreUrl = await moduleUrl("../src/services/mediaStore.ts");
const draftsModuleUrl = await moduleUrl("../src/services/closingDrafts.ts", {
  '"./mediaStore"': JSON.stringify(mediaStoreUrl),
});
const drafts = await import(draftsModuleUrl);
const { getClosingDraftKey, mergeMediaAnswers, mergeClosingAnswers, createClosingDraftSnapshot,
  prepareClosingAnswersForStorage, readBackendClosingAnswers, readClosingDraft, writeClosingDraft,
  removeClosingDraft } = drafts;

const mediaA = JSON.stringify({ id: "a", name: "foto.jpg", type: "image/jpeg", size: 120, createdAt: "2026-09-21" });
const mediaB = JSON.stringify({ id: "b", name: "foto.jpg", type: "image/jpeg", size: 130, createdAt: "2026-09-21" });
const questions = [
  { id: "photos", apiQuestionId: 1, step: "media", label: "Fotos", required: false },
  { id: "text", apiQuestionId: 2, step: "textarea", label: "Observações", required: false },
  { id: "check", apiQuestionId: 3, step: "checkbox", label: "Opções", required: false },
  { id: "radio", apiQuestionId: 4, step: "radio", label: "Escolha", required: false },
  { id: "date", apiQuestionId: 5, step: "date", label: "Data", required: false },
];

test("draft keys isolate user, OS, equipment and questionnaire, including equipment-less orders", () => {
  const scope = { userId: "u", orderId: "229", equipmentOrderId: "8", questionnaireId: "q" };
  const keys = [scope, { ...scope, userId: "u2" }, { ...scope, orderId: "230" },
    { ...scope, equipmentOrderId: "9" }, { ...scope, equipmentOrderId: undefined },
    { ...scope, questionnaireId: "q2" }].map(getClosingDraftKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(getClosingDraftKey({ userId: "u/a", orderId: "b" }), getClosingDraftKey({ userId: "u", orderId: "a/b" }));
});

test("appending and repeatedly hydrating keeps A + B without duplicates or deduping equal filenames", () => {
  const appended = mergeMediaAnswers([mediaA], [mediaB, mediaA]);
  assert.deepEqual(appended.map((entry) => JSON.parse(entry).id), ["a", "b"]);
  assert.deepEqual(mergeMediaAnswers(appended, [mediaA, mediaB], appended), appended);
});

test("remote media deduplicates by a shared URL even when one response omits its ID", () => {
  const first = JSON.stringify({ url: "https://example.test/a.jpg", name: "a.jpg" });
  const refreshed = JSON.stringify({ id: 37, url: "https://example.test/a.jpg", type: "image/jpeg" });
  const merged = mergeMediaAnswers([first], [refreshed]);
  assert.equal(merged.length, 1);
  assert.deepEqual(JSON.parse(merged[0]), { id: 37, url: "https://example.test/a.jpg", name: "a.jpg", type: "image/jpeg" });
});

test("a remote ID and URL discovered separately are joined by a later complete record", () => {
  const idOnly = JSON.stringify({ id: 37, source: "remote", name: "a.jpg" });
  const urlOnly = JSON.stringify({ url: "https://example.test/a.jpg" });
  const complete = JSON.stringify({ id: 37, source: "remote", url: "https://example.test/a.jpg", type: "image/jpeg" });
  const merged = mergeMediaAnswers([idOnly, urlOnly], [complete, idOnly, urlOnly]);
  assert.equal(merged.length, 1);
  assert.deepEqual(JSON.parse(merged[0]), { id: 37, source: "remote", name: "a.jpg", url: "https://example.test/a.jpg", type: "image/jpeg" });
});

test("an accidental local/server ID collision does not replace or remove a different photo", () => {
  const local = JSON.stringify({ id: "37", name: "local.jpg", size: 130 });
  const remote = JSON.stringify({ id: 37, url: "https://example.test/remote.jpg", name: "remote.jpg" });
  const initial = createClosingDraftSnapshot({ photos: mergeMediaAnswers([remote], [local]) }, null);
  assert.equal(initial.answers.photos.length, 2);
  const removedRemote = createClosingDraftSnapshot({ photos: [local] }, initial);
  assert.deepEqual(mergeClosingAnswers(questions, { photos: [remote] }, removedRemote).photos, [local]);
});

test("backend media and a local draft are combined and remain stable on reopening", () => {
  const draft = createClosingDraftSnapshot({ photos: [mediaB] }, null);
  const first = mergeClosingAnswers(questions, { photos: [mediaA] }, draft);
  assert.deepEqual(first.photos.map((entry) => JSON.parse(entry).id), ["a", "b"]);
  const saved = createClosingDraftSnapshot(first, draft);
  assert.deepEqual(mergeClosingAnswers(questions, { photos: [mediaA] }, saved), first);
});

test("fresh backend URLs replace expired remote draft URLs without losing local media", () => {
  const expired = JSON.stringify({ id: 37, url: "https://example.test/a.jpg?expired", name: "a.jpg", remotePayload: { id: 37, url: "https://example.test/a.jpg?expired" } });
  // A backend may also change between the existing url/uri aliases.
  const fresh = JSON.stringify({ id: 37, uri: "https://example.test/a.jpg?fresh", name: "a.jpg" });
  const draft = createClosingDraftSnapshot({ photos: [expired, mediaB] }, null);
  const hydrated = mergeClosingAnswers(questions, { photos: [fresh] }, draft);
  assert.equal(hydrated.photos.length, 2);
  assert.deepEqual(JSON.parse(hydrated.photos[0]), { id: 37, uri: "https://example.test/a.jpg?fresh", name: "a.jpg" });
  assert.equal(hydrated.photos[1], mediaB);
  const removed = createClosingDraftSnapshot({ photos: [mediaB] }, draft);
  assert.deepEqual(mergeClosingAnswers(questions, { photos: [fresh] }, removed).photos, [mediaB]);
});

test("an explicit removal stays removed when backend media is hydrated again", () => {
  const initial = createClosingDraftSnapshot({ photos: [mediaA, mediaB] }, null);
  const removed = createClosingDraftSnapshot({ photos: [mediaB] }, initial);
  const reopened = mergeClosingAnswers(questions, { photos: [mediaA, mediaB] }, removed);
  assert.deepEqual(reopened.photos, [mediaB]);
  const removeAll = createClosingDraftSnapshot({ photos: [] }, removed);
  assert.deepEqual(mergeClosingAnswers(questions, { photos: [mediaA, mediaB] }, removeAll).photos, []);
  const readded = createClosingDraftSnapshot({ photos: [mediaA] }, removeAll);
  assert.deepEqual(mergeClosingAnswers(questions, { photos: [mediaA, mediaB] }, readded).photos, [mediaA]);
});

test("storage strips ephemeral media previews while preserving responses and large signatures", () => {
  const signature = `data:image/png;base64,${"a".repeat(510_000)}`;
  const source = { photos: [JSON.stringify({ ...JSON.parse(mediaA), previewUrl: "blob:temporary", previewDataUrl: "data:temporary", status: "ready" })],
    assinatura: signature, check: ["1", "2"], text: "", date: "2026-09-21" };
  const stored = prepareClosingAnswersForStorage(source);
  assert.deepEqual(stored.photos, [mediaA]);
  assert.equal(stored.assinatura, signature);
  assert.deepEqual(stored.check, ["1", "2"]);
  assert.ok(source.photos[0].includes("blob:temporary"), "the in-memory preview is not mutated");
});

test("cleared local text and checkbox responses override backend and unknown questionnaire answers are excluded", () => {
  const draft = createClosingDraftSnapshot({ text: "", check: [], date: "2026-09-21", otherQuestionnaire: "old" }, null);
  assert.deepEqual(mergeClosingAnswers(questions, { text: "old backend", check: ["2"] }, draft), {
    text: "", check: [], date: "2026-09-21",
  });
});

test("backend hydration accepts the existing submitted answers shape without treating answer options as responses", () => {
  const answers = readBackendClosingAnswers([
    { id_pergunta: "1", midias: [JSON.parse(mediaA), JSON.parse(mediaA)] },
    { id_pergunta: 2, resposta: "Feito" },
    { id_pergunta: "3", id_respostas: [66, "67"] },
    { id_pergunta: 4, id_resposta: 64 },
    { id_pergunta: 5, resposta: "2026-09-21" },
    { id_pergunta: 999, resposta: "Outra pergunta" },
  ], questions);
  assert.deepEqual(answers, { photos: [mediaA], text: "Feito", check: ["66", "67"], radio: "64", date: "2026-09-21" });
  assert.deepEqual(readBackendClosingAnswers({ perguntas: [{ id_pergunta: 4, respostas: [{ id_resposta: 64, resposta: "Opção" }] }] }, questions), {});
});

function useDatabase(t) {
  const previous = globalThis.indexedDB;
  const database = new MemoryIndexedDB();
  globalThis.indexedDB = database;
  t.after(() => {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  });
  return database;
}

const scope = { userId: "technician-7", orderId: "229", equipmentOrderId: "8", questionnaireId: "installation" };

test("IndexedDB reopening immediately after queued input changes restores the latest committed draft", async (t) => {
  const database = useDatabase(t);
  const first = writeClosingDraft(scope, { photos: [mediaA], text: "Inicial" });
  const next = writeClosingDraft(scope, { photos: [mediaA, mediaB], text: "Atualizado", check: ["66"], date: "2026-09-21" });
  // Do not await either write: this is closing and immediately reopening the questionnaire.
  const reopened = await readClosingDraft(scope);
  await Promise.all([first, next]);
  assert.deepEqual(reopened.answers, { photos: [mediaA, mediaB], text: "Atualizado", check: ["66"], date: "2026-09-21" });
  assert.deepEqual(reopened.removedMedia, {});
  assert.ok(database.openedVersions.every((version) => version === 3), "uses the existing database version");
});

test("IndexedDB persists large signatures and snapshots caller state before asynchronous work", async (t) => {
  useDatabase(t);
  const signature = `data:image/png;base64,${"a".repeat(750_000)}`;
  const answers = { photos: [mediaA], assinatura: signature, responsavel: "Responsável" };
  const pending = writeClosingDraft(scope, answers);
  answers.photos.push(mediaB);
  answers.assinatura = "changed after save";
  await pending;
  const reopened = await readClosingDraft(scope);
  assert.deepEqual(reopened.answers.photos, [mediaA]);
  assert.equal(reopened.answers.assinatura, signature);
  assert.equal(reopened.answers.responsavel, "Responsável");
});

test("a fresh service instance restores the persisted draft without relying on in-memory state", async (t) => {
  useDatabase(t);
  await writeClosingDraft(scope, { photos: [mediaA, mediaB], text: "Após reiniciar" });
  const restarted = await import(`${draftsModuleUrl}#fresh-service-instance`);
  assert.deepEqual((await restarted.readClosingDraft(scope)).answers, {
    photos: [mediaA, mediaB], text: "Após reiniciar",
  });
});

test("IndexedDB saves separate user, order, equipment, questionnaire and question answers", async (t) => {
  useDatabase(t);
  const scopes = [scope, { ...scope, userId: "technician-8" }, { ...scope, orderId: "230" },
    { ...scope, equipmentOrderId: "9" }, { ...scope, equipmentOrderId: undefined },
    { ...scope, questionnaireId: "cleaning" }];
  await Promise.all(scopes.map((entry, index) => writeClosingDraft(entry, {
    photos: [JSON.stringify({ ...JSON.parse(mediaA), id: `photo-${index}` })],
    anotherQuestion: [JSON.stringify({ ...JSON.parse(mediaB), id: `other-${index}` })],
  })));
  for (const [index, entry] of scopes.entries()) {
    const saved = await readClosingDraft(entry);
    assert.equal(JSON.parse(saved.answers.photos[0]).id, `photo-${index}`);
    assert.equal(JSON.parse(saved.answers.anotherQuestion[0]).id, `other-${index}`);
  }
});

test("a transient IndexedDB read failure never deletes or replaces the saved media", async (t) => {
  const database = useDatabase(t);
  await writeClosingDraft(scope, { photos: [mediaA, mediaB], text: "Preservar" });
  const operationsBefore = database.operations.length;
  database.failNext("get", { key: getClosingDraftKey(scope), mode: "readonly" });
  await assert.rejects(readClosingDraft(scope), { name: "AbortError" });
  assert.deepEqual(database.operations.slice(operationsBefore).map((entry) => entry.operation), ["get"]);
  const reopened = await readClosingDraft(scope);
  assert.deepEqual(reopened.answers, { photos: [mediaA, mediaB], text: "Preservar" });
});

test("an aborted IndexedDB write retains the old draft and the next edit can still be persisted", async (t) => {
  const database = useDatabase(t);
  await writeClosingDraft(scope, { photos: [mediaA], text: "Confirmado" });
  database.failNext("put", { key: getClosingDraftKey(scope), mode: "readwrite" });
  await assert.rejects(writeClosingDraft(scope, { photos: [mediaB], text: "Falha" }), { name: "AbortError" });
  assert.deepEqual((await readClosingDraft(scope)).answers, { photos: [mediaA], text: "Confirmado" });
  await writeClosingDraft(scope, { photos: [mediaA, mediaB], text: "Recuperado" });
  assert.deepEqual((await readClosingDraft(scope)).answers, { photos: [mediaA, mediaB], text: "Recuperado" });
});

test("explicit media removals survive IndexedDB close/reopen and backend rehydration", async (t) => {
  useDatabase(t);
  const remoteA = JSON.stringify({ id: 10, url: "https://example.test/a.jpg" });
  await writeClosingDraft(scope, { photos: [remoteA, mediaB] });
  await writeClosingDraft(scope, { photos: [mediaB] });
  const saved = await readClosingDraft(scope);
  assert.deepEqual(mergeClosingAnswers(questions, { photos: [remoteA] }, saved).photos, [mediaB]);
  assert.ok(saved.removedMedia.photos.includes("remote-id:10"));
  assert.ok(saved.removedMedia.photos.includes("url:https://example.test/a.jpg"));
});

test("confirmed discard waits for pending writes, removes only its draft and retains media/queue records", async (t) => {
  const database = useDatabase(t);
  const otherScope = { ...scope, equipmentOrderId: "9" };
  await writeClosingDraft(otherScope, { photos: [mediaB] });
  const storedDb = database.databases.get("diffonso-offline");
  storedDb.stores.get("media").records.set("a", { id: "a", blob: new Blob(["photo"]) });
  storedDb.stores.get("queue").records.set("finish", { id: "finish", payload: { id: "a" } });
  const pending = writeClosingDraft(scope, { photos: [mediaA] });
  const removal = removeClosingDraft(scope);
  assert.equal(await readClosingDraft(scope), null);
  await Promise.all([pending, removal]);
  assert.deepEqual((await readClosingDraft(otherScope)).answers.photos, [mediaB]);
  assert.equal(storedDb.stores.get("media").records.get("a").blob.size, 5);
  assert.ok(storedDb.stores.get("queue").records.has("finish"));
});
