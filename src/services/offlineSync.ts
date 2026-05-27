import { Capacitor } from "@capacitor/core";
import { apiAuthorizationToken, endpoints } from "../config/endpoints";
import { isConnectionFailure, isDeviceOnline } from "./connectivity";

const dbName = "diffonso-offline";
const dbVersion = 3;
const queueStore = "queue";
const settingsStore = "settings";
const mediaStore = "media";
const ordersStore = "orders";
const syncTag = "diffonso-sync";
const maxNativeMediaBytes = 12 * 1024 * 1024;

export type OfflineActionType = "status_change" | "suspend_order" | "finish_order";

export type OfflineAction = {
  id: string;
  type: OfflineActionType;
  orderId: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
};

type StoredMediaRecord = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  blob: Blob;
};

type SyncResult = {
  ok: boolean;
  missingUrl?: boolean;
  error?: string;
};

export type PendingActionSummary = {
  id: string;
  type: OfflineActionType;
  orderId: string;
  orderCode: string;
  createdAt: string;
  attempts: number;
};

function createLocalId() {
  const randomPart =
    typeof crypto !== "undefined" && "getRandomValues" in crypto
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)))
          .map((value) => value.toString(36))
          .join("")
      : Math.random().toString(36).slice(2);

  return `${Date.now()}-${randomPart}`;
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(queueStore)) {
        db.createObjectStore(queueStore, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(settingsStore)) {
        db.createObjectStore(settingsStore, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(mediaStore)) {
        db.createObjectStore(mediaStore, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(ordersStore)) {
        db.createObjectStore(ordersStore, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readQueue() {
  const db = await openDb();

  return new Promise<OfflineAction[]>((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readonly");
    const request = transaction.objectStore(queueStore).getAll();

    request.onsuccess = () => resolve(request.result as OfflineAction[]);
    request.onerror = () => reject(request.error);
  });
}

async function putAction(action: OfflineAction) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readwrite");
    transaction.objectStore(queueStore).put(action);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function deleteAction(actionId: string) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readwrite");
    transaction.objectStore(queueStore).delete(actionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function getPayloadValue(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const value = (payload as Record<string, unknown>)[key];
  return value == null ? "" : String(value);
}

function isAlreadyAppliedError(message: string) {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("igual a que deseja alterar") ||
    normalized.includes("não permite mais atualização") ||
    normalized.includes("nao permite mais atualizacao") ||
    normalized.includes("ordem de serviço não permite") ||
    normalized.includes("ordem de servico nao permite")
  );
}

function summarizeAction(action: OfflineAction): PendingActionSummary {
  return {
    id: action.id,
    type: action.type,
    orderId: action.orderId,
    orderCode: getPayloadValue(action.payload, "id_ordem_servico") || action.orderId,
    createdAt: action.createdAt,
    attempts: action.attempts,
  };
}

async function saveSetting(key: string, value: string) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(settingsStore, "readwrite");
    transaction.objectStore(settingsStore).put({ key, value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getMedia(id: string) {
  const db = await openDb();

  return new Promise<StoredMediaRecord | null>((resolve, reject) => {
    const transaction = db.transaction(mediaStore, "readonly");
    const request = transaction.objectStore(mediaStore).get(id);

    request.onsuccess = () => resolve((request.result as StoredMediaRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

function collectMediaRefs(
  value: unknown,
  refs = new Map<string, { id: string; name: string; questionId?: unknown; questionLabel?: unknown }>(),
  context: { questionId?: unknown; questionLabel?: unknown } = {},
) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaRefs(item, refs, context));
    return refs;
  }

  if (!value || typeof value !== "object") {
    return refs;
  }

  const record = value as Record<string, unknown>;
  const nextContext = {
    questionId: record.id_pergunta ?? context.questionId,
    questionLabel: record.pergunta ?? context.questionLabel,
  };

  if (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.size === "number"
  ) {
    refs.set(record.id, {
      id: record.id,
      name: record.name,
      questionId: record.id_pergunta ?? nextContext.questionId,
      questionLabel: record.pergunta ?? nextContext.questionLabel,
    });
  }

  Object.values(record).forEach((item) => collectMediaRefs(item, refs, nextContext));
  return refs;
}

function dataUrlToBlob(dataUrl: string) {
  const [metadata, base64Data] = dataUrl.split(",");

  if (!metadata || !base64Data) {
    return null;
  }

  const mimeMatch = metadata.match(/data:(.*?);base64/);
  const mimeType = mimeMatch?.[1] || "image/png";
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function blobToDataUrl(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

async function buildMediaPayloads(mediaRefs: Array<{ id: string; name: string; questionId?: unknown; questionLabel?: unknown }>) {
  const mediaPayloads = [];

  for (const mediaRef of mediaRefs) {
    const media = await getMedia(mediaRef.id);

    if (!media) {
      continue;
    }

    mediaPayloads.push({
      id: media.id,
      id_pergunta: mediaRef.questionId ?? "",
      pergunta: mediaRef.questionLabel ?? "",
      nome: media.name,
      name: media.name,
      tipo: media.type,
      type: media.type,
      tamanho: media.size,
      size: media.size,
      createdAt: media.createdAt,
      base64: await blobToDataUrl(media.blob),
    });
  }

  return mediaPayloads;
}

function attachMediaPayloads(value: unknown, mediaById: Map<string, Record<string, unknown>>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => attachMediaPayloads(item, mediaById));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const next = Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, attachMediaPayloads(item, mediaById)]),
  );

  if (typeof record.id === "string" && mediaById.has(record.id)) {
    return {
      ...next,
      ...mediaById.get(record.id),
    };
  }

  return next;
}

async function registerBackgroundSync() {
  if (Capacitor.isNativePlatform() || !("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const syncRegistration = registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };

    await syncRegistration.sync?.register(syncTag);
  } catch {
    // Some browsers do not support Background Sync; online events still sync while the app is open.
  }
}

export async function setupOfflineSync() {
  await saveSetting("syncUrl", endpoints.syncUrl);
  await saveSetting("changeOrderStatusUrl", endpoints.changeOrderStatusUrl);
  await saveSetting("finishOrderUrl", endpoints.finishOrderUrl);
  await saveSetting("authorization", apiAuthorizationToken);

  if (Capacitor.isNativePlatform()) {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    return;
  }

  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.register("/sw.js");
    await registration.update();
  }

  await registerBackgroundSync();
}

export async function getPendingActionsCount() {
  return (await readQueue()).length;
}

export async function getPendingActions() {
  return (await readQueue()).map(summarizeAction);
}

export async function deletePendingAction(actionId: string) {
  await deleteAction(actionId);
}

export async function clearPendingActions() {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readwrite");
    transaction.objectStore(queueStore).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function deleteStatusActionsForOrder(orderCode: string) {
  const queue = await readQueue();

  await Promise.all(
    queue
      .filter((action) => {
        const actionOrderCode = getPayloadValue(action.payload, "id_ordem_servico") || action.orderId;
        return action.type === "status_change" && String(actionOrderCode) === String(orderCode);
      })
      .map((action) => deleteAction(action.id)),
  );
}

export async function saveCachedOrders<T>(key: string, orders: T[]) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ordersStore, "readwrite");
    transaction.objectStore(ordersStore).put({
      key,
      orders,
      updatedAt: new Date().toISOString(),
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function readCachedOrders<T>(key: string) {
  const db = await openDb();

  return new Promise<{ orders: T[]; updatedAt?: string } | null>((resolve, reject) => {
    const transaction = db.transaction(ordersStore, "readonly");
    const request = transaction.objectStore(ordersStore).get(key);

    request.onsuccess = () => {
      const result = request.result as { orders?: T[]; updatedAt?: string } | undefined;
      resolve(result?.orders ? { orders: result.orders, updatedAt: result.updatedAt } : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function enqueueOfflineAction(
  type: OfflineActionType,
  orderId: string,
  payload: unknown,
) {
  const action: OfflineAction = {
    id: createLocalId(),
    type,
    orderId,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };

  await putAction(action);
  await registerBackgroundSync();
  return action;
}

async function postAction(action: OfflineAction) {
  if (action.type === "status_change" || action.type === "suspend_order") {
    const payload = action.payload as Record<string, unknown>;

    if (
      !payload ||
      !payload.id_colaborador ||
      !payload.id_ordem_servico ||
      !payload.id_situacao_ordem_servico
    ) {
      return { ok: true };
    }

    const response = await fetch(endpoints.changeOrderStatusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: apiAuthorizationToken,
      },
      body: JSON.stringify(payload),
    });

    let data: { sucesso?: boolean | number | string; success?: boolean | number | string; mensagem?: string; message?: string; dados?: unknown } = {};

    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        error: `A API de status respondeu, mas nao retornou JSON valido. URL: ${endpoints.changeOrderStatusUrl}`,
      };
    }

    const successValue = data.sucesso ?? data.success;
    const ok = response.ok && (successValue === true || successValue === 1 || successValue === "1" || successValue === "true");

    if (!ok) {
      const error =
        typeof data.dados === "string"
          ? data.dados
          : data.mensagem ?? data.message ?? "Nao foi possivel mudar a situacao da ordem.";

      if (isAlreadyAppliedError(error)) {
        return { ok: true };
      }

      return { ok: false, error: `OS ${payload.id_ordem_servico}: ${error}` };
    }

    return { ok: true };
  }

  const targetUrl = action.type === "finish_order" ? endpoints.finishOrderUrl : endpoints.syncUrl;

  if (!targetUrl) {
    return { ok: false, missingUrl: true };
  }

  const formData = new FormData();
  const mediaRefs = Array.from(collectMediaRefs(action.payload).values());
  const fileMeta: Array<Record<string, unknown>> = [];
  const payload = action.payload as Record<string, unknown>;
  let nativeMediaBytes = 0;

  formData.append("dados", JSON.stringify(payload));
  formData.append("finalizacao", JSON.stringify(payload));

  Object.entries(payload).forEach(([key, value]) => {
    if (key !== "assinatura" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      formData.append(key, String(value));
    }
  });

  const signature = payload.assinatura;

  if (typeof signature === "string" && signature.startsWith("data:image/")) {
    const signatureBlob = dataUrlToBlob(signature);

    if (signatureBlob) {
      formData.append("assinatura", signatureBlob, "assinatura.png");
      formData.append(
        "assinaturaMeta",
        JSON.stringify({
          campo: "assinatura",
          id: "assinatura",
          nome: "assinatura.png",
          tipo: signatureBlob.type,
          tamanho: signatureBlob.size,
        }),
      );
      formData.append(
        "fileMetaAssinatura",
        JSON.stringify({
        campo: "assinatura",
        id: "assinatura",
        nome: "assinatura.png",
        tipo: signatureBlob.type,
        tamanho: signatureBlob.size,
        }),
      );
    }
  }

  for (const [index, mediaRef] of mediaRefs.entries()) {
    const media = await getMedia(mediaRef.id);

    if (!media) {
      continue;
    }

    nativeMediaBytes += media.size;

    if (Capacitor.isNativePlatform() && nativeMediaBytes > maxNativeMediaBytes) {
      return {
        ok: false,
        error: `OS ${payload.id_ordem_servico ?? action.orderId}: as midias passam do limite seguro de 12 MB para envio no celular. Exclua a pendencia e finalize novamente com menos anexos.`,
      };
    }

    formData.append("midias[]", media.blob, media.name);
    formData.append("files[]", media.blob, media.name);
    fileMeta.push({
      campo: "midias",
      indice: index,
      id: media.id,
      id_pergunta: mediaRef.questionId ?? "",
      pergunta: mediaRef.questionLabel ?? "",
      nome: media.name,
      tipo: media.type,
      tamanho: media.size,
      createdAt: media.createdAt,
    });
  }

  formData.append("fileMeta", JSON.stringify(fileMeta));

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: apiAuthorizationToken,
    },
    body: formData,
  });

  let data: { sucesso?: boolean | number | string; success?: boolean | number | string; mensagem?: string; message?: string; dados?: unknown } = {};

  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      error: `A API respondeu, mas nao retornou JSON valido. URL: ${targetUrl}`,
    };
  }

  const successValue = data.sucesso ?? data.success;
  const ok = response.ok && (successValue === true || successValue === 1 || successValue === "1" || successValue === "true");

  if (!ok) {
    const error =
      typeof data.dados === "string"
        ? data.dados
        : data.mensagem ?? data.message ?? "Nao foi possivel finalizar a ordem de servico.";

    if (action.type === "finish_order" && error.toLowerCase().includes("json inválido")) {
      if (Capacitor.isNativePlatform()) {
        return {
          ok: false,
          error: `OS ${payload.id_ordem_servico ?? action.orderId}: ${error}. O reenvio em JSON foi bloqueado para proteger a memoria do aparelho.`,
        };
      }

      const mediaPayloads = await buildMediaPayloads(mediaRefs);
      const mediaById = new Map(mediaPayloads.map((media) => [String(media.id), media]));
      const payloadWithMedia = {
        ...(attachMediaPayloads(payload, mediaById) as Record<string, unknown>),
        midias: mediaPayloads,
      };
      const jsonResponse = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: apiAuthorizationToken,
        },
        body: JSON.stringify(payloadWithMedia),
      });

      let jsonData: { sucesso?: boolean | number | string; success?: boolean | number | string; mensagem?: string; message?: string; dados?: unknown } = {};

      try {
        jsonData = await jsonResponse.json();
      } catch {
        return {
          ok: false,
          error: `OS ${payload.id_ordem_servico ?? action.orderId}: A API respondeu, mas nao retornou JSON valido. URL: ${targetUrl}`,
        };
      }

      const jsonSuccessValue = jsonData.sucesso ?? jsonData.success;
      const jsonOk = jsonResponse.ok && (jsonSuccessValue === true || jsonSuccessValue === 1 || jsonSuccessValue === "1" || jsonSuccessValue === "true");

      if (jsonOk) {
        return { ok: true };
      }

      const jsonError =
        typeof jsonData.dados === "string"
          ? jsonData.dados
          : jsonData.mensagem ?? jsonData.message ?? error;

      return { ok: false, error: `OS ${payload.id_ordem_servico ?? action.orderId}: ${jsonError}` };
    }

    if (isAlreadyAppliedError(error)) {
      return { ok: true };
    }

    return { ok: false, error: `OS ${payload.id_ordem_servico ?? action.orderId}: ${error}` };
  }

  if (action.type === "finish_order") {
    await deleteStatusActionsForOrder(String(payload.id_ordem_servico ?? action.orderId));
  }

  return { ok: true };
}

export async function syncPendingActions() {
  if (!(await isDeviceOnline())) {
    return {
      synced: 0,
      pending: await getPendingActionsCount(),
      missingUrl: false,
      error: "",
      offline: true,
    };
  }

  const queue = await readQueue();
  let synced = 0;
  let missingUrl = false;
  let error = "";

  for (const action of queue) {
    try {
      const result: SyncResult = await postAction(action);

      if (result.ok) {
        await deleteAction(action.id);
        synced += 1;
      } else {
        missingUrl = missingUrl || Boolean(result.missingUrl);
        error ||= result.error ?? "";
        await putAction({ ...action, attempts: action.attempts + 1 });
      }
    } catch (syncError) {
      if (isConnectionFailure(syncError) || !(await isDeviceOnline())) {
        return {
          synced,
          pending: await getPendingActionsCount(),
          missingUrl,
          error: "",
          offline: true,
        };
      }

      const orderCode = getPayloadValue(action.payload, "id_ordem_servico") || action.orderId;
      error ||= `OS ${orderCode}: ${syncError instanceof Error ? syncError.message : "Nao foi possivel sincronizar esta pendencia."}`;
      await putAction({ ...action, attempts: action.attempts + 1 });
    }
  }

  return {
    synced,
    pending: await getPendingActionsCount(),
    missingUrl,
    error,
    offline: false,
  };
}
