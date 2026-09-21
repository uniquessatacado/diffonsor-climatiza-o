import { endpoints } from "../config/endpoints";
import { postJson } from "./api";

export type ClosingQuestionOption = {
  id: string;
  label: string;
};

export type ClosingQuestion = {
  id: string;
  apiQuestionId?: number | string;
  step:
    | "text"
    | "date"
    | "datetime"
    | "media"
    | "checkbox"
    | "radio"
    | "textarea"
    | "responsible"
    | "signature";
  label: string;
  required: boolean;
  options?: ClosingQuestionOption[];
};

export type ServiceOrderEquipment = {
  labelCode: string;
  environment: string;
  brand?: string;
  model: string;
  serialNumber: string;
  clientEquipmentId?: string;
  code?: string;
  installationLocation?: string;
  location?: string;
  address?: string;
  capacityBtus?: string;
  voltage?: string;
  refrigerantGas?: string;
  equipmentType?: string;
  floor?: string;
  observation?: string;
  conditionedArea?: string;
};

export type ServiceOrder = {
  id: string;
  apiId?: string;
  apiOrderCode: string;
  equipmentOrderId?: string;
  originPmoc?: unknown;
  activitiesPmoc?: unknown;
  equipment?: ServiceOrderEquipment;
  number: string;
  client: string;
  clientId?: string;
  address: string;
  service: string;
  serviceId?: string;
  statusId: number;
  status: string;
  statusStartedAt?: string;
  scheduledAt?: string;
  questionnaireId?: string;
  questionnaireTitle?: string;
  questionnaireSource?: "equipment" | "order";
  questionnaireResolved?: boolean;
  detailsLoaded?: boolean;
  questionnaireResponses?: unknown;
  closingQuestions: ClosingQuestion[];
  raw?: unknown;
};

type ApiQuestion = {
  id_pergunta: number | string;
  id_questionario_pergunta?: number | string;
  id?: number | string;
  pergunta: string;
  obrigatorio: string | number | boolean;
  tipo_resposta: string;
  respostas?: Array<{
    id_resposta: number | string;
    resposta: string;
  }>;
};

type ApiQuestionnaireSource = {
  questionario?: {
    id_questionario?: number | string;
    titulo?: string;
    perguntas?: ApiQuestion[];
  } | null;
  questionario_titulo?: string;
  questionario_id?: number | string;
  perguntas_respostas?: unknown;
  respostas?: unknown;
};

type ApiOrder = ApiQuestionnaireSource & {
  id: number | string;
  ordem_servico: number | string;
  id_situacao_ordem_servico: number | string;
  situacao_ordem_descricao: string;
  data_hora_servico?: string;
  data_hora_situacao?: string;
  data_hora_situacao_ordem_servico?: string;
  data_hora_atualizacao_situacao?: string;
  situacao_iniciada_em?: string;
  status_started_at?: string;
  nome_cliente: string;
  id_cliente?: number | string;
  endereco?: string;
  numero?: string;
  bairro?: string;
  complemento?: string | null;
  cidade?: string;
  estado?: string;
  cep?: string;
  id_servico?: number | string;
  nome_servico?: string;
  equipamentos?: ApiOrderEquipment[];
  equipamento?: unknown;
  [key: string]: unknown;
};

type ApiOrderEquipment = ApiQuestionnaireSource & {
  id_ordem_servico_equipamento?: number | string | null;
  id_situacao_ordem_servico?: number | string;
  origem_pmoc?: unknown;
  atividades_pmoc?: unknown;
  equipamento?: unknown;
  servico?: string;
  nome_servico?: string;
  id_servico?: number | string;
  situacao_ordem_descricao?: string;
  codigo_etiqueta?: unknown;
  codigoEtiqueta?: unknown;
  etiqueta?: unknown;
  ambiente?: unknown;
  local_instalacao?: unknown;
  modelo?: unknown;
  modelo_equipamento?: unknown;
  numero_serie?: unknown;
  numeroSerie?: unknown;
  serie?: unknown;
  serial?: unknown;
  [key: string]: unknown;
};

export const serviceOrderStatuses: Record<number, string> = {
  1: "Aguardando atendimento",
  2: "Em deslocamento",
  3: "Atendimento Iniciado",
  4: "Suspenso",
  5: "Finalizado",
  6: "Cancelado",
};

function normalizeStatusId(value: unknown) {
  const statusId = Number(value);

  return serviceOrderStatuses[statusId] ? statusId : 1;
}

function isRequired(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function mapQuestionStep(type: string): ClosingQuestion["step"] {
  const normalized = type.trim().toUpperCase();

  if (normalized === "RADIO") {
    return "radio";
  }

  if (normalized === "CHECK" || normalized === "CHECKBOX") {
    return "checkbox";
  }

  if (normalized === "MIDIA" || normalized === "MEDIA") {
    return "media";
  }

  if (normalized === "TEXTAREA") {
    return "textarea";
  }

  if (normalized === "DATA" || normalized === "DATE") {
    return "date";
  }

  if (normalized === "DATAHORA" || normalized === "DATETIME") {
    return "datetime";
  }

  return "text";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readText(...values: unknown[]) {
  for (const value of values) {
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim();
    }
  }

  return "";
}

function formatAddress(order: Record<string, unknown>) {
  return [
    [readText(order.endereco), readText(order.numero)].filter(Boolean).join(", "),
    readText(order.bairro),
    readText(order.complemento),
    readText(order.ponto_referencia),
    [readText(order.cidade), readText(order.estado)].filter(Boolean).join(" - "),
    readText(order.cep) ? `CEP ${readText(order.cep)}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function parseStatusStartedAt(order: Record<string, unknown>) {
  const source = readText(
    order.data_hora_situacao,
    order.data_hora_situacao_ordem_servico,
    order.data_hora_atualizacao_situacao,
    order.situacao_iniciada_em,
    order.status_started_at,
  );

  if (!source) {
    return undefined;
  }

  const parsed = new Date(source.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeQuestions(source: ApiQuestionnaireSource): ClosingQuestion[] {
  const apiQuestions = Array.isArray(source.questionario?.perguntas) ? source.questionario.perguntas : [];
  const questions: ClosingQuestion[] = apiQuestions.flatMap((question) => {
    if (!asRecord(question)) return [];
    const questionId = readText(question.id_pergunta, question.id_questionario_pergunta, question.id);
    if (!questionId) return [];

    return [{
      id: `api-${questionId}`,
      apiQuestionId: readText(question.id_pergunta)
        ? question.id_pergunta
        : question.id_questionario_pergunta ?? question.id,
      step: mapQuestionStep(readText(question.tipo_resposta)),
      label: readText(question.pergunta),
      required: isRequired(question.obrigatorio),
      options: (Array.isArray(question.respostas) ? question.respostas : []).flatMap((answer) => {
        if (!asRecord(answer) || !readText(answer.id_resposta)) return [];
        return [{ id: readText(answer.id_resposta), label: readText(answer.resposta) }];
      }),
    }];
  });

  return [
    ...questions,
    {
      id: "observacao_servico",
      step: "textarea",
      label: "Observações do serviço",
      required: false,
    },
    {
      id: "responsavel",
      step: "responsible",
      label: "Nome do responsável que acompanhou o serviço",
      required: true,
    },
    {
      id: "assinatura",
      step: "signature",
      label: "Assinatura do responsável",
      required: true,
    },
  ];
}

function readEquipmentText(
  equipment: ApiOrderEquipment,
  keys: string[],
) {
  const nestedEquipment = asRecord(equipment.equipamento);

  for (const key of keys) {
    // The nested equipment is authoritative; blank aliases must not hide its data.
    const value = readText(nestedEquipment?.[key], equipment[key]);
    if (value) return value;
  }

  return "";
}

function normalizeEquipment(equipment: ApiOrderEquipment): ServiceOrderEquipment {
  const addressKeys = ["endereco", "numero", "complemento", "ponto_referencia", "bairro", "cidade", "estado", "cep"];
  const address = formatAddress(Object.fromEntries(addressKeys.map((key) => [key, readEquipmentText(equipment, [key])])));

  return {
    clientEquipmentId: readText(equipment.id_cliente_equipamento, asRecord(equipment.equipamento)?.id) || undefined,
    code: readEquipmentText(equipment, ["codigo", "codigo_equipamento"]),
    labelCode: readEquipmentText(equipment, [
      "codigo_etiqueta",
      "codigoEtiqueta",
      "etiqueta",
      "tag",
      "tag_code",
    ]),
    environment: readEquipmentText(equipment, ["ambiente", "nome_ambiente", "local_instalacao"]),
    brand: readEquipmentText(equipment, ["marca"]),
    model: readEquipmentText(equipment, ["modelo", "modelo_equipamento"]),
    serialNumber: readEquipmentText(equipment, [
      "numero_serie",
      "numeroSerie",
      "serie",
      "serial",
    ]),
    installationLocation: readEquipmentText(equipment, ["local_instalacao"]),
    location: readEquipmentText(equipment, ["local"]),
    address,
    capacityBtus: readEquipmentText(equipment, ["capacidade_btus"]),
    voltage: readEquipmentText(equipment, ["tensao"]),
    refrigerantGas: readEquipmentText(equipment, ["gas_refrigerante"]),
    equipmentType: readEquipmentText(equipment, ["tipo_equipamento"]),
    floor: readEquipmentText(equipment, ["pavimento"]),
    observation: readEquipmentText(equipment, ["observacao"]),
    conditionedArea: readEquipmentText(equipment, ["area_climatizada"]),
  };
}

function getAssignedEquipment(order: ApiOrder): ApiOrderEquipment[] {
  const equipmentItems = Array.isArray(order.equipamentos)
    ? order.equipamentos.filter((item) => Boolean(asRecord(item)))
    : [];
  if (equipmentItems.length) return equipmentItems;

  // Older responses can contain one equipment object instead of equipamentos[].
  const singleEquipment = asRecord(order.equipamento);
  if (singleEquipment && Object.keys(singleEquipment).length) {
    return [{
      ...singleEquipment,
      equipamento: asRecord(singleEquipment.equipamento) ?? singleEquipment,
      id_ordem_servico_equipamento: readText(singleEquipment.id_ordem_servico_equipamento, order.id_ordem_servico_equipamento) || undefined,
      id_cliente_equipamento: readText(singleEquipment.id_cliente_equipamento, order.id_cliente_equipamento) || undefined,
    }];
  }

  const hasFlatEquipment = readText(order.id_ordem_servico_equipamento)
    || (readText(order.id_cliente_equipamento) && Number(order.id_cliente_equipamento) !== 0)
    || ["codigo_etiqueta", "codigoEtiqueta", "modelo_equipamento", "numero_serie", "numeroSerie"].some((key) => readText(order[key]));
  if (!hasFlatEquipment) return [];

  // Flattened legacy equipment metadata must never import the OS questionnaire.
  const {
    id: _orderId,
    questionario: _orderQuestionnaire,
    questionario_id: _orderQuestionnaireId,
    questionario_titulo: _orderQuestionnaireTitle,
    perguntas_respostas: _orderAnswers,
    respostas: _orderResponses,
    equipamento: _equipment,
    equipamentos: _equipmentItems,
    ...flatEquipment
  } = order;
  return [flatEquipment as ApiOrderEquipment];
}

function getEquipmentQuestionnaireSource(equipment: ApiOrderEquipment): ApiQuestionnaireSource {
  const nestedEquipment = asRecord(equipment.equipamento);
  if (equipment.questionario !== undefined || equipment.questionario_id !== undefined || !nestedEquipment) {
    return equipment;
  }
  return nestedEquipment.questionario !== undefined || nestedEquipment.questionario_id !== undefined
    ? nestedEquipment as ApiQuestionnaireSource
    : equipment;
}

function normalizeServiceOrder(
  order: ApiOrder,
  equipment: ApiOrderEquipment | undefined,
  detailsLoaded: boolean,
  legacyEquipmentKey?: string,
): ServiceOrder {
  const equipmentOrderId = readText(equipment?.id_ordem_servico_equipamento) || undefined;
  const statusId = normalizeStatusId(readText(equipment?.id_situacao_ordem_servico, order.id_situacao_ordem_servico));
  // Existence of equipment, including a single legacy equipment, determines ownership.
  const questionnaireSource = equipment ? getEquipmentQuestionnaireSource(equipment) : order;
  const questionnaireId = readText(questionnaireSource.questionario?.id_questionario, questionnaireSource.questionario_id);
  const questionnaireTitle = readText(questionnaireSource.questionario?.titulo, questionnaireSource.questionario_titulo);
  const questionnaireResponses = equipment?.perguntas_respostas ?? equipment?.respostas
    ?? questionnaireSource.perguntas_respostas ?? questionnaireSource.respostas;
  const apiId = readText(order.id, order.ordem_servico);
  const apiOrderCode = readText(order.ordem_servico, order.id);
  const normalizedEquipment = equipment ? normalizeEquipment(equipment) : undefined;
  const itemId = equipmentOrderId
    ? `${apiId}-equipamento-${equipmentOrderId}`
    : legacyEquipmentKey !== undefined
      ? `${apiId}-equipamento-legado-${legacyEquipmentKey}`
      : apiId;

  return {
    id: itemId,
    apiId,
    apiOrderCode,
    equipmentOrderId,
    ...(normalizedEquipment ? { equipment: normalizedEquipment } : {}),
    ...(equipment && Object.prototype.hasOwnProperty.call(equipment, "origem_pmoc")
      ? { originPmoc: equipment.origem_pmoc }
      : {}),
    ...(equipment && Object.prototype.hasOwnProperty.call(equipment, "atividades_pmoc")
      ? { activitiesPmoc: equipment.atividades_pmoc }
      : {}),
    number: `OS-${apiOrderCode}`,
    client: readText(order.nome_cliente) || "Cliente não informado",
    clientId: readText(order.id_cliente) || undefined,
    address: formatAddress(order) || "Endereço não informado",
    service: readText(equipment?.nome_servico, equipment?.servico, order.nome_servico, order.servico) || "Serviço não informado",
    serviceId: readText(equipment?.id_servico, order.id_servico) || undefined,
    statusId,
    status: equipment
      ? readText(equipment.situacao_ordem_descricao) || serviceOrderStatuses[statusId]
      : readText(order.situacao_ordem_descricao) || serviceOrderStatuses[statusId],
    statusStartedAt: (equipment ? parseStatusStartedAt(equipment) : undefined) ?? parseStatusStartedAt(order),
    scheduledAt: readText(equipment?.data_hora_servico)
      || [readText(equipment?.data_servico), readText(equipment?.hora_servico)].filter(Boolean).join(" ")
      || readText(order.data_hora_servico) || undefined,
    questionnaireId: questionnaireId || undefined,
    questionnaireTitle: questionnaireTitle || undefined,
    questionnaireSource: equipment ? "equipment" : "order",
    questionnaireResolved: detailsLoaded,
    detailsLoaded,
    questionnaireResponses: Array.isArray(questionnaireResponses) ? questionnaireResponses : undefined,
    closingQuestions: normalizeQuestions(questionnaireSource),
    raw: order,
  };
}

export function normalizeServiceOrders(
  data: unknown,
  options: { detailsLoaded?: boolean } = {},
): ServiceOrder[] {
  const list = Array.isArray(data) ? data : asRecord(data) ? [data] : [];

  return list.flatMap((item) => {
    if (!asRecord(item)) return [];
    const order = item as ApiOrder;
    if (!readText(order.id, order.ordem_servico)) return [];
    const assignedEquipment = getAssignedEquipment(order);

    if (assignedEquipment.length === 0) {
      return [normalizeServiceOrder(order, undefined, options.detailsLoaded === true)];
    }

    const legacyEquipmentIds = assignedEquipment.map((equipment) => readText(equipment.id_ordem_servico_equipamento)
      ? ""
      : readText(equipment.id_cliente_equipamento, asRecord(equipment.equipamento)?.id));
    return assignedEquipment.map((equipment, index) => {
      const clientEquipmentId = legacyEquipmentIds[index];
      const duplicated = clientEquipmentId && legacyEquipmentIds.filter((id) => id === clientEquipmentId).length > 1;
      const legacyEquipmentKey = clientEquipmentId
        ? `${clientEquipmentId}${duplicated ? `-item-${index}` : ""}`
        : `indice-${index}`;
      return normalizeServiceOrder(order, equipment, options.detailsLoaded === true,
        assignedEquipment.length > 1 ? legacyEquipmentKey : undefined);
    });
  });
}

export async function fetchServiceOrders(idColaborador: string | number): Promise<ServiceOrder[]> {
  const response = await postJson<ApiOrder[]>(endpoints.serviceOrdersUrl, {
    id_colaborador: idColaborador,
  });

  return normalizeServiceOrders(response.dados);
}

export async function fetchServiceOrderDetails(
  idColaborador: string | number,
  idOrdemServico: string | number,
  idOrdemServicoEquipamento?: string | number,
): Promise<ServiceOrder | null> {
  const orders = await fetchServiceOrderDetailOrders(idColaborador, idOrdemServico);

  if (idOrdemServicoEquipamento !== undefined) {
    const equipmentOrderId = String(idOrdemServicoEquipamento);
    return orders.find((order) => order.equipmentOrderId === equipmentOrderId) ?? null;
  }

  return orders[0] ?? null;
}

export async function fetchServiceOrderDetailOrders(
  idColaborador: string | number,
  idOrdemServico: string | number,
): Promise<ServiceOrder[]> {
  const response = await postJson<ApiOrder | ApiOrder[]>(endpoints.serviceOrderDetailsUrl, {
    id_colaborador: idColaborador,
    id_ordem_servico: idOrdemServico,
  });
  return normalizeServiceOrders(response.dados, { detailsLoaded: true });
}

export function getTestServiceOrders(): ServiceOrder[] {
  return [
    {
      id: "teste-1",
      apiOrderCode: "1",
      number: "OS-TESTE",
      client: "Cliente de teste",
      clientId: "teste",
      address: "Endereço do serviço de teste",
      service: "Serviço de climatização",
      serviceId: "teste",
      statusId: 1,
      status: serviceOrderStatuses[1],
      statusStartedAt: new Date().toISOString(),
      scheduledAt: "Hoje",
      questionnaireId: "teste",
      questionnaireTitle: "Questionário de teste",
      closingQuestions: [
        {
          id: "api-teste-texto",
          apiQuestionId: "teste-texto",
          step: "text",
          label: "Descreva o serviço realizado",
          required: true,
        },
        {
          id: "api-teste-midia",
          apiQuestionId: "teste-midia",
          step: "media",
          label: "Adicionar fotos ou mídias do atendimento",
          required: false,
        },
        {
          id: "api-teste-check",
          apiQuestionId: "teste-check",
          step: "checkbox",
          label: "Quais testes foram realizados?",
          required: true,
          options: [
            { id: "1", label: "Teste de funcionamento" },
            { id: "2", label: "Teste de refrigeração" },
            { id: "3", label: "Teste de drenagem" },
          ],
        },
        {
          id: "api-teste-radio",
          apiQuestionId: "teste-radio",
          step: "radio",
          label: "O cliente aprovou o serviço?",
          required: true,
          options: [
            { id: "1", label: "Sim" },
            { id: "2", label: "Não" },
          ],
        },
        {
          id: "observacao_servico",
          step: "textarea",
          label: "Observações finais",
          required: false,
        },
        {
          id: "responsavel",
          step: "responsible",
          label: "Nome do responsável que acompanhou o serviço",
          required: true,
        },
        {
          id: "assinatura",
          step: "signature",
          label: "Assinatura do responsável",
          required: true,
        },
      ],
      raw: { teste: true },
    },
  ];
}

export async function fetchClosingQuestions(order?: ServiceOrder): Promise<ClosingQuestion[]> {
  return order?.closingQuestions ?? [];
}
