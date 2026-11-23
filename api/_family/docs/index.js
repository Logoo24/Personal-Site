// Documents' routes (api/family.js sends every ?r=docs-* here, only for
// people canSeeDocuments() lets in):
//
//   GET  docs-list                    -> { docs (summaries), drive (status) }
//   GET  docs-status                  -> { total, toThank, review } for the hub card
//   GET  docs-get&id=                 -> { doc, drive }
//   POST docs-save    {...entry}      -> { doc } (create / update)
//   POST docs-patch   {id, thanked?, needsReview?} -> { doc }
//   POST docs-delete  {id}
//   POST docs-upload-start {name, type, size} -> { token, chunk }
//   POST docs-upload-chunk (raw bytes; x-upload-token, x-upload-offset,
//        or x-upload-status: 1 to ask where it got to) -> { done, next | file }
//   POST docs-discard {files}         -> trash fresh uploads taken off before saving
//   GET  docs-file&s=&f=&k=[&n=&dl=1] -> the file (Range supported)
//   POST docs-read    {images: [{type, data}], collection?} -> { suggestion }
//   POST docs-manual-find  {brand, model, title} -> { candidates: [{url, title, host, size}] }
//   POST docs-manual-fetch {url, brand, model, title} -> { file, url, host, source, size }
//   GET  docs-drive-connect           -> Google's consent screen (admins)
//   GET  docs-drive-callback          -> back from Google (/api/drive-callback)
//   POST docs-drive-disconnect        -> { drive } (admins)

import { isAdmin } from '../session.js';
import { listDocs, docsStatus, getDoc, saveDoc, patchDoc, deleteDoc } from './catalog.js';
import { driveStatus, startUpload, uploadChunk, discardUploads, serveFile, connectStart, connectFinish, disconnect } from './drive.js';
import { readDocument } from './reader.js';
import { findManual, fetchManual } from './manuals.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const body = request => request.json().catch(() => ({}));

export async function documentsRoute(request, url, user, r) {
  const admin = isAdmin(user);
  switch (`${request.method} ${r}`) {
    case 'GET docs-list':
      return { docs: await listDocs(), drive: await driveStatus(user, admin) };
    case 'GET docs-status':
      return docsStatus();
    case 'GET docs-get': {
      const doc = await getDoc(url.searchParams.get('id'));
      if (!doc) throw fail(404, 'That item wasn’t found. It may have been deleted.');
      return { doc, drive: await driveStatus(user, admin) };
    }
    case 'POST docs-save':
      return { doc: await saveDoc(await body(request), user) };
    case 'POST docs-patch':
      return { doc: await patchDoc(await body(request), user) };
    case 'POST docs-delete':
      await deleteDoc((await body(request)).id);
      return { ok: true };
    case 'POST docs-upload-start':
      return startUpload(await body(request));
    case 'POST docs-upload-chunk':
      return uploadChunk(
        request.headers.get('x-upload-token'), request.headers.get('x-upload-offset'),
        Buffer.from(await request.arrayBuffer()), request.headers.get('x-upload-status') === '1'
      );
    case 'POST docs-discard':
      return discardUploads((await body(request)).files);
    case 'GET docs-file':
      return serveFile(url, request);
    case 'POST docs-read':
      return readDocument(await body(request));
    case 'POST docs-manual-find':
      return findManual(await body(request));
    case 'POST docs-manual-fetch':
      return fetchManual(await body(request));
    case 'GET docs-drive-connect':
      if (!admin) throw fail(403, 'Only an admin can connect Google Drive.');
      return connectStart(request, user);
    case 'GET docs-drive-callback':
      if (!admin) throw fail(403, 'Only an admin can connect Google Drive.');
      return connectFinish(request, url, user);
    case 'POST docs-drive-disconnect':
      if (!admin) throw fail(403, 'Only an admin can disconnect Google Drive.');
      await disconnect();
      return { drive: await driveStatus(user, admin) };
  }
  throw fail(404, 'Unknown request');
}
