const dbName = "diffonso-offline";
const dbVersion = 3;
const queueStore = "queue";
const settingsStore = "settings";
const mediaStore = "media";
const ordersStore = "orders";
const syncTag = "diffonso-sync";

function openDb() {
  return new Promise((resolve, reject) => {
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

async function getAllActions() {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readonly");
    const request = transaction.objectStore(queueStore).getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSetting(key) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(settingsStore, "readonly");
    const request = transaction.objectStore(settingsStore).get(key);

    request.onsuccess = () => resolve(request.result?.value ?? "");
    request.onerror = () => reject(request.error);
  });
}

async function putAction(action) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readwrite");
    transaction.objectStore(queueStore).put(action);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function deleteAction(actionId) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(queueStore, "readwrite");
    transaction.objectStore(queueStore).delete(actionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function getPayloadValue(payload, key) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const value = payload[key];
  return value == null ? "" : String(value);
}

function isAlreadyAppliedError(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("igual a que deseja alterar") ||
    normalized.includes("não permite mais atualização") ||
    normalized.includes("nao permite mais atualizacao") ||
    normalized.includes("ordem de serviço não permite") ||
    normalized.includes("ordem de servico nao permite")
  );
}

async function deleteStatusActionsForOrder(orderCode) {
  const actions = await getAllActions();

  await Promise.all(
    actions
      .filter((action) => {
        const actionOrderCode = getPayloadValue(action.payload, "id_ordem_servico") || action.orderId;
        return action.type === "status_change" && String(actionOrderCode) === String(orderCode);
      })
      .map((action) => deleteAction(action.id)),
  );
}

async function getMedia(id) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(mediaStore, "readonly");
    const request = transaction.objectStore(mediaStore).get(id);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function collectMediaRefs(value, refs = new Map(), context = {}) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaRefs(item, refs, context));
    return refs;
  }

  if (!value || typeof value !== "object") {
    return refs;
  }

  const nextContext = {
    questionId: value.id_pergunta ?? context.questionId,
    questionLabel: value.pergunta ?? context.questionLabel,
  };

  if (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.size === "number"
  ) {
    refs.set(value.id, {
      id: value.id,
      name: value.name,
      questionId: value.id_pergunta ?? nextContext.questionId,
      questionLabel: value.pergunta ?? nextContext.questionLabel,
    });
  }

  Object.values(value).forEach((item) => collectMediaRefs(item, refs, nextContext));
  return refs;
}

function dataUrlToBlob(dataUrl) {
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

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

async function buildMediaPayloads(mediaRefs) {
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

function attachMediaPayloads(value, mediaById) {
  if (Array.isArray(value)) {
    return value.map((item) => attachMediaPayloads(item, mediaById));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const next = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, attachMediaPayloads(item, mediaById)]),
  );

  if (typeof value.id === "string" && mediaById.has(value.id)) {
    return {
      ...next,
      ...mediaById.get(value.id),
    };
  }

  return next;
}

async function syncQueue() {
  const syncUrl = await getSetting("syncUrl");
  const changeOrderStatusUrl = await getSetting("changeOrderStatusUrl");
  const finishOrderUrl = await getSetting("finishOrderUrl");
  const authorization = await getSetting("authorization");

  const actions = await getAllActions();

  for (const action of actions) {
    try {
      if (action.type === "status_change" || action.type === "suspend_order") {
        if (!changeOrderStatusUrl) {
          continue;
        }

        if (
          !action.payload ||
          !action.payload.id_colaborador ||
          !action.payload.id_ordem_servico ||
          !action.payload.id_situacao_ordem_servico
        ) {
          await deleteAction(action.id);
          continue;
        }

        const response = await fetch(changeOrderStatusUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: JSON.stringify(action.payload),
        });

        let data = {};

        try {
          data = await response.json();
        } catch {
          data = {};
        }

        const successValue = data.sucesso ?? data.success;
        const ok =
          response.ok &&
          (successValue === true ||
            successValue === 1 ||
            successValue === "1" ||
            successValue === "true");

        if (ok) {
          await deleteAction(action.id);
        } else {
          const message =
            typeof data.dados === "string"
              ? data.dados
              : data.mensagem ?? data.message ?? "";

          if (isAlreadyAppliedError(message)) {
            await deleteAction(action.id);
          } else {
            await putAction({ ...action, attempts: (action.attempts ?? 0) + 1 });
          }
        }

        continue;
      }

      const targetUrl = action.type === "finish_order" ? finishOrderUrl : syncUrl;

      if (!targetUrl) {
        continue;
      }

      const formData = new FormData();
      const mediaRefs = Array.from(collectMediaRefs(action.payload).values());
      const fileMeta = [];
      const payload = action.payload ?? {};

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
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: formData,
      });

      let data = {};

      try {
        data = await response.json();
      } catch {
        data = {};
      }

      const successValue = data.sucesso ?? data.success;
      const ok =
        response.ok &&
        (successValue === true ||
          successValue === 1 ||
          successValue === "1" ||
          successValue === "true");

      if (ok) {
        await deleteAction(action.id);
      } else {
        const message =
          typeof data.dados === "string"
            ? data.dados
            : data.mensagem ?? data.message ?? "";

        if (action.type === "finish_order" && message.toLowerCase().includes("json inválido")) {
          const mediaPayloads = await buildMediaPayloads(mediaRefs);
          const mediaById = new Map(mediaPayloads.map((media) => [String(media.id), media]));
          const payloadWithMedia = {
            ...attachMediaPayloads(payload, mediaById),
            midias: mediaPayloads,
          };
          const jsonResponse = await fetch(targetUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...(authorization ? { Authorization: authorization } : {}),
            },
            body: JSON.stringify(payloadWithMedia),
          });

          let jsonData = {};

          try {
            jsonData = await jsonResponse.json();
          } catch {
            jsonData = {};
          }

          const jsonSuccessValue = jsonData.sucesso ?? jsonData.success;
          const jsonOk =
            jsonResponse.ok &&
            (jsonSuccessValue === true ||
              jsonSuccessValue === 1 ||
              jsonSuccessValue === "1" ||
              jsonSuccessValue === "true");

          if (jsonOk) {
            await deleteAction(action.id);
            if (action.type === "finish_order") {
              await deleteStatusActionsForOrder(String(payload.id_ordem_servico ?? action.orderId));
            }
          } else {
            const jsonMessage =
              typeof jsonData.dados === "string"
                ? jsonData.dados
                : jsonData.mensagem ?? jsonData.message ?? "";

            if (isAlreadyAppliedError(jsonMessage)) {
              await deleteAction(action.id);
            } else {
              await putAction({ ...action, attempts: (action.attempts ?? 0) + 1 });
            }
          }
        } else {
          if (isAlreadyAppliedError(message)) {
            await deleteAction(action.id);
          } else {
            await putAction({ ...action, attempts: (action.attempts ?? 0) + 1 });
          }
        }
      }
    } catch {
      await putAction({ ...action, attempts: (action.attempts ?? 0) + 1 });
      throw new Error("Sync failed");
    }
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(openDb());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", (event) => {
  if (event.tag === syncTag) {
    event.waitUntil(syncQueue());
  }
});
