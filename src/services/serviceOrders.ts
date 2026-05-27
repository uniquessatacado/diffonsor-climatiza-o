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

export type ServiceOrder = {
  id: string;
  apiOrderCode: string;
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
  closingQuestions: ClosingQuestion[];
  raw?: unknown;
};

type ApiQuestion = {
  id_pergunta: number | string;
  pergunta: string;
  obrigatorio: string | number | boolean;
  tipo_resposta: string;
  respostas?: Array<{
    id_resposta: number | string;
    resposta: string;
  }>;
};

type ApiOrder = {
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
  questionario?: {
    id_questionario?: number | string;
    titulo?: string;
    perguntas?: ApiQuestion[];
  };
  questionario_titulo?: string;
  questionario_id?: number | string;
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

function formatAddress(order: ApiOrder) {
  return [
    [order.endereco, order.numero].filter(Boolean).join(", "),
    order.bairro,
    order.complemento,
    [order.cidade, order.estado].filter(Boolean).join(" - "),
    order.cep ? `CEP ${order.cep}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function parseStatusStartedAt(order: ApiOrder) {
  const source =
    order.data_hora_situacao ??
    order.data_hora_situacao_ordem_servico ??
    order.data_hora_atualizacao_situacao ??
    order.situacao_iniciada_em ??
    order.status_started_at;

  if (!source) {
    return undefined;
  }

  const parsed = new Date(source.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeQuestions(order: ApiOrder): ClosingQuestion[] {
  const apiQuestions = order.questionario?.perguntas ?? [];
  const questions = apiQuestions.map((question) => ({
    id: `api-${question.id_pergunta}`,
    apiQuestionId: question.id_pergunta,
    step: mapQuestionStep(question.tipo_resposta),
    label: question.pergunta,
    required: isRequired(question.obrigatorio),
    options: (question.respostas ?? []).map((answer) => ({
      id: String(answer.id_resposta),
      label: answer.resposta,
    })),
  }));

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

function normalizeServiceOrders(data: unknown): ServiceOrder[] {
  const list = Array.isArray(data) ? data : [];

  return list.map((item) => {
    const order = item as ApiOrder;
    const statusId = normalizeStatusId(order.id_situacao_ordem_servico);
    const questionnaireId = order.questionario?.id_questionario ?? order.questionario_id;
    const questionnaireTitle = order.questionario?.titulo ?? order.questionario_titulo;

    return {
      id: String(order.id),
      apiOrderCode: String(order.ordem_servico),
      number: `OS-${order.ordem_servico}`,
      client: order.nome_cliente ?? "Cliente não informado",
      clientId: order.id_cliente ? String(order.id_cliente) : undefined,
      address: formatAddress(order) || "Endereço não informado",
      service: order.nome_servico ?? "Serviço não informado",
      serviceId: order.id_servico ? String(order.id_servico) : undefined,
      statusId,
      status: order.situacao_ordem_descricao || serviceOrderStatuses[statusId],
      statusStartedAt: parseStatusStartedAt(order),
      scheduledAt: order.data_hora_servico,
      questionnaireId: questionnaireId ? String(questionnaireId) : undefined,
      questionnaireTitle: questionnaireTitle ? String(questionnaireTitle) : undefined,
      closingQuestions: normalizeQuestions(order),
      raw: order,
    };
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
): Promise<ServiceOrder | null> {
  const response = await postJson<ApiOrder | ApiOrder[]>(endpoints.serviceOrderDetailsUrl, {
    id_colaborador: idColaborador,
    id_ordem_servico: idOrdemServico,
  });
  const data = Array.isArray(response.dados) ? response.dados[0] : response.dados;

  return data ? normalizeServiceOrders([data])[0] : null;
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
