const DB_NAME = "rabbit-github-qr";
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(storeName, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

export const localStore = {
  getState(key) {
    return transaction("state", "readonly", (store) => store.get(key));
  },
  setState(key, value) {
    return transaction("state", "readwrite", (store) => store.put(value, key));
  },
  deleteState(key) {
    return transaction("state", "readwrite", (store) => store.delete(key));
  },
  putBlob(record) {
    return transaction("blobs", "readwrite", (store) => store.put(record));
  },
  getBlob(id) {
    return transaction("blobs", "readonly", (store) => store.get(id));
  },
  deleteBlob(id) {
    return transaction("blobs", "readwrite", (store) => store.delete(id));
  },
  getAllBlobs() {
    return transaction("blobs", "readonly", (store) => store.getAll());
  },
};
