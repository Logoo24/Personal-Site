// The family Google Calendar through the Calendar API, as a Google service
// account: read events (no waiting on the public iCal feed, which Google
// can take hours to refresh) and add, edit and delete them from the hub.
//
// Setup: a service account with the Calendar API enabled, its JSON key in
// GOOGLE_CALENDAR_SERVICE_ACCOUNT, and the family calendar shared with the
// account's email ("Make changes to events"). Without the key the hub falls
// back to the read-only iCal feed (api/_family/calendar.js).

import crypto from 'node:crypto';

const API = 'https://www.googleapis.com/calendar/v3';
const fail = (status, message) => Object.assign(new Error(message), { status });

function serviceAccount() {
  const raw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key ? sa : null;
  } catch (e) {
    console.error('GOOGLE_CALENDAR_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
}
export function gcalConfigured() { return !!serviceAccount(); }

// OAuth token for the service account (a signed JWT exchanged at Google),
// reused until shortly before it expires.
let token = null; // { value, exp }
async function accessToken() {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const sa = serviceAccount();
  if (!sa) throw fail(503, 'Calendar editing isn’t set up yet.');
  const now = Math.floor(Date.now() / 1000);
  const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    console.error('Calendar sign-in failed', r.status, data);
    throw fail(502, 'The hub couldn’t sign in to Google Calendar.');
  }
  token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

async function gapi(calendarId, path, { method = 'GET', query, body } = {}) {
  const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events${path}` + (query ? '?' + new URLSearchParams(query) : '');
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204 || (method === 'DELETE' && r.ok)) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Calendar API', method, path, r.status, data.error && data.error.message);
    if (r.status === 404 && method === 'GET' && !path) throw fail(502, 'The hub can’t see the family calendar. Share it with the service account.');
    if (r.status === 403 || (r.status === 404 && !path)) throw fail(502, 'The hub isn’t allowed to change the family calendar. Share it with the service account and choose “Make changes to events”.');
    if (r.status === 404 || r.status === 410) throw fail(404, 'That event is gone. It may have been deleted already.');
    throw fail(502, 'Google Calendar didn’t accept that change. Try again.');
  }
  return data;
}

/* ---------- reading ---------- */

const day = s => s.slice(0, 10);

function toOutput(item) {
  const allDay = !!item.start.date;
  return {
    id: item.id,
    seriesId: item.recurringEventId || (item.recurrence ? item.id : null),
    title: item.summary || '(No title)',
    location: item.location || '',
    description: String(item.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim().slice(0, 2000),
    allDay,
    // All-day events are dates (end exclusive); timed events are instants.
    start: allDay ? item.start.date : new Date(item.start.dateTime).toISOString(),
    end: allDay ? item.end.date : new Date(item.end.dateTime).toISOString(),
    recurring: !!item.recurringEventId,
    addedBy: (item.extendedProperties && item.extendedProperties.private && item.extendedProperties.private.addedBy) || ''
  };
}

export async function gcalEvents(calendarId, fromMs, toMs) {
  const out = [];
  let pageToken;
  do {
    const data = await gapi(calendarId, '', {
      query: {
        timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...(pageToken ? { pageToken } : {})
      }
    });
    for (const item of data.items || []) if (item.status !== 'cancelled' && item.start) out.push(toOutput(item));
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < 5000);
  return out;
}

// The repeat setting of an event's series, for the edit form:
// '', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', or 'CUSTOM' for anything the
// form can't show (intervals, end dates, several weekdays…).
function repeatOf(recurrence) {
  const rule = (recurrence || []).find(l => /^RRULE:/.test(l));
  if (!rule) return '';
  const parts = Object.fromEntries(rule.slice(6).split(';').map(p => p.split('=')));
  const simple = Object.keys(parts).every(k => k === 'FREQ' || (k === 'WKST') || (k === 'BYDAY' && parts.FREQ === 'WEEKLY' && !parts.BYDAY.includes(',')));
  return simple && /^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(parts.FREQ) ? parts.FREQ : 'CUSTOM';
}
export async function gcalSeries(calendarId, seriesId) {
  const master = await gapi(calendarId, '/' + encodeURIComponent(seriesId));
  return { repeat: repeatOf(master.recurrence) };
}

/* ---------- writing ---------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const REPEATS = ['', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'CUSTOM'];
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// The form's fields -> a checked event. Dates are YYYY-MM-DD, times HH:MM,
// in the person's own time zone; endDate is the last day (inclusive).
function readForm(input, fallbackZone) {
  const e = input || {};
  const title = String(e.title || '').trim().slice(0, 200);
  if (!title) throw fail(400, 'Give the event a name.');
  const allDay = !!e.allDay;
  const startDate = String(e.startDate || ''), endDate = String(e.endDate || e.startDate || '');
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) throw fail(400, 'Pick a date.');
  if (endDate < startDate) throw fail(400, 'The event can’t end before it starts.');
  const timeZone = validZone(e.timeZone) ? e.timeZone : fallbackZone;
  const out = {
    title, allDay, startDate, endDate, timeZone,
    location: String(e.location || '').trim().slice(0, 500),
    description: String(e.description || '').trim().slice(0, 4000),
    repeat: REPEATS.includes(e.repeat) ? e.repeat : ''
  };
  if (!allDay) {
    out.startTime = String(e.startTime || ''); out.endTime = String(e.endTime || '');
    if (!TIME_RE.test(out.startTime) || !TIME_RE.test(out.endTime)) throw fail(400, 'Pick a start and end time.');
    if (endDate + out.endTime <= startDate + out.startTime) throw fail(400, 'The end time has to be after the start.');
  }
  return out;
}
function times(f, startDate = f.startDate) {
  const span = daysBetween(f.startDate, f.endDate);
  return f.allDay
    ? { start: { date: startDate }, end: { date: addDays(startDate, span + 1) } }
    : { start: { dateTime: `${startDate}T${f.startTime}:00`, timeZone: f.timeZone },
        end: { dateTime: `${addDays(startDate, span)}T${f.endTime}:00`, timeZone: f.timeZone } };
}
const details = f => ({ summary: f.title, location: f.location, description: f.description });
const rrule = repeat => ['RRULE:FREQ=' + repeat];
// Whole-day vs. timed changes need the other kind of field cleared.
const clearOther = f => (f.allDay ? { start: { dateTime: null }, end: { dateTime: null } } : { start: { date: null }, end: { date: null } });

export async function gcalCreate(calendarId, input, user, zone) {
  const f = readForm(input, zone);
  const t = times(f);
  const body = { ...details(f), ...t, extendedProperties: { private: { addedBy: user.name } } };
  if (f.repeat && f.repeat !== 'CUSTOM') body.recurrence = rrule(f.repeat);
  return toOutput(await gapi(calendarId, '', { method: 'POST', body }));
}

// scope 'one': just this event (or this occurrence of a repeating one).
// scope 'all': every event in its series. The series keeps its own first
// date; whatever date/time change was made to this occurrence is applied to
// the whole series.
export async function gcalUpdate(calendarId, id, scope, input, zone) {
  const f = readForm(input, zone);
  const tzQuery = { timeZone: f.timeZone };
  const item = await gapi(calendarId, '/' + encodeURIComponent(id), { query: tzQuery });
  const seriesId = item.recurringEventId || (item.recurrence ? item.id : null);

  if (scope !== 'all' || !seriesId) {
    const body = { ...details(f), ...merge(clearOther(f), times(f)) };
    // A one-off event can be made to repeat from here.
    if (!seriesId && f.repeat && f.repeat !== 'CUSTOM') body.recurrence = rrule(f.repeat);
    return toOutput(await gapi(calendarId, '/' + encodeURIComponent(id), { method: 'PATCH', body }));
  }

  const master = item.recurringEventId ? await gapi(calendarId, '/' + encodeURIComponent(seriesId), { query: tzQuery }) : item;
  const was = item.originalStartTime || item.start;
  const shiftDays = daysBetween(day(was.date || was.dateTime), f.startDate);
  const masterStart = day(master.start.date || master.start.dateTime);
  const body = { ...details(f), ...merge(clearOther(f), times(f, addDays(masterStart, shiftDays))) };
  if (f.repeat !== 'CUSTOM') {
    body.recurrence = f.repeat
      ? (master.recurrence || []).filter(l => !/^RRULE:/.test(l)).concat(rrule(f.repeat))
      : [];
  }
  return toOutput(await gapi(calendarId, '/' + encodeURIComponent(seriesId), { method: 'PATCH', body }));
}

export async function gcalDelete(calendarId, id, scope) {
  let target = id;
  if (scope === 'all') {
    const item = await gapi(calendarId, '/' + encodeURIComponent(id));
    target = item.recurringEventId || id;
  }
  await gapi(calendarId, '/' + encodeURIComponent(target), { method: 'DELETE' });
}

function merge(a, b) {
  return { start: { ...a.start, ...b.start }, end: { ...a.end, ...b.end } };
}
