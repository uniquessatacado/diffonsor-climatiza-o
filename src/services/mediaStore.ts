const dbName = "diffonso-offline";
const dbVersion = 3;
const mediaStore = "media";
const queueStore = "queue";
const settingsStore = "settings";
const ordersStore = "orders";

export type StoredMedia = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
};

type StoredMediaRecord = StoredMedia & {
  blob: Blob;
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

export async function saveMediaFiles(files: FileList | File[] | null) {
  const db = await openDb();
  const fileList = Array.from(files ?? []);

  return Promise.all(
    fileList.map(
      (file) =>
        new Promise<StoredMedia>((resolve, reject) => {
          const media: StoredMediaRecord = {
            id: createLocalId(),
            name: file.name,
            type: file.type,
            size: file.size,
            createdAt: new Date().toISOString(),
            blob: file,
          };
          const transaction = db.transaction(mediaStore, "readwrite");

          transaction.objectStore(mediaStore).put(media);
          transaction.oncomplete = () => {
            const { blob: _blob, ...metadata } = media;
            resolve(metadata);
          };
          transaction.onerror = () => reject(transaction.error);
        }),
    ),
  );
}

export async function savePreparedMediaFiles(
  items: Array<{
    file: File;
    metadata: StoredMedia;
  }>,
) {
  const db = await openDb();

  return Promise.all(
    items.map(
      ({ file, metadata }) =>
        new Promise<StoredMedia>((resolve, reject) => {
          const media: StoredMediaRecord = {
            ...metadata,
            blob: file,
          };
          const transaction = db.transaction(mediaStore, "readwrite");

          transaction.objectStore(mediaStore).put(media);
          transaction.oncomplete = () => resolve(metadata);
          transaction.onerror = () => reject(transaction.error);
        }),
    ),
  );
}

export async function getMedia(id: string) {
  const db = await openDb();

  return new Promise<StoredMediaRecord | null>((resolve, reject) => {
    const transaction = db.transaction(mediaStore, "readonly");
    const request = transaction.objectStore(mediaStore).get(id);

    request.onsuccess = () => resolve((request.result as StoredMediaRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteMedia(id: string) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(mediaStore, "readwrite");
    transaction.objectStore(mediaStore).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
