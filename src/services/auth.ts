import { endpoints } from "../config/endpoints";
import { ApiError, getErrorMessage, isApiNetworkError, postJson } from "./api";
import { isDeviceOnline } from "./connectivity";

export type LoginPayload = {
  email: string;
  password: string;
};

export type LoginUser = {
  id: number | string;
  nome: string;
  email: string;
};

export type LoginResult = {
  ok: boolean;
  message: string;
  data?: LoginUser | unknown;
  offline?: boolean;
};

const testLogin = {
  email: import.meta.env.VITE_TEST_LOGIN_EMAIL?.trim().toLowerCase() ?? "",
  password: import.meta.env.VITE_TEST_LOGIN_PASSWORD ?? "",
};
const offlineLoginKeyPrefix = "diffonso.offlineLogin.";

type OfflineLogin = {
  credentialHash: string;
  data: LoginUser;
};

async function hashCredential(email: string, password: string) {
  const value = new TextEncoder().encode(`${email.trim().toLowerCase()}\n${password}`);
  const digest = await crypto.subtle.digest("SHA-256", value);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getOfflineLoginKey(email: string) {
  return `${offlineLoginKeyPrefix}${email.trim().toLowerCase()}`;
}

async function saveOfflineLogin(email: string, password: string, data: LoginUser) {
  try {
    const storedLogin: OfflineLogin = {
      credentialHash: await hashCredential(email, password),
      data,
    };

    localStorage.setItem(getOfflineLoginKey(email), JSON.stringify(storedLogin));
  } catch {
    // Online access still succeeds if local offline storage is unavailable.
  }
}

async function loginFromDevice(payload: LoginPayload): Promise<LoginResult> {
  try {
    const serialized = localStorage.getItem(getOfflineLoginKey(payload.email));

    if (!serialized) {
      return {
        ok: false,
        offline: true,
        message: "Offline. Entre online uma vez neste aparelho.",
      };
    }

    const storedLogin = JSON.parse(serialized) as OfflineLogin;
    const credentialHash = await hashCredential(payload.email, payload.password);

    if (storedLogin.credentialHash !== credentialHash) {
      return {
        ok: false,
        offline: true,
        message: "Offline. Login ou senha não conferem.",
      };
    }

    return {
      ok: true,
      offline: true,
      message: "Acesso offline liberado.",
      data: storedLogin.data,
    };
  } catch {
    return {
      ok: false,
      offline: true,
      message: "Offline. Entre online uma vez neste aparelho.",
    };
  }
}

export async function login(payload: LoginPayload): Promise<LoginResult> {
  if (
    testLogin.email &&
    testLogin.password &&
    payload.email.trim().toLowerCase() === testLogin.email &&
    payload.password === testLogin.password
  ) {
    return {
      ok: true,
      message: "Acesso de teste liberado.",
      data: {
        email: testLogin.email,
        id: "teste",
        isTestUser: true,
        nome: "Usuário teste",
      },
    };
  }

  if (!(await isDeviceOnline())) {
    return loginFromDevice(payload);
  }

  try {
    const response = await postJson<{ nome: string; id: number | string }>(endpoints.authUrl, {
      email: payload.email.trim(),
      senha: payload.password,
    });
    const data = {
      ...response.dados,
      email: payload.email.trim(),
    };

    await saveOfflineLogin(payload.email, payload.password, data);

    return {
      ok: true,
      message: response.mensagem ?? "Login realizado com sucesso.",
      data,
    };
  } catch (error) {
    if (isApiNetworkError(error)) {
      return loginFromDevice(payload);
    }

    return {
      ok: false,
      message: getErrorMessage(error),
      data: error instanceof ApiError ? error.data : undefined,
    };
  }
}

export function isTestLoginEmail(email: string) {
  return Boolean(testLogin.email) && email.trim().toLowerCase() === testLogin.email;
}

export async function requestPasswordReset(email: string): Promise<LoginResult> {
  if (!(await isDeviceOnline())) {
    return {
      ok: false,
      offline: true,
      message: "Offline. Reconecte para recuperar a senha.",
    };
  }

  try {
    const response = await postJson<unknown>(endpoints.forgotPasswordUrl, {
      email: email.trim(),
    });

    return {
      ok: true,
      message: response.mensagem ?? "Solicitação enviada.",
      data: response.dados,
    };
  } catch (error) {
    if (isApiNetworkError(error)) {
      return {
        ok: false,
        offline: true,
        message: "Offline. Reconecte para recuperar a senha.",
      };
    }

    return {
      ok: false,
      message: getErrorMessage(error),
      data: error instanceof ApiError ? error.data : undefined,
    };
  }
}
