import type { ClosingQuestion } from "./serviceOrders";
import { openMediaDatabase } from "./mediaStore";

export type ClosingAnswers = Record<string, string | string[]>;

export type ClosingDraftScope = {
  userId: string;
  orderId: string;
  equipmentOrderId?: string;
  questionnaireId?: string;
};

export type ClosingDraft = {
  answers: ClosingAnswers;
  removedMedia: Record<string, string[]>;
  updatedAt: string;
};

type StoredClosingDraft = ClosingDraft & { key: string; version: 1 };
const settingsStore = "settings";
const writes = new Map<string, Promise<unknown>>();

export function getClosingDraftKey(scope: ClosingDraftScope) {
  return `diffonso.closingDraft.v2.${JSON.stringify([
    String(scope.userId),
    String(scope.orderId),
    String(scope.equipmentOrderId ?? ""),
    String(scope.questionnaireId ?? ""),
  ])}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mediaRecord(value: unknown) {
  try {
    return asRecord(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return null;
  }
}

/** Stable IDs and URLs only: filenames and temporary blob previews are not identities. */
export function getClosingMediaIdentityKeys(value: unknown): string[] {
  const media = mediaRecord(value);
  if (!media) return [];
  const keys: string[] = [];
  const id = media.id ?? media.id_midia;
  const isRemote = media.source === "remote" || [media.url, media.uri].some(
    (value) => typeof value === "string" && /^https?:\/\//i.test(value),
  );
  if ((typeof id === "string" || typeof id === "number") && String(id).trim()) {
    keys.push(`${isRemote ? "remote-id" : "id"}:${String(id).trim()}`);
  }
  for (const field of [media.url, media.uri]) {
    if (typeof field === "string" && field.trim() && !field.startsWith("blob:")) {
      keys.push(`url:${field.trim()}`);
    }
  }
  return keys;
}

export function mergeMediaAnswers(...lists: Array<readonly string[]>): string[] {
  const result: Array<{ value: string; keys: Set<string> }> = [];
  for (const item of lists.flat()) {
    const keys = getClosingMediaIdentityKeys(item);
    const matches = result.flatMap((entry, index) => keys.some((key) => entry.keys.has(key)) ? [index] : []);
    if (matches.length === 0) {
      result.push({ value: item, keys: new Set(keys) });
      continue;
    }
    // A later response may connect an ID-only entry and a URL-only entry. Collapse both,
    // retaining all known aliases so subsequent hydration cannot duplicate either one.
    const combined: Record<string, unknown> = {};
    const combinedKeys = new Set(keys);
    matches.forEach((index) => {
      Object.assign(combined, mediaRecord(result[index].value));
      result[index].keys.forEach((key) => combinedKeys.add(key));
    });
    Object.assign(combined, mediaRecord(item));
    result[matches[0]] = { value: JSON.stringify(combined), keys: combinedKeys };
    matches.slice(1).reverse().forEach((index) => result.splice(index, 1));
  }
  return result.map((entry) => entry.value);
}

export function prepareClosingAnswersForStorage(answers: ClosingAnswers): ClosingAnswers {
  return Object.fromEntries(Object.entries(answers).map(([questionId, value]) => [
    questionId,
    Array.isArray(value) ? value.map((item) => {
      const media = mediaRecord(item);
      if (!media || getClosingMediaIdentityKeys(item).length === 0) return item;
      const { previewUrl: _previewUrl, previewDataUrl: _previewDataUrl, status: _status, ...stored } = media;
      return JSON.stringify(stored);
    }) : value,
  ]));
}

/** Reads the existing finalization response shape; questionnaire answer options are never drafts. */
export function readBackendClosingAnswers(responses: unknown, questions: ClosingQuestion[]): ClosingAnswers {
  const answers: ClosingAnswers = {};
  if (!Array.isArray(responses)) return answers;
  for (const value of responses) {
    const response = asRecord(value);
    if (!response || response.id_pergunta == null) continue;
    const question = questions.find((entry) => String(entry.apiQuestionId ?? entry.id) === String(response.id_pergunta));
    if (!question) continue;
    if (question.step === "media") {
      if (Array.isArray(response.midias)) {
        answers[question.id] = mergeMediaAnswers(response.midias.flatMap((item) => {
          const record = mediaRecord(item);
          return record && getClosingMediaIdentityKeys(record).length > 0 ? [JSON.stringify(record)] : [];
        }));
      }
    } else if (question.step === "checkbox") {
      const selected = Array.isArray(response.id_respostas)
        ? response.id_respostas
        : Array.isArray(response.respostas)
          ? response.respostas.map((item) => asRecord(item)?.id_resposta)
          : undefined;
      if (selected) answers[question.id] = selected.filter((id) => typeof id === "string" || typeof id === "number").map(String);
    } else if (question.step === "radio") {
      if (typeof response.id_resposta === "string" || typeof response.id_resposta === "number") {
        answers[question.id] = String(response.id_resposta);
      }
    } else if (["string", "number", "boolean"].includes(typeof response.resposta)) {
      answers[question.id] = String(response.resposta);
    }
  }
  return answers;
}

export function mergeClosingAnswers(
  questions: ClosingQuestion[],
  backendAnswers: ClosingAnswers,
  draft: ClosingDraft | null,
): ClosingAnswers {
  const answers: ClosingAnswers = {};
  for (const question of questions) {
    const backend = backendAnswers[question.id];
    const local = draft?.answers[question.id];
    if (question.step === "media") {
      if (backend === undefined && local === undefined) continue;
      const removed = new Set(draft?.removedMedia[question.id] ?? []);
      const backendMedia = Array.isArray(backend) ? backend : [];
      answers[question.id] = mergeMediaAnswers(
        backendMedia,
        Array.isArray(local) ? local : [],
      ).map((item) => {
        const keys = getClosingMediaIdentityKeys(item);
        const fresh = backendMedia.find((entry) => getClosingMediaIdentityKeys(entry).some(
          (key) => (key.startsWith("remote-id:") || key.startsWith("url:")) && keys.includes(key),
        ));
        const freshRecord = mediaRecord(fresh);
        if (!freshRecord) return item;
        const record = { ...mediaRecord(item) };
        // A saved signed URL can expire. Keep local-only metadata, but use the current
        // server fields for the same remote media, including a changed url/uri field.
        if ([freshRecord.url, freshRecord.uri].some((value) => typeof value === "string" && /^https?:\/\//i.test(value))) {
          delete record.url;
          delete record.uri;
          delete record.remotePayload;
        }
        return JSON.stringify({ ...record, ...freshRecord });
      }).filter((item) => !getClosingMediaIdentityKeys(item).some((key) => removed.has(key)));
    } else if (local !== undefined || backend !== undefined) {
      answers[question.id] = local ?? backend;
    }
  }
  return answers;
}

function normalizeDraft(value: unknown): ClosingDraft | null {
  const record = asRecord(value);
  const answers = asRecord(record?.answers);
  if (!record || !answers) return null;
  return {
    answers: Object.fromEntries(Object.entries(answers).filter(([, answer]) =>
      typeof answer === "string" || Array.isArray(answer) && answer.every((item) => typeof item === "string"),
    )) as ClosingAnswers,
    removedMedia: Object.fromEntries(Object.entries(asRecord(record.removedMedia) ?? {}).filter(([, removed]) =>
      Array.isArray(removed) && removed.every((item) => typeof item === "string"),
    )) as Record<string, string[]>,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

export function createClosingDraftSnapshot(answers: ClosingAnswers, previous: ClosingDraft | null): ClosingDraft {
  const storedAnswers = prepareClosingAnswersForStorage(answers);
  const removedMedia = { ...previous?.removedMedia };
  for (const [questionId, value] of Object.entries(storedAnswers)) {
    if (!Array.isArray(value)) continue;
    const nextKeys = new Set(value.flatMap(getClosingMediaIdentityKeys));
    const previousValue = previous?.answers[questionId];
    const removals = new Set(removedMedia[questionId] ?? []);
    for (const old of Array.isArray(previousValue) ? previousValue : []) {
      const oldKeys = getClosingMediaIdentityKeys(old);
      if (!oldKeys.some((key) => nextKeys.has(key))) oldKeys.forEach((key) => removals.add(key));
    }
    nextKeys.forEach((key) => removals.delete(key));
    if (removals.size) removedMedia[questionId] = [...removals];
    else delete removedMedia[questionId];
  }
  return { answers: storedAnswers, removedMedia, updatedAt: new Date().toISOString() };
}

function serializeWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  writes.set(key, pending);
  void pending.finally(() => { if (writes.get(key) === pending) writes.delete(key); }).catch(() => undefined);
  return pending;
}

export async function readClosingDraft(scope: ClosingDraftScope): Promise<ClosingDraft | null> {
  const key = getClosingDraftKey(scope);
  // Navigation can reopen immediately after an input change: wait for its queued write.
  await writes.get(key);
  const db = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(settingsStore, "readonly");
    const request = transaction.objectStore(settingsStore).get(key);
    transaction.oncomplete = () => { db.close(); resolve(normalizeDraft(request.result)); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export function writeClosingDraft(scope: ClosingDraftScope, answers: ClosingAnswers): Promise<ClosingDraft> {
  const key = getClosingDraftKey(scope);
  // Snapshot synchronously; callers may update their answer state before IndexedDB opens.
  const snapshot = prepareClosingAnswersForStorage(answers);
  return serializeWrite(key, async () => {
    const db = await openMediaDatabase();
    return new Promise<ClosingDraft>((resolve, reject) => {
      const transaction = db.transaction(settingsStore, "readwrite");
      const store = transaction.objectStore(settingsStore);
      const request = store.get(key);
      let draft: ClosingDraft;
      request.onsuccess = () => {
        draft = createClosingDraftSnapshot(snapshot, normalizeDraft(request.result));
        const record: StoredClosingDraft = { ...draft, key, version: 1 };
        store.put(record);
      };
      transaction.oncomplete = () => { db.close(); resolve(draft); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  });
}

/** Call only after confirmed finalization or an explicit discard; never on navigation. */
export function removeClosingDraft(scope: ClosingDraftScope): Promise<void> {
  const key = getClosingDraftKey(scope);
  return serializeWrite(key, async () => {
    const db = await openMediaDatabase();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(settingsStore, "readwrite");
      transaction.objectStore(settingsStore).delete(key);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  });
}
