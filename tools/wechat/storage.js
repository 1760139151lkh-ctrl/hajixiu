// Implements the original IndexedDB module's contract with private WeChat storage.
import { readBlob, writeBlob, removeFile } from './platform.js';

const prefix = 'hjx.wechat.db.';
const key = (table, id) => prefix + table + '.' + id;
const get = id => wx.getStorageSync(id) || undefined;
const records = () => wx.getStorageInfoSync().keys.filter(id => id.startsWith(prefix + 'record.'));
const blobs = () => wx.getStorageInfoSync().keys.filter(id => id.startsWith(prefix + 'blob.'));

export const durable = true;
export const ready = async () => true;
export const persisted = async () => true;
export function keepSafe() {}

export async function getBlob(id) {
  const stored = get(key('blob', id));
  if (!stored) return null;
  try { return readBlob(stored.path, stored.type); } catch { return null; }
}
export async function putBlob(id, blob) {
  const storeKey = key('blob', id);
  const previous = get(storeKey);
  const path = writeBlob(blob);
  try { wx.setStorageSync(storeKey, { path, type: blob.type }); }
  catch (error) { removeFile(path); throw error; }
  if (previous) removeFile(previous.path);
  return id;
}
export async function dropBlob(id) {
  const storeKey = key('blob', id), stored = get(storeKey);
  wx.removeStorageSync(storeKey);
  if (stored) removeFile(stored.path);
}
export async function allRecords() { return records().map(get).filter(Boolean); }
export async function putRecord(record) { wx.setStorageSync(key('record', record.coll + ':' + record.id), record); }
export async function clearRecords() {
  for (const id of records()) wx.removeStorageSync(id);
  for (const id of blobs()) await dropBlob(id.slice((prefix + 'blob.').length));
}
export async function getMeta(id) { return get(key('meta', id)); }
export async function setMeta(id, value) { wx.setStorageSync(key('meta', id), value); }
