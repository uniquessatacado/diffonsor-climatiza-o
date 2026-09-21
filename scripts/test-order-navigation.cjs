const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const source = ts.createSourceFile("main.tsx", fs.readFileSync(path.resolve(__dirname, "../src/main.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
const components = new Set();
let detailsEffect;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(source));
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
    && node.arguments[0]?.getText(source).includes("preparedDetailRoute.current === routeId")) {
    detailsEffect = node.arguments[0].getText(source);
  }
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text)) components.add(node.tagName.text);
  ts.forEachChild(node, visit);
}
visit(source);
const navigationExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/services/orderNavigation.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: navigationExports });
const dateExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/services/dateFormat.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: dateExports });

const modules = import("./load-test-module.mjs").then(async ({ loadTestModule }) => ({
  orders: await loadTestModule(pathToFileURL(path.resolve(__dirname, "../src/services/serviceOrders.ts"))),
  groups: await loadTestModule(pathToFileURL(path.resolve(__dirname, "../src/services/serviceOrderGroups.ts"))),
}));

const firstOrder = {
  id: "229-equipamento-8", apiId: "229", apiOrderCode: "229", equipmentOrderId: "8", number: "OS-229",
  client: "Cliente", address: "Rua", statusId: 3, status: "Atendimento Iniciado", service: "Serviço A",
  scheduledAt: "2026-03-07 14:30:00",
  equipment: { labelCode: "80", brand: "Marca A", model: "Modelo A", environment: "Sala A", serialNumber: "S1" },
};
const secondOrder = {
  ...firstOrder, id: "229-equipamento-9", equipmentOrderId: "9", statusId: 1, status: "Aguardando atendimento", service: "Serviço B",
  equipment: { labelCode: "78", brand: "Marca B", model: "Modelo B", environment: "Sala B", serialNumber: "S2" },
};
const group = { id: "equipamentos-229%3A229", isEquipmentBased: true, representative: firstOrder, orders: [firstOrder, secondOrder] };

function makeHarness(names) {
  const navigations = [];
  const errors = [];
  const context = vm.createContext({
    exports: {},
    ...Object.fromEntries([...components].map((name) => [name, name])),
    ...navigationExports,
    ...dateExports,
    Error, URLSearchParams,
    navigateTo: (route) => navigations.push(route), handleLogout() {},
    formatServiceDate: (value) => value,
    orderGroups: [group], shouldShowElapsedStatus: () => false,
    openingOrderId: null, preparedDetailRoute: { current: null }, activeRoute: { current: { page: "orders", orderId: null } },
    setOpeningOrderId: (value) => { context.openingOrderId = value; },
    setResolvedDetailRoute: (value) => { context.resolvedDetailRoute = value; },
    setDetailsLoading: (value) => { context.detailsLoading = value; },
    setDetailsError: (value) => { context.detailsError = value; },
    setErrorModal: (message) => errors.push(message),
    closingLoading: false, suspendingOrder: false, closingOrder: false, closingContext: null, finishModal: false, errorModal: "",
    testOrderId: "teste-1", setClosingOrder() {}, setSuspendingOrder() {}, updateOrderStatus() {}, openClosingFlow() {}, resetTestOrder() {},
    require(name) {
      assert.equal(name, "react/jsx-runtime");
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" };
    },
  });
  const text = names.map((name) => {
    if (name === "runDetailsEffect") {
      assert.ok(detailsEffect, "Expected the app's detail-loading effect");
      return `function runDetailsEffect() { return (${detailsEffect})(); }`;
    }
    if (navigationExports[name]) return "";
    assert.ok(declarations.has(name), `Expected app function ${name}`);
    return declarations.get(name);
  }).join("\n");
  vm.runInContext(ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, context);
  return { context, navigations, errors };
}

function nodes(root) {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  return [root, ...nodes(root.props?.children)];
}

function textContent(root) {
  if (root == null || typeof root === "boolean") return "";
  if (typeof root === "string" || typeof root === "number") return String(root);
  if (Array.isArray(root)) return root.map(textContent).join(" ");
  return textContent(root.props?.children);
}

test("the group details route remains an order route with its own view", () => {
  const { context } = makeHarness(["routeFromPath"]);
  const list = context.routeFromPath(`/ordem/${group.id}`);
  const details = context.routeFromPath(`/ordem/${group.id}/detalhes`);
  assert.equal(details.page, "order");
  assert.equal(details.orderId, group.id);
  assert.notDeepEqual(details, list);
  assert.equal(context.routeFromPath(`/ordem/${group.id}/unknown`).page, "login");
});

test("individual equipment routes retain the selected item and registration remains reachable", () => {
  const { context } = makeHarness(["routeFromPath"]);
  assert.equal(context.routeFromPath(`/ordem/${secondOrder.id}`).orderId, secondOrder.id);
  assert.equal(context.routeFromPath("/ordem/233").orderId, "233");
  assert.equal(context.routeFromPath("/equipamentos/novo").page, "equipment-registration");
  assert.equal(context.routeFromPath("/ordens").page, "orders");
});

test("the equipment list has an order details button without selecting the first equipment", () => {
  const { context, navigations } = makeHarness(["renderEquipmentList"]);
  const tree = context.renderEquipmentList(group);
  const button = nodes(tree).find((node) => node.type === "button" && textContent(node).trim() === "Detalhes da OS");
  assert.ok(button, "Detalhes da OS button must remain visible in the equipment list");
  button.props.onClick();
  assert.deepEqual(navigations, [`/ordem/${group.id}/detalhes`]);
});

test("equipment cards keep navigating to their own item", () => {
  const { context, navigations } = makeHarness(["renderEquipmentList"]);
  const cards = nodes(context.renderEquipmentList(group)).filter((node) => node.type === "button" && node.props.className?.includes("equipment-selection-card"));
  assert.equal(cards.length, 2);
  assert.match(textContent(cards[1]), /Modelo B/);
  assert.match(textContent(cards[1]), /Aguardando atendimento/);
  cards[1].props.onClick();
  assert.deepEqual(navigations, [`/ordem/${secondOrder.id}`]);
});

test("orders without equipment enter their own detail route for all supported empty representations", async () => {
  const { orders, groups } = await modules;
  for (const equipmentFields of [{}, { equipamentos: [] }, { equipamento: null }, { equipamentos: null }]) {
    const normalized = orders.normalizeServiceOrders({ id: 233, ordem_servico: 233, ...equipmentFields }, { detailsLoaded: true });
    const [normalizedGroup] = groups.groupServiceOrders(normalized, orders.serviceOrderStatuses);
    assert.equal(normalizedGroup.isEquipmentBased, false);
    assert.equal(navigationExports.getOrderEntryPath(normalizedGroup), "/ordem/233");
    assert.equal(navigationExports.getOrderDetailsPath(normalizedGroup), "/ordem/233");
  }
});

test("one actual equipment enters the equipment list and the details shortcut identifies its only item", async () => {
  const { orders, groups } = await modules;
  const normalized = orders.normalizeServiceOrders({ id: 229, ordem_servico: 229, multi_equipamento: false,
    equipamentos: [{ id_ordem_servico_equipamento: 8, equipamento: { codigo_etiqueta: 80 } }],
  }, { detailsLoaded: true });
  const [normalizedGroup] = groups.groupServiceOrders(normalized, orders.serviceOrderStatuses);
  assert.equal(normalizedGroup.isEquipmentBased, true);
  assert.equal(navigationExports.getOrderEntryPath(normalizedGroup), `/ordem/${normalizedGroup.id}`);
  assert.equal(navigationExports.getOrderDetailsPath(normalizedGroup), "/ordem/229-equipamento-8");
});

test("multiple equipment preserve one order and open an overview with no implicit action target", async () => {
  const { orders, groups } = await modules;
  const normalized = orders.normalizeServiceOrders({ id: 229, ordem_servico: 229,
    equipamentos: [
      { id_ordem_servico_equipamento: 8, equipamento: { codigo_etiqueta: 80 } },
      { id_ordem_servico_equipamento: 9, equipamento: { codigo_etiqueta: 78 } },
    ],
  }, { detailsLoaded: true });
  const grouped = groups.groupServiceOrders(normalized, orders.serviceOrderStatuses);
  assert.equal(grouped.length, 1);
  assert.equal(navigationExports.getOrderEntryPath(grouped[0]), `/ordem/${grouped[0].id}`);
  const detailsPath = navigationExports.getOrderDetailsPath(grouped[0]);
  assert.equal(detailsPath, `/ordem/${grouped[0].id}/detalhes`);
  assert.equal(navigationExports.routeFromPath(detailsPath).overview, true);
  assert.equal(detailsPath.includes("-equipamento-8"), false);
});

test("orders without equipment show the exact simple notice and keep service actions", () => {
  const { context } = makeHarness(["renderOrderDetail"]);
  const order = { ...firstOrder, id: "233", equipmentOrderId: undefined, equipment: undefined };
  const tree = context.renderOrderDetail(order);
  assert.match(textContent(tree), /Esta OS não tem equipamento cadastrado\./);
  assert.equal(nodes(tree).some((node) => node.type === "details"), false);
  assert.equal(nodes(tree).some((node) => node.type === "dl" && node.props.className?.includes("equipment-selection-data")), false);
  const finish = nodes(tree).find((node) => node.type === "button" && textContent(node).trim() === "Encerrar atendimento");
  assert.ok(finish);
  assert.equal(finish.props.disabled, false);
  assert.ok(nodes(tree).find((node) => node.type === "button" && textContent(node).trim() === "Cadastrar equipamento"));
});

test("equipment detail keeps its actual equipment fields instead of the empty notice", () => {
  const { context } = makeHarness(["renderOrderDetail"]);
  const tree = context.renderOrderDetail(secondOrder);
  assert.doesNotMatch(textContent(tree), /Esta OS não tem equipamento cadastrado/);
  assert.ok(nodes(tree).find((node) => node.type === "details"));
  assert.match(textContent(tree), /Modelo B/);
  assert.match(textContent(tree), /07\/03\/2026 14:30/);
  assert.doesNotMatch(textContent(tree), /2026-03-07/);
  const start = nodes(tree).find((node) => node.type === "button" && textContent(node).trim() === "Iniciar atendimento");
  assert.ok(start);
  assert.equal(start.props.disabled, false);
});

test("the multi-equipment overview waits for explicit selection before enabling service actions", () => {
  const { context, navigations } = makeHarness(["renderOrderDetail"]);
  const tree = context.renderOrderDetail(group.representative, group);
  const actionClasses = [" move ", " attend ", " secondary ", " finish "];
  const actions = nodes(tree).filter((node) => node.type === "button" && actionClasses.some((className) => ` ${node.props.className} `.includes(className)));
  assert.equal(actions.length, 4);
  actions.forEach((button) => assert.equal(button.props.disabled, true, `${textContent(button)} must wait for an equipment`));
  assert.equal(nodes(tree).some((node) => node.type === "details"), false);
  const selector = nodes(tree).find((node) => node.type === "select" && node.props.id === "order-equipment-target");
  assert.ok(selector);
  assert.equal(selector.props.value, "");
  selector.props.onChange({ target: { value: secondOrder.id } });
  assert.deepEqual(navigations, [`/ordem/${secondOrder.id}`]);
});

test("opening a list summary waits for details and routes a no-equipment order directly", async () => {
  const { orders, groups } = await modules;
  const { context, navigations } = makeHarness(["openServiceOrder"]);
  let resolveDetails;
  const deferred = new Promise((resolve) => { resolveDetails = resolve; });
  Object.assign(context, { loadServiceOrderDetails: () => deferred, groupServiceOrders: groups.groupServiceOrders, serviceOrderStatuses: orders.serviceOrderStatuses });
  const opening = context.openServiceOrder(group);
  assert.equal(navigations.length, 0);
  resolveDetails(orders.normalizeServiceOrders({ id: 233, ordem_servico: 233, equipamentos: [] }, { detailsLoaded: true }));
  await opening;
  assert.deepEqual(navigations, ["/ordem/233"]);
  assert.equal(context.preparedDetailRoute.current, "233");
  assert.equal(context.openingOrderId, null);
});

test("a failed detail request remains on the order list and reports the error", async () => {
  const { context, navigations, errors } = makeHarness(["openServiceOrder"]);
  context.loadServiceOrderDetails = async () => { throw new Error("detail-test-failure"); };
  await context.openServiceOrder(group);
  assert.equal(navigations.length, 0);
  assert.deepEqual(errors, ["detail-test-failure"]);
  assert.equal(context.openingOrderId, null);
});

test("leaving the list while details load prevents late navigation", async () => {
  const { context, navigations } = makeHarness(["openServiceOrder"]);
  let resolveDetails;
  context.loadServiceOrderDetails = () => new Promise((resolve) => { resolveDetails = resolve; });
  const opening = context.openServiceOrder(group);
  context.activeRoute.current.page = "login";
  resolveDetails([firstOrder, secondOrder]);
  await opening;
  assert.equal(navigations.length, 0);
});

test("the prepared detail route consumes its marker and avoids a second detail request", () => {
  const { context } = makeHarness(["runDetailsEffect"]);
  let requests = 0;
  Object.assign(context, {
    isLoggedIn: true, route: navigationExports.routeFromPath("/ordem/233"),
    selectedOrder: { ...firstOrder, id: "233", equipment: undefined }, selectedOrderGroup: null,
    preparedDetailRoute: { current: "233" },
    loadServiceOrderDetails: async () => { requests += 1; return []; },
    detailsLoading: true, detailsError: "old failure", resolvedDetailRoute: null,
  });
  context.runDetailsEffect();
  assert.equal(requests, 0);
  assert.equal(context.preparedDetailRoute.current, null);
  assert.equal(context.resolvedDetailRoute, "233");
  assert.equal(context.detailsLoading, false);
  assert.equal(context.detailsError, "");
});

test("a direct no-equipment link stays unresolved until its detail request completes", async () => {
  const { context } = makeHarness(["runDetailsEffect"]);
  let resolveDetails;
  let requestedId;
  Object.assign(context, {
    isLoggedIn: true, route: navigationExports.routeFromPath("/ordem/233"),
    selectedOrder: { ...firstOrder, id: "233", equipment: undefined }, selectedOrderGroup: null,
    loadServiceOrderDetails: (id) => { requestedId = id; return new Promise((resolve) => { resolveDetails = resolve; }); },
    detailsLoading: false, detailsError: "", resolvedDetailRoute: "old-order",
  });
  context.runDetailsEffect();
  assert.equal(requestedId, "233");
  assert.equal(context.resolvedDetailRoute, null);
  assert.equal(context.detailsLoading, true);
  resolveDetails([context.selectedOrder]);
  await new Promise(setImmediate);
  assert.equal(context.resolvedDetailRoute, "233");
  assert.equal(context.detailsLoading, false);
});

test("cleaning up a detail effect ignores a late result after route changes", async () => {
  const { context } = makeHarness(["runDetailsEffect"]);
  let resolveDetails;
  Object.assign(context, {
    isLoggedIn: true, route: navigationExports.routeFromPath("/ordem/233"),
    selectedOrder: { ...firstOrder, id: "233", equipment: undefined }, selectedOrderGroup: null,
    loadServiceOrderDetails: () => new Promise((resolve) => { resolveDetails = resolve; }),
  });
  const cleanup = context.runDetailsEffect();
  cleanup();
  context.resolvedDetailRoute = "another-order";
  resolveDetails([context.selectedOrder]);
  await new Promise(setImmediate);
  assert.equal(context.resolvedDetailRoute, "another-order");
});
