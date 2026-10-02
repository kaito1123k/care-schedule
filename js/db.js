// IndexedDB の薄いラッパー。データはすべてこの端末内にだけ保存される
const DB_NAME = 'care-shift';
const DB_VERSION = 4;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 旧バージョン（勤務時間の記録）は使わなくなったので削除
      if (db.objectStoreNames.contains('records')) db.deleteObjectStore('records');
      // 予定：1件ごと（同じ日に複数可）
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      // 利用者：苗字・水着の初期値・内容
      if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients', { keyPath: 'id' });
      // 1日の勤務時間（出勤・休憩・退勤）：日付ごとに1件
      if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(store) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).getAll());
}

async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put({ ...value, updatedAt: new Date().toISOString() });
  return done(tx);
}

async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export const getAllItems = () => getAll('items');
export const putItem = (item) => put('items', item);
export const deleteItem = (id) => del('items', id);
export const getAllDays = () => getAll('days');
export const putDay = (day) => put('days', day);
export const deleteDay = (date) => del('days', date);
export const getAllClients = () => getAll('clients');
export const putClient = (client) => put('clients', client);
export const deleteClient = (id) => del('clients', id);

export async function getSetting(key, fallback) {
  const db = await open();
  const row = await result(db.transaction('settings').objectStore('settings').get(key));
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = await open();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  return done(tx);
}

/**
 * CSV取り込み。勤務時間は同じ日付を置き換え。利用者は同じ苗字の人（1人だけのとき）を置き換え、いなければ追加。
 * 予定は同じidを置き換え、苗字から利用者に紐づける。全件を1トランザクションで書く
 */
export async function importAll(items, clients, days, existingClients) {
  const db = await open();
  const tx = db.transaction(['items', 'clients', 'days'], 'readwrite');
  const now = new Date().toISOString();
  const dayStore = tx.objectStore('days');
  for (const d of days) dayStore.put({ ...d, updatedAt: now });

  const byName = new Map();
  for (const c of existingClients) byName.set(c.name, byName.has(c.name) ? null : c.id);
  const used = new Set();
  const clStore = tx.objectStore('clients');
  for (const c of clients) {
    let id = byName.get(c.name);
    if (!id || used.has(id)) id = newId();
    used.add(id);
    if (!byName.has(c.name)) byName.set(c.name, id);
    clStore.put({ ...c, id, updatedAt: now });
  }

  const itStore = tx.objectStore('items');
  for (const { clientName, ...i } of items) {
    const clientId = clientName ? byName.get(clientName) || null : null;
    itStore.put({ ...i, id: i.id || newId(), clientId, clientName, updatedAt: now });
  }
  return done(tx);
}

export async function clearAll() {
  const db = await open();
  const stores = ['items', 'days', 'clients', 'settings'];
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  return done(tx);
}

export function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
