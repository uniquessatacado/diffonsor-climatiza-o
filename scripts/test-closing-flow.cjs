const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const mainSource = ts.createSourceFile("main.tsx", fs.readFileSync(path.join(root, "src/main.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functionNames = new Set([
  "openClosingFlow", "updateClosingAnswer", "mergeOrderSummaries", "preserveStatusTimers",
  "finishOrder", "isQuestionAnswered", "parseDatetimeAnswer", "getPoint", "startDrawing", "draw", "stopDrawing", "clearSignature",
]);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text)) functions.push(node.getText(mainSource));
  ts.forEachChild(node, visit);
}
visit(mainSource);
assert.equal(functions.length, functionNames.size, "The app flow functions must exist in main.tsx");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function makeHarness(loadDetails) {
  const draftExports = {};
  const draftContext = vm.createContext({ exports: draftExports, require: () => ({}) });
  vm.runInContext(transpile(fs.readFileSync(path.join(root, "src/services/closingDrafts.ts"), "utf8")), draftContext);
  const summary = { id: "229-equipamento-8", questionnaireId: "WRONG-LIST", closingQuestions: [{ id: "wrong", step: "text" }] };
  const detailed = {
    ...summary, questionnaireId: "equipment-8-questionnaire", equipmentOrderId: "8", apiId: "229", apiOrderCode: "229", number: "OS-229", detailsLoaded: true,
    closingQuestions: [{ id: "api-10", apiQuestionId: "10", step: "media", required: false }],
  };
  const state = { open: false, questions: null, answers: {}, errors: [], fetchedQuestionnaires: [], writes: [], queued: [], statuses: [] };
  const stored = new Map();
  const context = vm.createContext({
    ...draftExports,
    console, Error, selectedOrder: summary, closingLoading: false, closingSubmitting: false, closingAnswers: {},
    activeRoute: { current: { orderId: summary.id } }, testOrderId: "teste-1",
    serviceOrderStatuses: { 1: "Aguardando atendimento", 3: "Atendimento Iniciado", 4: "Suspenso", 5: "Finalizado" },
    closingDraftsByScope: { current: new Map() }, closingContext: null, activeClosingContext: { current: null },
    localStorage: { removeItem() {} },
    getScopedClosingDraftKey: draftExports.getClosingDraftKey,
    getClosingDraftKey: (id) => `legacy.${id}`,
    getDraftScope: (order) => ({ userId: "user", orderId: "229", equipmentOrderId: "8", questionnaireId: order.questionnaireId }),
    loadServiceOrderDetails: loadDetails ?? (async () => [detailed]),
    fetchClosingQuestions: async (order) => { state.fetchedQuestionnaires.push(order.questionnaireId); return order.closingQuestions; },
    readClosingDraft: async (scope) => stored.get(draftExports.getClosingDraftKey(scope)) ?? null,
    readLegacyClosingDraft: () => null,
    validateMediaBeforeFinish: async () => true,
    prepareAnswersForPost: () => [],
    getCollaboratorId: () => "user", readSavedSession: () => null,
    queueAndTrySync: async (...args) => { state.queued.push(args); return { offline: false, currentPending: false }; },
    updateOrderStatus: (...args) => state.statuses.push(args),
    removeClosingDraft: async (scope) => { stored.delete(draftExports.getClosingDraftKey(scope)); },
    releaseMediaPreviewUrls() {}, setFinishQueuedOffline() {}, setFinishModal() {},
    writeClosingDraft: async (scope, answers) => {
      const key = draftExports.getClosingDraftKey(scope);
      const snapshot = draftExports.createClosingDraftSnapshot(answers, stored.get(key) ?? null);
      stored.set(key, snapshot);
      state.writes.push(key);
      return snapshot;
    },
    setClosingLoading: (value) => { context.closingLoading = value; },
    setClosingContext: (value) => { context.closingContext = value; context.activeClosingContext.current = value; },
    setClosingQuestions: (value) => { state.questions = value; context.closingQuestions = value; },
    setClosingAnswers: (value) => { state.answers = value; context.closingAnswers = value; },
    setClosingSubmitting: (value) => { context.closingSubmitting = value; }, setClosingStep() {},
    setClosingOrder: (value) => { state.open = value; },
    setErrorModal: (value) => { state.errors.push(value); },
  });
  vm.runInContext(transpile(functions.join("\n")), context);
  return { context, state, detailed, stored };
}

test("closing waits for detail response and uses only its equipment questionnaire", async () => {
  let resolveDetails;
  const response = new Promise((resolve) => { resolveDetails = resolve; });
  const harness = makeHarness(() => response);
  const opening = harness.context.openClosingFlow();
  assert.equal(harness.state.open, false);
  assert.equal(harness.state.fetchedQuestionnaires.length, 0);
  resolveDetails([harness.detailed]);
  await opening;
  assert.equal(harness.state.open, true);
  assert.deepEqual(harness.state.fetchedQuestionnaires, ["equipment-8-questionnaire"]);
  assert.equal(harness.state.questions[0].id, "api-10");
  assert.match(harness.state.writes[0], /equipment-8-questionnaire/);
});

test("navigation while details load does not open the old questionnaire", async () => {
  let resolveDetails;
  const response = new Promise((resolve) => { resolveDetails = resolve; });
  const harness = makeHarness(() => response);
  const opening = harness.context.openClosingFlow();
  harness.context.activeRoute.current.orderId = "229-equipamento-9";
  resolveDetails([harness.detailed]);
  await opening;
  assert.equal(harness.state.open, false);
  assert.equal(harness.state.fetchedQuestionnaires.length, 0);
  assert.equal(harness.state.writes.length, 0);
});

test("detail request failure preserves existing draft and reports the failure", async () => {
  const harness = makeHarness(async () => { throw new Error("offline-test"); });
  harness.stored.set("saved-draft", { answers: { photo: ["A"] } });
  await harness.context.openClosingFlow();
  assert.equal(harness.state.open, false);
  assert.equal(harness.state.writes.length, 0);
  assert.equal(harness.stored.get("saved-draft").answers.photo[0], "A");
  assert.deepEqual(harness.state.errors, ["offline-test"]);
});

test("adding media after reentry appends once and retains the earlier photo", async () => {
  const harness = makeHarness();
  await harness.context.openClosingFlow();
  const context = harness.context.closingContext;
  const photo = (id) => JSON.stringify({ id, name: `${id}.jpg`, type: "image/jpeg", size: 5, createdAt: "2026-01-01" });
  await harness.context.updateClosingAnswer("api-10", [photo("A")], context, true);
  await harness.context.openClosingFlow();
  await harness.context.updateClosingAnswer("api-10", [photo("B")], harness.context.closingContext, true);
  await harness.context.updateClosingAnswer("api-10", [photo("B")], harness.context.closingContext, true);
  assert.deepEqual(Array.from(harness.state.answers["api-10"], (item) => JSON.parse(item).id), ["A", "B"]);
  assert.deepEqual(Array.from(harness.stored.get(context.key).answers["api-10"], (item) => JSON.parse(item).id), ["A", "B"]);
});

test("a late media result keeps its original equipment scope after navigation", async () => {
  const harness = makeHarness();
  await harness.context.openClosingFlow();
  const originalContext = harness.context.closingContext;
  harness.context.activeRoute.current.orderId = "229-equipamento-9";
  harness.state.answers = { otherEquipment: "untouched" };
  await harness.context.updateClosingAnswer("api-10", [JSON.stringify({ id: "photo-a", name: "a.jpg", size: 5 })], originalContext, true);
  assert.deepEqual(harness.state.answers, { otherEquipment: "untouched" });
  assert.equal(JSON.parse(harness.stored.get(originalContext.key).answers["api-10"][0]).id, "photo-a");
});

test("a late photo cannot replace a newer questionnaire of the same equipment", async () => {
  const harness = makeHarness();
  await harness.context.openClosingFlow();
  const originalContext = harness.context.closingContext;
  harness.context.activeClosingContext.current = { ...originalContext, key: "another-questionnaire-scope" };
  harness.state.answers = { newerQuestionnaire: "untouched" };
  await harness.context.updateClosingAnswer("api-10", [JSON.stringify({ id: "photo-a", name: "a.jpg", size: 5 })], originalContext, true);
  assert.deepEqual(harness.state.answers, { newerQuestionnaire: "untouched" });
  assert.equal(JSON.parse(harness.stored.get(originalContext.key).answers["api-10"][0]).id, "photo-a");
});

test("finalization requires a signature even when the questionnaire has no questions", async () => {
  for (const equipment of [true, false]) {
    const harness = makeHarness();
    await harness.context.openClosingFlow();
    const order = { ...harness.detailed, equipmentOrderId: equipment ? "8" : undefined, questionnaireId: undefined };
    harness.context.closingContext.order = order;
    harness.context.closingQuestions = [];
    harness.context.closingAnswers = { responsavel: "Cliente", assinatura: "" };
    await harness.context.finishOrder(order);
    assert.equal(harness.state.queued.length, 0);
    assert.equal(harness.state.statuses.length, 0);
    assert.equal(harness.state.errors.length, 1);
  }
});

test("signed closure without a questionnaire keeps the equipment target optional", async () => {
  for (const equipment of [true, false]) {
    const harness = makeHarness();
    await harness.context.openClosingFlow();
    const order = { ...harness.detailed, equipmentOrderId: equipment ? "8" : undefined, questionnaireId: undefined };
    harness.context.closingContext.order = order;
    harness.context.closingQuestions = [
      { id: "observacao_servico", step: "textarea", required: false },
      { id: "responsavel", step: "responsible", required: true },
      { id: "assinatura", step: "signature", required: true },
    ];
    harness.context.closingAnswers = { responsavel: "Cliente", assinatura: "data:image/png;base64,aW1hZ2U=" };
    await harness.context.finishOrder(order);
    assert.equal(harness.state.errors.length, 0);
    assert.equal(harness.state.queued.length, 1);
    const payload = harness.state.queued[0][2];
    assert.equal(payload.id_questionario, "");
    assert.equal(payload.id_ordem_servico, "229");
    assert.equal(payload.id_ordem_servico_equipamento, equipment ? "8" : undefined);
    assert.equal(harness.state.statuses[0][1], 5);
  }
});

test("signature canvas ignores a tap or stationary pointer and saves a drawn stroke", () => {
  const harness = makeHarness();
  const signatures = [];
  let strokes = 0;
  const drawingContext = { beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes += 1; } };
  Object.assign(harness.context, {
    canvasRef: { current: {
      getContext: () => drawingContext, getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture() {}, toDataURL: () => "data:image/png;base64,aW1hZ2U=",
    } },
    drawingRef: { current: false }, hasStrokeRef: { current: false }, lastPointRef: { current: { x: 0, y: 0 } },
    onChange: (value) => signatures.push(value),
  });
  const pointer = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
  harness.context.startDrawing(pointer(10, 10));
  harness.context.stopDrawing();
  assert.equal(signatures.length, 0);
  harness.context.startDrawing(pointer(10, 10));
  harness.context.draw(pointer(10, 10));
  harness.context.stopDrawing();
  assert.equal(signatures.length, 0);
  harness.context.startDrawing(pointer(10, 10));
  harness.context.draw(pointer(20, 20));
  harness.context.stopDrawing();
  assert.equal(signatures.length, 1);
  assert.equal(strokes, 1);
});

test("a summary refresh preserves resolved equipment questionnaire and media", () => {
  const harness = makeHarness();
  const detail = { ...harness.detailed, equipment: { model: "MODEL-A" }, service: "Equipment service", statusId: 3,
    questionnaireResponses: [{ id_pergunta: "10", midias: [{ id: "saved-photo" }] }], raw: { equipamentos: [{}] } };
  const summary = { ...detail, detailsLoaded: false, questionnaireId: undefined, closingQuestions: [], questionnaireResponses: undefined,
    equipment: { model: "" }, service: "", statusId: 1 };
  const [merged] = harness.context.mergeOrderSummaries([summary], [detail], []);
  assert.equal(merged.questionnaireId, detail.questionnaireId);
  assert.equal(merged.closingQuestions[0].id, "api-10");
  assert.equal(merged.questionnaireResponses[0].midias[0].id, "saved-photo");
  assert.equal(merged.equipment.model, "MODEL-A");
  assert.equal(merged.service, "Equipment service");
  assert.equal(merged.statusId, 1);
});

test("an older list payload omitting equipment retains each resolved item", () => {
  const harness = makeHarness();
  const first = { ...harness.detailed, equipment: { model: "A" }, statusId: 3 };
  const second = { ...first, id: "229-equipamento-9", equipmentOrderId: "9", equipment: { model: "B" }, questionnaireId: "other-questionnaire", statusId: 1 };
  const summary = { id: "229", apiOrderCode: "229", detailsLoaded: false, raw: {}, client: "Updated client", statusId: 1 };
  const merged = harness.context.mergeOrderSummaries([summary], [first, second], []);
  assert.equal(merged.length, 2);
  assert.deepEqual(Array.from(merged, (order) => order.id), [first.id, second.id]);
  assert.deepEqual(Array.from(merged, (order) => order.questionnaireId), [first.questionnaireId, second.questionnaireId]);
  assert.equal(merged[0].client, "Updated client");
});

test("an explicit empty equipment list does not revive a previous legacy equipment", () => {
  const harness = makeHarness();
  const previous = { ...harness.detailed, id: "229", equipmentOrderId: undefined, equipment: { model: "OLD" }, statusId: 3 };
  for (const raw of [{ equipamentos: [] }, { equipamento: null }, { equipamentos: null }]) {
    const summary = { id: "229", apiOrderCode: "229", detailsLoaded: false, raw, equipment: undefined,
      questionnaireId: "order-questionnaire", closingQuestions: [{ id: "order-question" }], statusId: 1 };
    const merged = harness.context.mergeOrderSummaries([summary], [previous], []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].equipment, undefined);
    assert.equal(merged[0].questionnaireId, "order-questionnaire");
  }
});

test("a replacement legacy equipment does not inherit the previous questionnaire", () => {
  const harness = makeHarness();
  const previous = { ...harness.detailed, id: "229", equipmentOrderId: undefined, equipment: { clientEquipmentId: "8", model: "OLD" }, statusId: 3 };
  const summary = { ...previous, detailsLoaded: false, equipment: { clientEquipmentId: "9", model: "NEW" },
    questionnaireId: undefined, closingQuestions: [], raw: { equipamento: { id: "9" } } };
  const [merged] = harness.context.mergeOrderSummaries([summary], [previous], []);
  assert.equal(merged.equipment.clientEquipmentId, "9");
  assert.equal(merged.questionnaireId, undefined);
  assert.equal(merged.detailsLoaded, false);
});

test("a changed questionnaire assignment invalidates previous questionnaire details", () => {
  const harness = makeHarness();
  const previous = { ...harness.detailed, equipment: { clientEquipmentId: "8" }, statusId: 3 };
  const summary = { ...previous, detailsLoaded: false, questionnaireId: "new-questionnaire", closingQuestions: [], raw: { equipamentos: [{}] } };
  const [merged] = harness.context.mergeOrderSummaries([summary], [previous], []);
  assert.equal(merged.questionnaireId, "new-questionnaire");
  assert.equal(merged.closingQuestions.length, 0);
  assert.equal(merged.detailsLoaded, false);
});

test("pending equipment status uses its latest timestamp without changing another equipment", () => {
  const harness = makeHarness();
  const first = { ...harness.detailed, statusId: 1 };
  const second = { ...first, id: "229-equipamento-9", equipmentOrderId: "9" };
  const pending = [
    { orderId: first.id, statusId: 4, createdAt: "2026-01-02T00:00:00.000Z" },
    { orderId: first.id, statusId: 3, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const merged = harness.context.mergeOrderSummaries([first, second], [], pending);
  assert.equal(merged[0].statusId, 4);
  assert.equal(merged[1].statusId, 1);
  assert.equal(merged[0].statusStartedAt, "2026-01-02T00:00:00.000Z");
});
