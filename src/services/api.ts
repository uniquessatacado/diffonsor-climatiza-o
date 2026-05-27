import { apiAuthorizationToken } from "../config/endpoints";

type ApiEnvelope<T> = {
  sucesso?: boolean | number | string;
  success?: boolean | number | string;
  mensagem?: string;
  message?: string;
  dados?: T;
  data?: T;
};

export class ApiError extends Error {
  data: unknown;
  isNetworkFailure: boolean;

  constructor(message: string, data?: unknown, isNetworkFailure = false) {
    super(message);
    this.name = "ApiError";
    this.data = data;
    this.isNetworkFailure = isNetworkFailure;
  }
}

function isSuccessful(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function readEnvelopeMessage(envelope: ApiEnvelope<unknown>) {
  if (typeof envelope.dados === "string") {
    return envelope.dados;
  }

  if (
    envelope.dados &&
    typeof envelope.dados === "object" &&
    "mensagem" in envelope.dados
  ) {
    return String((envelope.dados as { mensagem: unknown }).mensagem);
  }

  const message = envelope.mensagem ?? envelope.message;

  if (message) {
    return String(message);
  }

  return "Nao foi possivel concluir a solicitacao.";
}

function getApiUrlForMessage(url: string) {
  if (url.startsWith("/api/")) {
    return `https://api.diffonsoclimatizacao.com${url.replace(/^\/api/, "")}`;
  }

  return url;
}

function getNetworkErrorMessage(url: string) {
  return `Nao houve resposta da API. Verifique a internet ou a liberacao de acesso da URL: ${getApiUrlForMessage(url)}`;
}

export async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<ApiEnvelope<T> & { dados: T }> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: apiAuthorizationToken,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(getNetworkErrorMessage(url), { url: getApiUrlForMessage(url) }, true);
  }

  let data: ApiEnvelope<T>;

  try {
    data = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(
      `A API respondeu, mas nao retornou um JSON valido. URL: ${getApiUrlForMessage(url)}`,
      { url: getApiUrlForMessage(url), status: response.status },
    );
  }

  const successValue = data.sucesso ?? data.success;

  if (!response.ok || !isSuccessful(successValue)) {
    throw new ApiError(readEnvelopeMessage(data), data.dados ?? data.data ?? data);
  }

  return {
    ...data,
    dados: (data.dados ?? data.data) as T,
  };
}

export function isApiNetworkError(error: unknown) {
  return error instanceof ApiError && error.isNetworkFailure;
}

export function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message === "Failed to fetch"
      ? "Nao houve resposta da API. Verifique a internet ou tente novamente."
      : error.message;
  }

  return "Erro inesperado.";
}
