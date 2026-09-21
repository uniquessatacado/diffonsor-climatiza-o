/**
 * Focused IndexedDB test double. It runs asynchronous request events, clones records,
 * serializes transactions, commits atomically and rolls back aborted transactions.
 * It deliberately does not emulate unrelated IndexedDB APIs (indexes, cursors, etc.).
 */
export class MemoryIndexedDB {
  databases = new Map();
  operations = [];
  failures = [];
  openedVersions = [];

  failNext(operation, { key, mode } = {}) {
    this.failures.push({ operation, key, mode });
  }

  open(name, version) {
    const request = {};
    this.openedVersions.push(version);
    setImmediate(() => {
      let database = this.databases.get(name);
      const needsUpgrade = !database;
      if (!database) {
        database = { stores: new Map(), transactions: [], running: false };
        this.databases.set(name, database);
      }
      let closed = false;
      request.result = {
        objectStoreNames: { contains: (store) => database.stores.has(store) },
        createObjectStore: (store, { keyPath }) => database.stores.set(store, { keyPath, records: new Map() }),
        transaction: (stores, mode) => {
          if (closed) throw new DOMException("Connection is closed", "InvalidStateError");
          const transaction = new MemoryTransaction(this, database, Array.isArray(stores) ? stores : [stores], mode);
          database.transactions.push(transaction);
          this.startNext(database);
          return transaction;
        },
        close: () => { closed = true; },
      };
      if (needsUpgrade) request.onupgradeneeded?.({ target: request });
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  startNext(database) {
    if (database.running || database.transactions.length === 0) return;
    database.running = true;
    setImmediate(() => database.transactions[0].start());
  }

  complete(database) {
    database.transactions.shift();
    database.running = false;
    this.startNext(database);
  }
}

class MemoryTransaction {
  requests = [];
  finished = false;
  error = null;

  constructor(factory, database, stores, mode) {
    Object.assign(this, { factory, database, stores, mode });
  }

  objectStore(name) {
    if (!this.stores.includes(name) || !this.database.stores.has(name)) {
      throw new DOMException("Missing store", "NotFoundError");
    }
    const enqueue = (operation, key, value) => {
      if (this.finished) throw new DOMException("Transaction inactive", "TransactionInactiveError");
      if (operation !== "get" && this.mode !== "readwrite") throw new DOMException("Read only", "ReadOnlyError");
      const request = {};
      this.requests.push({ operation, key, value: structuredClone(value), request, store: name });
      return request;
    };
    return {
      get: (key) => enqueue("get", key),
      put: (record) => enqueue("put", record[this.database.stores.get(name).keyPath], record),
      delete: (key) => enqueue("delete", key),
    };
  }

  start() {
    this.working = new Map(this.stores.map((name) => [name, new Map(this.database.stores.get(name).records)]));
    this.step();
  }

  step() {
    const action = this.requests.shift();
    if (!action) {
      if (this.mode === "readwrite") {
        for (const [name, records] of this.working) this.database.stores.get(name).records = records;
      }
      this.finished = true;
      this.oncomplete?.({ target: this });
      this.factory.complete(this.database);
      return;
    }
    const { operation, key, value, request, store } = action;
    const failure = this.factory.failures.findIndex((entry) =>
      entry.operation === operation && (entry.key === undefined || entry.key === key) &&
      (entry.mode === undefined || entry.mode === this.mode),
    );
    this.factory.operations.push({ operation, key, store, mode: this.mode, failed: failure >= 0 });
    if (failure >= 0) {
      this.factory.failures.splice(failure, 1);
      this.finished = true;
      this.error = new DOMException("Simulated transient IndexedDB failure", "AbortError");
      request.error = this.error;
      request.onerror?.({ target: request });
      this.onerror?.({ target: this });
      this.onabort?.({ target: this });
      this.factory.complete(this.database);
      return;
    }
    const records = this.working.get(store);
    if (operation === "get") request.result = structuredClone(records.get(key));
    if (operation === "put") { records.set(key, value); request.result = key; }
    if (operation === "delete") records.delete(key);
    request.onsuccess?.({ target: request });
    setImmediate(() => this.step());
  }
}
