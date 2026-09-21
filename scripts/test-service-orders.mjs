import assert from "node:assert/strict";
import test from "node:test";
import { loadTestModule } from "./load-test-module.mjs";

const { normalizeServiceOrders, fetchServiceOrderDetailOrders, fetchServiceOrderDetails, serviceOrderStatuses } = await loadTestModule(
  new URL("../src/services/serviceOrders.ts", import.meta.url),
);
const { groupServiceOrders, getEquipmentGroupId } = await loadTestModule(
  new URL("../src/services/serviceOrderGroups.ts", import.meta.url),
);

const questionnaire = (id, types = ["TEXT"]) => ({
  id_questionario: id,
  titulo: `Questionário ${id}`,
  perguntas: types.map((type, index) => ({
    id_pergunta: index + 1,
    pergunta: `${type} ${index + 1}`,
    tipo_resposta: type,
    obrigatorio: "1",
    respostas: type === "RADIO" ? [{ id_resposta: 8, resposta: "Sim" }] : [],
  })),
});
const order = (extra = {}) => ({
  id: 900,
  ordem_servico: 901,
  nome_cliente: "Cliente",
  nome_servico: "Serviço da OS",
  id_situacao_ordem_servico: 3,
  situacao_ordem_descricao: "Atendimento Iniciado",
  endereco: "Rua da OS",
  numero: "10",
  questionario: questionnaire("global"),
  ...extra,
});
const apiQuestions = (normalized) => normalized.closingQuestions.filter((question) => question.apiQuestionId !== undefined);

test("nested equipment data survives blank wrapper fields and preserves individual address", () => {
  const [normalized] = normalizeServiceOrders(order({
    equipamentos: [{
      id_ordem_servico_equipamento: 51,
      codigo_etiqueta: "",
      ambiente: " ",
      modelo: null,
      numero_serie: "",
      marca: "",
      equipamento: {
        id: 77,
        codigo_etiqueta: "80",
        ambiente: "SALA QUARENTENA",
        marca: "CONSUL",
        modelo: "CBJ18CBBNA",
        numero_serie: "NÃO ENCONTRADO",
        capacidade_btus: 18000,
        tensao: "220",
        gas_refrigerante: "R410",
        local: "Filial",
        local_instalacao: "Quarentena",
        endereco: "Rua do equipamento",
        numero: "s/n",
        complemento: "Sala 2",
        ponto_referencia: "Portão azul",
        bairro: "Centro",
        cidade: "São Roque",
        estado: "SP",
        cep: "18131770",
        observacao: "Aguardando avaliação",
      },
    }],
  }));
  assert.equal(normalized.id, "900-equipamento-51");
  assert.equal(normalized.apiId, "900");
  assert.equal(normalized.apiOrderCode, "901");
  assert.equal(normalized.equipment.labelCode, "80");
  assert.equal(normalized.equipment.environment, "SALA QUARENTENA");
  assert.equal(normalized.equipment.brand, "CONSUL");
  assert.equal(normalized.equipment.model, "CBJ18CBBNA");
  assert.equal(normalized.equipment.serialNumber, "NÃO ENCONTRADO");
  assert.equal(normalized.equipment.clientEquipmentId, "77");
  assert.equal(normalized.equipment.capacityBtus, "18000");
  assert.equal(normalized.equipment.voltage, "220");
  assert.equal(normalized.equipment.refrigerantGas, "R410");
  assert.equal(normalized.equipment.installationLocation, "Quarentena");
  assert.equal(normalized.equipment.location, "Filial");
  assert.equal(normalized.equipment.observation, "Aguardando avaliação");
  assert.equal(normalized.equipment.address, "Rua do equipamento, s/n | Centro | Sala 2 | Portão azul | São Roque - SP | CEP 18131770");
  assert.equal(normalized.address, "Rua da OS, 10");
});

test("detail/list service names and IDs resolve on the selected equipment", () => {
  const normalized = normalizeServiceOrders(order({ equipamentos: [
    { id_ordem_servico_equipamento: 1, nome_servico: "Instalação", servico: "Anterior", id_servico: 21 },
    { id_ordem_servico_equipamento: 2, nome_servico: " ", servico: "Manutenção", id_servico: 22 },
    { id_ordem_servico_equipamento: 3, nome_servico: "", servico: "" },
  ] }));
  assert.deepEqual(normalized.map((item) => item.service), ["Instalação", "Manutenção", "Serviço da OS"]);
  assert.deepEqual(normalized.map((item) => item.serviceId), ["21", "22", undefined]);
});

test("different equipment statuses and questionnaires stay independent", () => {
  const normalized = normalizeServiceOrders(order({ equipamentos: [
    { id_ordem_servico_equipamento: 1, id_situacao_ordem_servico: 5, situacao_ordem_descricao: "Finalizado pelo técnico", questionario: questionnaire(3, ["RADIO"]) },
    { id_ordem_servico_equipamento: 2, id_situacao_ordem_servico: 1, questionario: questionnaire(14, ["MIDIA", "TEXTAREA"]) },
  ] }), { detailsLoaded: true });
  assert.deepEqual(normalized.map((item) => item.statusId), [5, 1]);
  assert.deepEqual(normalized.map((item) => item.status), ["Finalizado pelo técnico", "Aguardando atendimento"]);
  assert.deepEqual(normalized.map((item) => item.questionnaireId), ["3", "14"]);
  assert.deepEqual(normalized.map((item) => apiQuestions(item).map((question) => question.step)), [["radio"], ["media", "textarea"]]);
  assert.ok(normalized.every((item) => item.questionnaireSource === "equipment" && item.detailsLoaded && item.questionnaireResolved));
});

test("one equipment owns its questionnaire even when multi_equipamento is false", () => {
  const [normalized] = normalizeServiceOrders(order({ multi_equipamento: false, equipamentos: [
    { id_ordem_servico_equipamento: 1, questionario: questionnaire("equipment", ["DATA"]) },
  ] }));
  assert.equal(normalized.questionnaireId, "equipment");
  assert.equal(apiQuestions(normalized)[0].step, "date");
  assert.equal(normalized.detailsLoaded, false);
});

test("missing or null equipment questionnaire never inherits the OS questionnaire", () => {
  const normalized = normalizeServiceOrders(order({ equipamentos: [
    { id_ordem_servico_equipamento: 1, questionario: null },
    { id_ordem_servico_equipamento: 2 },
    { id_ordem_servico_equipamento: 3, questionario: null, equipamento: { questionario: questionnaire("nested") } },
  ] }));
  for (const item of normalized) {
    assert.equal(item.questionnaireId, undefined);
    assert.deepEqual(item.closingQuestions.map((question) => question.id), ["observacao_servico", "responsavel", "assinatura"]);
    assert.equal(item.closingQuestions.at(-1).required, true);
  }
});

test("orders without equipment use their own questionnaire and always require signature", () => {
  for (const equipamentos of [undefined, null, []]) {
    const [normalized] = normalizeServiceOrders(order({ equipamentos }));
    assert.equal(normalized.id, "900");
    assert.equal(normalized.equipment, undefined);
    assert.equal(normalized.questionnaireSource, "order");
    assert.equal(normalized.questionnaireId, "global");
    assert.equal(normalized.closingQuestions.at(-1).step, "signature");
    assert.equal(normalized.closingQuestions.at(-1).required, true);
  }
  const [withoutQuestionnaire] = normalizeServiceOrders(order({ equipamentos: [], questionario: null }));
  assert.deepEqual(withoutQuestionnaire.closingQuestions.map((question) => question.step), ["textarea", "responsible", "signature"]);
});

test("legacy single equipment without relation ID retains OS identity and equipment questionnaire", () => {
  const [single] = normalizeServiceOrders(order({ multi_equipamento: false, equipamento: {
    id: 31, codigo_etiqueta: "old", questionario: questionnaire("legacy"),
  } }));
  assert.equal(single.id, "900");
  assert.equal(single.equipmentOrderId, undefined);
  assert.equal(single.equipment.clientEquipmentId, "31");
  assert.equal(single.questionnaireId, "legacy");

  const [flat] = normalizeServiceOrders(order({ id_cliente_equipamento: 31, codigo_etiqueta: "old" }));
  assert.equal(flat.equipment.labelCode, "old");
  assert.equal(flat.questionnaireId, undefined);
  assert.equal(flat.questionnaireSource, "equipment");
});

test("equipment array without relation IDs is still equipment, never a global questionnaire", () => {
  const normalized = normalizeServiceOrders(order({ equipamentos: [
    { equipamento: { id: 51, codigo_etiqueta: "A" }, questionario: questionnaire("A") },
    { equipamento: { id: 52, codigo_etiqueta: "B" }, questionario: questionnaire("B") },
  ] }));
  assert.equal(new Set(normalized.map((item) => item.id)).size, 2);
  assert.deepEqual(normalized.map((item) => item.equipment.labelCode), ["A", "B"]);
  assert.deepEqual(normalized.map((item) => item.questionnaireId), ["A", "B"]);
  assert.ok(normalized.every((item) => item.equipmentOrderId === undefined));
});

test("legacy equipment without a relation ID still opens the equipment group", () => {
  const normalized = normalizeServiceOrders(order({ equipamento: { id: 31, codigo_etiqueta: "old" } }));
  const [group] = groupServiceOrders(normalized, serviceOrderStatuses);
  assert.equal(group.isEquipmentBased, true);
  assert.equal(group.id, getEquipmentGroupId(normalized[0]));
  assert.equal(group.orders[0].id, "900");
  assert.equal(group.orders[0].equipmentOrderId, undefined);
});

test("repeated legacy equipment IDs receive separate local identities without inventing API relation IDs", () => {
  const normalized = normalizeServiceOrders(order({ equipamentos: [
    { equipamento: { id: 51 }, questionario: questionnaire("A") },
    { equipamento: { id: 51 }, questionario: questionnaire("B") },
    { equipamento: { id: 52 }, questionario: questionnaire("C") },
  ] }));
  assert.deepEqual(normalized.map((item) => item.id), [
    "900-equipamento-legado-51-item-0",
    "900-equipamento-legado-51-item-1",
    "900-equipamento-legado-52",
  ]);
  assert.equal(new Set(normalized.map((item) => item.id)).size, 3);
  assert.deepEqual(normalized.map((item) => item.questionnaireId), ["A", "B", "C"]);
  assert.ok(normalized.every((item) => item.equipmentOrderId === undefined));
  assert.equal(groupServiceOrders(normalized, serviceOrderStatuses)[0].orders.length, 3);
});

test("multiple equipment without relation IDs share one OS card and retain separate statuses", () => {
  const normalized = normalizeServiceOrders(order({ equipamentos: [
    { equipamento: { id: 51 }, id_situacao_ordem_servico: 5 },
    { equipamento: { id: 52 }, id_situacao_ordem_servico: 1 },
  ] }));
  const groups = groupServiceOrders(normalized, serviceOrderStatuses);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isEquipmentBased, true);
  assert.equal(groups[0].representative.statusId, 1);
  assert.deepEqual(groups[0].orders.map((item) => item.statusId), [5, 1]);
  assert.ok(groups[0].orders.every((item) => item.equipmentOrderId === undefined));
});

test("orders without equipment keep their direct route and do not join equipment groups", () => {
  const normalized = normalizeServiceOrders([
    order(),
    order({ id: 902, ordem_servico: 903, equipamento: { id: 31 } }),
  ]);
  const groups = groupServiceOrders(normalized, serviceOrderStatuses);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, "900");
  assert.equal(groups[0].isEquipmentBased, false);
  assert.equal(groups[1].isEquipmentBased, true);
});

test("all existing question types and required values remain supported", () => {
  const types = ["RADIO", "CHECK", "CHECKBOX", "MIDIA", "MEDIA", "TEXT", "TEXTAREA", "DATA", "DATE", "DATAHORA", "DATETIME"];
  const questions = questionnaire(1, types);
  questions.perguntas[0].obrigatorio = 1;
  questions.perguntas[1].obrigatorio = true;
  questions.perguntas[2].obrigatorio = "2";
  const [normalized] = normalizeServiceOrders(order({ questionario: questions }));
  assert.deepEqual(apiQuestions(normalized).map((question) => question.step), ["radio", "checkbox", "checkbox", "media", "media", "text", "textarea", "date", "date", "datetime", "datetime"]);
  assert.deepEqual(apiQuestions(normalized).slice(0, 4).map((question) => question.required), [true, true, false, true]);
  assert.deepEqual(apiQuestions(normalized)[0].options, [{ id: "8", label: "Sim" }]);
});

test("saved responses are taken only from the selected source, never from answer options", () => {
  const globalAnswers = [{ id_pergunta: 1, resposta: "Global" }];
  const equipmentAnswers = [{ id_pergunta: 1, midias: [{ id: "media-a", url: "https://example.test/a.jpg" }] }];
  const normalized = normalizeServiceOrders(order({ perguntas_respostas: globalAnswers, equipamentos: [
    { id_ordem_servico_equipamento: 1, questionario: questionnaire(1, ["RADIO"]), perguntas_respostas: equipmentAnswers },
    { id_ordem_servico_equipamento: 2, questionario: questionnaire(2, ["RADIO"]) },
  ] }));
  assert.deepEqual(normalized[0].questionnaireResponses, equipmentAnswers);
  assert.equal(normalized[1].questionnaireResponses, undefined);
  assert.deepEqual(normalizeServiceOrders(order({ respostas: globalAnswers }))[0].questionnaireResponses, globalAnswers);
});

test("invalid optional payloads do not prevent the fixed closing flow", () => {
  assert.deepEqual(normalizeServiceOrders(null), []);
  assert.deepEqual(normalizeServiceOrders([null, false, {}, "invalid"]), []);
  const [normalized] = normalizeServiceOrders(order({ equipamentos: "invalid", questionario: { perguntas: [null, {}, { id_pergunta: 7, respostas: null }] } }));
  assert.equal(normalized.closingQuestions.at(-1).required, true);
  assert.equal(apiQuestions(normalized)[0].id, "api-7");
});

test("detail fetch normalizes every equipment, keeps the existing request, and selects explicit IDs", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ sucesso: true, dados: order({ equipamentos: [
      { id_ordem_servico_equipamento: 1, questionario: questionnaire("A") },
      { id_ordem_servico_equipamento: 2, questionario: questionnaire("B") },
    ] }) }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const normalized = await fetchServiceOrderDetailOrders(6, 900);
    assert.equal(normalized.length, 2);
    assert.ok(normalized.every((item) => item.detailsLoaded));
    assert.equal((await fetchServiceOrderDetails(6, 900, 2)).questionnaireId, "B");
    assert.equal(await fetchServiceOrderDetails(6, 900, 99), null);
    assert.ok(requests.every((request) => request.url.endsWith("/buscardadosordemservico.php")));
    assert.deepEqual(requests[0].body, { id_colaborador: 6, id_ordem_servico: 900 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
