// The Documents catalog: one entry per card, gift, manual, receipt or other
// document. Each is documents/<id>.json in Blob; documents/index.json holds
// a summary of every entry so the browse page loads with a single read.
// The files themselves live in Google Drive (drive.js).
//
// entry: { id, collection: cards | manuals | receipts | other, category,
//   title, date ("YYYY", "YYYY-MM" or "YYYY-MM-DD"), text, notes,
//   from, gift, thanked, thankedOn, needsThanks (cards; from also for other),
//   store, total (cents), brand, model, warrantyUntil (receipts/manuals),
//   sourceUrl (manuals: where the PDF came from),
//   needsReview (added in a batch and not looked at yet),
//   files: [{ id, store, type, size, name, w, h, pages, thumb: { id, store },
//             folder, placed }],
//   backupId (its JSON copy in Drive), createdAt/By, updatedAt/By }

import { readJSON, writeJSON, remove } from '../store.js';
import { randomId } from '../recipes.js';
import { verifyRef, fileUrl, cleanType, placeFiles, backupEntry, trashFiles } from './drive.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const INDEX = 'documents/index.json';
export const COLLECTIONS = ['cards', 'manuals', 'receipts', 'other'];
// Fields beyond the common ones (title, category, date, text, notes, files).
const FIELDS = {
  cards: ['from', 'gift', 'thanked'],
  manuals: ['brand', 'model', 'warrantyUntil', 'sourceUrl'],
  receipts: ['store', 'total', 'brand', 'model', 'warrantyUntil'],
  other: ['from']
};
const has = (collection, field) => FIELDS[collection].includes(field);

const str = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').slice(0, max).trim();
const line = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : null; };

export function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.FAMILY_TIMEZONE || 'America/Boise' });
}
// "2025", "2025-12" or a real "2025-12-25"; anything else is dropped.
export function cleanDate(d) {
  d = String(d || '').trim();
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(d);
  if (!m || +m[1] < 1900 || +m[1] > 2100) return '';
  if (m[2] && (+m[2] < 1 || +m[2] > 12)) return '';
  if (m[3] && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d) return '';
  return d;
}
const cleanDay = d => (/^\d{4}-\d{2}-\d{2}$/.test(cleanDate(d)) ? cleanDate(d) : '');
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const dayOffset = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10);

/* ---------- thank-yous ----------
   A card or gift is on "Still to thank" when it isn't thanked and needs a
   thank-you. needsThanks is what the family chose (To thank / Not needed);
   when nobody chose (a batch upload, or an entry from before the choice
   existed), a gift needs one and a card on its own doesn't, and nor does a
   gift dated more than six months before it was added (an old one found in
   a drawer). Works on an entry or its summary. */
const OLD_GIFT_DAYS = 183;
// The last day "2025" or "2025-12" could mean.
function periodEnd(date) {
  if (/^\d{4}$/.test(date)) return date + '-12-31';
  if (/^\d{4}-\d{2}$/.test(date)) return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0)).toISOString().slice(0, 10);
  return date;
}
function defaultNeedsThanks(d, addedDay) {
  if (!d.gift) return false;
  return !d.date || periodEnd(d.date) >= dayOffset(addedDay, -OLD_GIFT_DAYS);
}
export function needsThanks(d) {
  if (typeof d.needsThanks === 'boolean') return d.needsThanks;
  return defaultNeedsThanks(d, String(d.createdAt || '').slice(0, 10) || today());
}
export const toThank = d => d.collection === 'cards' && !d.thanked && needsThanks(d);

// A warranty that ends within the next 60 days.
export function warrantySoon(d, day = today()) {
  return !!d.warrantyUntil && d.warrantyUntil >= day && d.warrantyUntil <= dayOffset(day, 60);
}

// Every word of the text and notes once, lowercased, for the browse page's
// search (it searches names and fields itself).
function searchWords(d) {
  const words = new Set();
  for (const w of (d.text + ' ' + d.notes).toLowerCase().match(/[\p{L}\p{N}$][\p{L}\p{N}$.,'’&/-]*/gu) || []) {
    words.add(w.replace(/[.,'’&/-]+$/, ''));
  }
  let out = '';
  for (const w of words) {
    if (out.length + w.length + 1 > 4000) break;
    out += (out ? ' ' : '') + w;
  }
  return out;
}
// Only plain web links (the page puts it in an href).
function cleanUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    return /^https?:$/.test(url.protocol) && url.href.length <= 600 ? url.href : '';
  } catch (e) {
    return '';
  }
}

// The files the editor sent: ones the entry already had (matched by id),
// plus new ones that carry our upload signature. Anything else is dropped.
function cleanFiles(list, prevFiles) {
  const prev = new Map((prevFiles || []).map(f => [f.store + ':' + f.id, f]));
  const out = [], seen = new Set();
  for (const f of (Array.isArray(list) ? list : []).slice(0, 40)) {
    if (!f) continue;
    const k = f.store + ':' + f.id;
    const old = prev.get(k);
    if (seen.has(k) || (!old && !verifyRef(f))) continue;
    seen.add(k);
    const thumb = old ? old.thumb || null : f.thumb && verifyRef(f.thumb) ? { id: f.thumb.id, store: f.thumb.store } : null;
    out.push({
      id: f.id, store: f.store,
      type: old ? old.type : cleanType(f.type),
      size: old ? old.size : int(f.size),
      name: old ? old.name : line(f.name, 150) || 'file',
      w: old ? old.w : int(f.w), h: old ? old.h : int(f.h), pages: old ? old.pages : int(f.pages),
      thumb,
      folder: old ? old.folder || 'hub' : 'hub',
      placed: old ? old.placed || null : null
    });
  }
  return out;
}

function normalize(input, prev) {
  const c = COLLECTIONS.includes(input.collection) ? input.collection : 'other';
  const thanked = has(c, 'thanked') && !!input.thanked;
  return {
    collection: c,
    category: cap(line(input.category, 40)),
    title: line(input.title, 160),
    date: cleanDate(input.date),
    text: str(input.text, 12000),
    notes: str(input.notes, 4000),
    from: has(c, 'from') ? line(input.from, 200) : '',
    gift: has(c, 'gift') ? line(input.gift, 300) : '',
    thanked,
    thankedOn: thanked ? (prev && prev.thanked && prev.thankedOn ? prev.thankedOn : today()) : null,
    // null: nobody chose; saveDoc fills in the default.
    needsThanks: !has(c, 'thanked') ? null
      : typeof input.needsThanks === 'boolean' ? input.needsThanks
      : prev && typeof prev.needsThanks === 'boolean' ? prev.needsThanks : null,
    store: has(c, 'store') ? line(input.store, 120) : '',
    total: has(c, 'total') ? int(input.total) : null,
    brand: has(c, 'brand') ? line(input.brand, 80) : '',
    model: has(c, 'model') ? line(input.model, 80) : '',
    warrantyUntil: has(c, 'warrantyUntil') ? cleanDay(input.warrantyUntil) : '',
    sourceUrl: has(c, 'sourceUrl') ? cleanUrl(input.sourceUrl) : '',
    needsReview: !!input.needsReview,
    files: cleanFiles(input.files, prev && prev.files)
  };
}

// What an entry is called when it has no title of its own.
export function displayName(d) {
  if (d.title) return d.title;
  if (d.collection === 'cards') {
    const giftOnly = !d.files.length && d.gift;
    const what = (d.category ? d.category + ' ' : '') + (giftOnly ? 'gift' : 'card');
    return cap(what) + (d.from ? ' from ' + d.from : '');
  }
  if (d.collection === 'manuals') {
    const product = [d.brand, d.model].filter(Boolean).join(' ');
    return product ? product + ' manual' : d.category ? d.category + ' manual' : 'Manual';
  }
  if (d.collection === 'receipts') return d.store ? d.store + ' receipt' : 'Receipt';
  return d.from ? 'Document from ' + d.from : d.category || 'Document';
}

const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The file name in Drive: dated where that helps you find it there.
function driveBase(d) {
  if (d.collection === 'cards') return [d.date.slice(0, 4), displayName(d)].filter(Boolean).join(' ');
  if (d.collection === 'receipts') return [d.date, displayName(d)].filter(Boolean).join(' ');
  return displayName(d);
}
function driveDescription(d) {
  const rows = [displayName(d)];
  const add = (label, v) => { if (v) rows.push(label + ': ' + v); };
  add('From', d.from);
  add(d.collection === 'cards' ? 'Occasion' : 'Category', d.category);
  add('Date', d.date);
  add('Gift', d.gift);
  if (d.collection === 'cards') rows.push('Thanked: ' + (d.thanked ? 'yes' + (d.thankedOn ? ' (' + d.thankedOn + ')' : '') : needsThanks(d) ? 'not yet' : 'not needed'));
  add('Store', d.store);
  add('Total', d.total != null ? money(d.total) : '');
  add('Brand', d.brand);
  add('Model', d.model);
  add('Warranty until', d.warrantyUntil);
  add('Online', d.sourceUrl);
  if (d.text) rows.push('', d.text);
  if (d.notes) rows.push('', 'Notes: ' + d.notes);
  return rows.join('\n').slice(0, 4000);
}

// The JSON copy kept in Drive: everything needed to rebuild the entry.
function backupCopy(d) {
  const { backupId, ...rest } = d;
  return { ...rest, name: displayName(d), files: d.files.map(f => ({ driveId: f.store === 'drive' ? f.id : null, name: f.name, type: f.type, size: f.size })), keptBy: 'Randall Family Hub · Documents' };
}

// Files go to their folder and get their names before the entry is written,
// so what each file was given is saved with it.
async function syncDrive(d) {
  await placeFiles(d.files, { folder: d.collection, base: driveBase(d), description: driveDescription(d) });
  d.backupId = await backupEntry(backupCopy(d), d.backupId);
}

// Bump when the summary gains something worked out from the full entry:
// listDocs rebuilds older summaries once.
const SUMMARY_V = 2;
function summarize(d) {
  const withThumb = d.files.find(f => f.thumb);
  return {
    v: SUMMARY_V,
    id: d.id, collection: d.collection, category: d.category, name: displayName(d), title: d.title,
    date: d.date, from: d.from, gift: d.gift, thanked: d.thanked, needsThanks: d.needsThanks, needsReview: d.needsReview,
    store: d.store, total: d.total, brand: d.brand, model: d.model, warrantyUntil: d.warrantyUntil,
    thumb: withThumb ? withThumb.thumb : null,
    thumbPage: !!(withThumb && withThumb.type === 'application/pdf'),
    files: d.files.length,
    pdf: d.files.some(f => f.type === 'application/pdf'),
    // Every word of the text and notes, so search finds words from the card or receipt.
    words: searchWords(d),
    createdAt: d.createdAt, createdBy: d.createdBy, updatedAt: d.updatedAt
  };
}

const withUrl = s => ({ ...s, thumbUrl: s.thumb ? fileUrl(s.thumb) : null, toThank: toThank(s) });

function output(d) {
  const { backupId, ...rest } = d;
  return {
    ...rest,
    needsThanks: d.collection === 'cards' ? needsThanks(d) : null,
    toThank: toThank(d),
    name: displayName(d),
    files: d.files.map(f => ({
      id: f.id, store: f.store, type: f.type, size: f.size, name: f.name, w: f.w, h: f.h, pages: f.pages,
      url: fileUrl(f),
      thumb: f.thumb, thumbUrl: f.thumb ? fileUrl(f.thumb) : null,
      driveUrl: f.store === 'drive' ? 'https://drive.google.com/file/d/' + encodeURIComponent(f.id) + '/view' : null
    }))
  };
}

async function readEntry(id) {
  if (!/^[a-z0-9]{6,32}$/.test(String(id || ''))) return null;
  const r = await readJSON(`documents/${id}.json`, { etag: false });
  return r ? r.data : null;
}

async function updateIndex(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJSON(INDEX);
    const docs = fn(cur ? cur.data.docs || [] : []);
    try {
      await writeJSON(INDEX, { docs }, cur ? cur.etag : null);
      return;
    } catch (e) {
      if (!e.precondition) throw e;
    }
  }
  throw fail(503, 'Documents is busy saving something else. Try again.');
}

// Summaries written by an older version are rebuilt from their entries,
// once (a read per entry, then one index write).
async function upgradeSummaries(docs) {
  const old = docs.filter(s => s.v !== SUMMARY_V).slice(0, 200);
  if (!old.length) return docs;
  const fresh = new Map();
  for (let i = 0; i < old.length; i += 10) {
    const got = await Promise.all(old.slice(i, i + 10).map(s => readEntry(s.id).catch(() => null)));
    got.forEach(d => { if (d) fresh.set(d.id, summarize(d)); });
  }
  if (!fresh.size) return docs;
  try {
    await updateIndex(list => list.map(s => fresh.get(s.id) || s));
  } catch (e) {
    console.error('Documents: couldn’t rebuild the index summaries:', e.message);
  }
  return docs.map(s => fresh.get(s.id) || s);
}

export async function listDocs() {
  const idx = await readJSON(INDEX, { etag: false });
  return (await upgradeSummaries(idx ? idx.data.docs || [] : [])).map(withUrl);
}

export async function docsStatus() {
  const idx = await readJSON(INDEX, { etag: false });
  const docs = idx ? idx.data.docs || [] : [];
  const day = today();
  return {
    total: docs.length,
    toThank: docs.filter(toThank).length,
    review: docs.filter(d => d.needsReview).length,
    warrantySoon: docs.filter(d => warrantySoon(d, day)).length
  };
}

export async function getDoc(id) {
  const d = await readEntry(id);
  return d ? output(d) : null;
}

// Other items for the same product (a receipt and its manual), matched on
// the model number. Costs one index read, so only for items with a model.
const modelKey = m => String(m || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export async function relatedDocs(doc) {
  const key = modelKey(doc.model);
  if (key.length < 3) return [];
  const idx = await readJSON(INDEX, { etag: false });
  return (idx ? idx.data.docs || [] : [])
    .filter(s => s.id !== doc.id && modelKey(s.model) === key)
    .slice(0, 6)
    .map(withUrl);
}

const allFiles = d => d.files.flatMap(f => [f, f.thumb]).filter(Boolean);
const keyOf = f => f.store + ':' + f.id;

async function write(d) {
  await syncDrive(d);
  await writeJSON(`documents/${d.id}.json`, d);
  await updateIndex(list => [summarize(d), ...list.filter(x => x.id !== d.id)]);
}

export async function saveDoc(input, user) {
  input = input || {};
  const prev = input.id ? await readEntry(input.id) : null;
  if (input.id && !prev) throw fail(404, 'That item wasn’t found. It may have been deleted.');
  const fields = normalize(input, prev);
  const typed = ['title', 'from', 'gift', 'text', 'notes', 'store', 'brand', 'model', 'sourceUrl'].some(k => fields[k]) || fields.total != null;
  if (!prev && !fields.files.length && !typed) {
    throw fail(400, 'Add a photo or file, or fill in a few details first.');
  }
  const now = new Date().toISOString();
  const d = {
    id: prev ? prev.id : randomId(12),
    ...fields,
    createdAt: prev ? prev.createdAt : now, createdBy: prev ? prev.createdBy : user.name,
    updatedAt: now, updatedBy: user.name,
    backupId: prev ? prev.backupId || null : null
  };
  // Nobody said whether it needs a thank-you: decide once, and keep it.
  if (d.collection === 'cards' && d.needsThanks == null) d.needsThanks = needsThanks(d);
  await write(d);
  // Files taken off the entry go to the trash once it's saved without them.
  if (prev) {
    const kept = new Set(allFiles(d).map(keyOf));
    await trashFiles(allFiles(prev).filter(f => !kept.has(keyOf(f))));
  }
  return output(d);
}

// Small changes from the item and browse pages: thanked, needs a
// thank-you, "looked at".
export async function patchDoc(input, user) {
  input = input || {};
  const prev = await readEntry(input.id);
  if (!prev) throw fail(404, 'That item wasn’t found. It may have been deleted.');
  const d = { ...prev, updatedAt: new Date().toISOString(), updatedBy: user.name };
  if ('thanked' in input && d.collection === 'cards') {
    d.thanked = !!input.thanked;
    d.thankedOn = d.thanked ? (prev.thanked && prev.thankedOn ? prev.thankedOn : today()) : null;
  }
  if (typeof input.needsThanks === 'boolean' && d.collection === 'cards') d.needsThanks = input.needsThanks;
  if ('needsReview' in input) d.needsReview = !!input.needsReview;
  await write(d);
  return output(d);
}

export async function deleteDoc(id) {
  const d = await readEntry(id);
  if (!d) throw fail(404, 'That item wasn’t found. It may have been deleted already.');
  await remove(`documents/${d.id}.json`);
  await updateIndex(list => list.filter(x => x.id !== d.id));
  await trashFiles([...allFiles(d), ...(d.backupId ? [{ store: 'drive', id: d.backupId }] : [])]);
}
