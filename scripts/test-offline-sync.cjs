const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const draftKey = 'diffonso.closingDraft.v2.["user","229","8","20"]';
const otherDraftKey = 'diffonso.closingDraft.v2.["user","229","9","21"]';
const signature = "data:image/png;base64,aW1hZ2U=";
const localMedia = { id: "local-a", name: "a.jpg", size: 5, type: "image/jpeg", createdAt: "2026-01-01" };
const remoteMedia = { id: "server-a", name: "saved.jpg", size: 5, type: "image/jpeg", createdAt: "2026-01-01", url: "https://example.invalid/saved.jpg", source: "remote" };

function action(overrides = {}) {
  return {
    id: "finish-a", orderId: "229-equipamento-8", type: "finish_order", createdAt: "2026-01-01", attempts: 0,
    localMetadata: { draftKey },
    payload: {
      id_colaborador: "user", id_ordem_servico: "229", id_ordem_servico_equipamento: "8",
      id_situacao_ordem_servico: 5, assinatura: signature,
      respostas: [{ id_pergunta: "10", pergunta: "Foto", midias: [remoteMedia, localMedia] }],
    },
    ...overrides,
  };
}

function createHarness(kind, options = {}) {
  const queued = options.action ?? action();
  const records = {
    queue: new Map([[queued.id, queued]]),
    settings: new Map([
      [draftKey, { key: draftKey, answers: { photo: "local-a" } }],
      [otherDraftKey, { key: otherDraftKey, answers: { photo: "other" } }],
      ["authorization", { key: "authorization", value: "test-only" }],
      ["finishOrderUrl", { key: "finishOrderUrl", value: "/local-test/finish" }],
      ["changeOrderStatusUrl", { key: "changeOrderStatusUrl", value: "/local-test/status" }],
    ]),
    media: new Map(options.missingMedia ? [] : [[localMedia.id, { ...localMedia, blob: new Blob(["image"], { type: "image/jpeg" }) }]]),
  };
  const db = {
    transaction() {
      const transaction = {
        objectStore(name) {
          const store = records[name];
          const read = (value) => {
            const request = {};
            queueMicrotask(() => { request.result = value; request.onsuccess?.(); });
            return request;
          };
          return {
            get: (key) => read(store.get(key)), getAll: () => read([...store.values()]),
            put: (value) => store.set(value.key ?? value.id, value), delete: (key) => store.delete(key),
          };
        },
      };
      setImmediate(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  const requests = [];
  const responses = [...(options.responses ?? [{ sucesso: true }])];
  const context = vm.createContext({
    exports: {}, Blob, FormData, atob, btoa, Uint8Array, Map, Promise,
    console, navigator: {}, mockDb: db,
    self: { addEventListener() {} },
    fetch: async (url, request) => {
      requests.push({ url, ...request });
      const data = responses.shift() ?? { sucesso: true };
      return { ok: true, json: async () => data };
    },
    require(name) {
      if (name === "@capacitor/core") return { Capacitor: { isNativePlatform: () => false } };
      if (name.includes("endpoints")) return {
        apiAuthorizationToken: "test-only",
        endpoints: { finishOrderUrl: "/local-test/finish", changeOrderStatusUrl: "/local-test/status" },
      };
      if (name.includes("connectivity")) return { isDeviceOnline: async () => true, isConnectionFailure: () => false };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const filename = kind === "foreground" ? "src/services/offlineSync.ts" : "public/sw.js";
  let source = fs.readFileSync(path.join(root, filename), "utf8");
  if (kind === "foreground") source = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInContext(source, context, { filename });
  vm.runInContext("openDb = async () => mockDb;", context);
  return {
    records, requests, context,
    run: () => vm.runInContext(kind === "foreground" ? "syncPendingActions()" : "syncQueue()", context),
  };
}

for (const kind of ["foreground", "service-worker"]) {
  test(`${kind}: rejects empty and malformed signatures before sending`, async () => {
    for (const assinatura of ["", "   ", "data:image/png;base64,", "data:image/png;base64,%%%", "not-a-signature"]) {
      const queued = action();
      queued.payload.assinatura = assinatura;
      const harness = createHarness(kind, { action: queued });
      await harness.run();
      assert.equal(harness.requests.length, 0);
      assert.equal(harness.records.queue.get(queued.id).attempts, 1);
      assert.ok(harness.records.settings.has(draftKey));
    }
  });

  test(`${kind}: missing local media preserves queue and draft`, async () => {
    const harness = createHarness(kind, { missingMedia: true });
    await harness.run();
    assert.equal(harness.requests.length, 0);
    assert.ok(harness.records.queue.has("finish-a"));
    assert.ok(harness.records.settings.has(draftKey));
  });

  test(`${kind}: remote media survive beside local files without an IndexedDB blob`, async () => {
    const harness = createHarness(kind);
    await harness.run();
    assert.equal(harness.requests.length, 1);
    const body = harness.requests[0].body;
    const payload = JSON.parse(body.get("dados"));
    assert.equal(payload.id_ordem_servico_equipamento, "8");
    assert.equal(payload.respostas[0].midias[0].url, remoteMedia.url);
    assert.equal(payload.respostas[0].midias.length, 2);
    assert.equal(body.getAll("midias[]").length, 1);
    assert.equal(body.getAll("files[]").length, 1);
    assert.equal(body.get("assinatura").size, 5);
    assert.equal(payload.localMetadata, undefined);
    assert.equal(body.get("localMetadata"), null);
    assert.equal(harness.records.queue.size, 0);
    assert.equal(harness.records.settings.has(draftKey), false);
    assert.ok(harness.records.settings.has(otherDraftKey));
    assert.ok(harness.records.media.has(localMedia.id));
  });

  test(`${kind}: stable remote URL works without the optional source marker`, async () => {
    const queued = action();
    queued.payload.respostas[0].midias = [{ ...remoteMedia, source: undefined }];
    const harness = createHarness(kind, { action: queued, missingMedia: true });
    await harness.run();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].body.getAll("midias[]").length, 0);
  });

  test(`${kind}: API refusal keeps answers and files pending`, async () => {
    const harness = createHarness(kind, { responses: [{ sucesso: false, mensagem: "Ordens não podem ser finalizadas agora" }] });
    await harness.run();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.records.queue.get("finish-a").attempts, 1);
    assert.ok(harness.records.settings.has(draftKey));
    assert.ok(harness.records.media.has(localMedia.id));
  });

  test(`${kind}: JSON fallback keeps both media kinds and confirms draft cleanup`, async () => {
    const harness = createHarness(kind, { responses: [{ sucesso: false, mensagem: "JSON inválido" }, { sucesso: true }] });
    await harness.run();
    assert.equal(harness.requests.length, 2);
    const payload = JSON.parse(harness.requests[1].body);
    assert.equal(payload.id_ordem_servico_equipamento, "8");
    assert.equal(payload.respostas[0].midias[0].url, remoteMedia.url);
    assert.match(payload.respostas[0].midias[1].base64, /^data:image\/jpeg;base64,/);
    assert.equal(payload.midias.length, 2);
    assert.equal(payload.midias[0].url, remoteMedia.url);
    assert.equal(payload.midias[1].id, localMedia.id);
    assert.equal(payload.localMetadata, undefined);
    assert.equal(harness.records.queue.size, 0);
    assert.equal(harness.records.settings.has(draftKey), false);
    assert.ok(harness.records.settings.has(otherDraftKey));
  });

  test(`${kind}: metadata cannot delete unrelated settings`, async () => {
    const harness = createHarness(kind, { action: action({ localMetadata: { draftKey: "authorization" } }) });
    await harness.run();
    assert.ok(harness.records.settings.has("authorization"));
    assert.ok(harness.records.settings.has(draftKey));
  });

  test(`${kind}: successful finalization only clears status actions of its equipment`, async () => {
    const harness = createHarness(kind);
    harness.records.queue.set("status-a", { id: "status-a", type: "status_change", orderId: "229-equipamento-8", payload: { id_ordem_servico: "229", id_ordem_servico_equipamento: "8" } });
    harness.records.queue.set("status-b", { id: "status-b", type: "status_change", orderId: "229-equipamento-9", payload: { id_ordem_servico: "229", id_ordem_servico_equipamento: "9" } });
    await vm.runInContext("readQueueForTest = typeof readQueue === 'function' ? readQueue : getAllActions;", harness.context);
    await vm.runInContext("readQueueForTest().then(actions => acknowledgeAction(actions.find(action => action.id === 'finish-a')))", harness.context);
    assert.equal(harness.records.queue.has("status-a"), false);
    assert.equal(harness.records.queue.has("status-b"), true);
  });
}
