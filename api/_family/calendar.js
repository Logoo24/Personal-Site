// Reads the family Google Calendar's public iCal feed and returns the events
// in a date range as JSON, with repeating events expanded. Covers the
// RRULE features Google Calendar writes (DAILY/WEEKLY/MONTHLY/YEARLY with
// INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH), EXDATEs, edited
// single occurrences (RECURRENCE-ID) and cancelled events.

const CALENDAR_ID = 'e01d9910072240adacfad01c0bef6a3b6a351b7f1b92615ce33c4f8a02433cc0@group.calendar.google.com';
export const ICS_URL = process.env.FAMILY_CALENDAR_ICS ||
  `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;
export const CALENDAR_LINKS = {
  open: `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(CALENDAR_ID)}&ctz=America%2FBoise`,
  subscribe: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(CALENDAR_ID)}`
};
const DEFAULT_TZ = 'America/Boise';
const DAY = 86400000;

let cache = null; // { at, events }

// ---------- iCal parsing ----------

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const p = {};
  for (const kv of params) { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1).replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

const unescapeText = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseEvents(text) {
  const events = [];
  let ev = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const l = parseLine(line);
    if (!l) continue;
    switch (l.name) {
      case 'UID': ev.uid = l.value; break;
      case 'SUMMARY': ev.title = unescapeText(l.value); break;
      case 'LOCATION': ev.location = unescapeText(l.value); break;
      case 'DESCRIPTION': ev.description = unescapeText(l.value); break;
      case 'STATUS': ev.status = l.value; break;
      case 'DTSTART': ev.start = parseTime(l); break;
      case 'DTEND': ev.end = parseTime(l); break;
      case 'DURATION': ev.duration = parseDuration(l.value); break;
      case 'RRULE': ev.rrule = Object.fromEntries(l.value.split(';').map(kv => kv.split('='))); break;
      case 'EXDATE': for (const v of l.value.split(',')) ev.exdates.push(parseTime({ ...l, value: v })); break;
      case 'RECURRENCE-ID': ev.recurrenceId = parseTime(l); break;
    }
  }
  return events;
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  return ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000) * (m[1] === '-' ? -1 : 1);
}

// A time as { wall: ms of the wall-clock time treated as UTC, tz, allDay }.
// Recurrences are expanded in wall-clock time so they keep their local time
// across daylight-saving changes, then converted to real instants.
function parseTime(l) {
  const v = l.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[4] || l.params.VALUE === 'DATE') return { wall, allDay: true, tz: null };
  return { wall, allDay: false, tz: m[7] ? 'UTC' : (l.params.TZID || DEFAULT_TZ) };
}

const dtfCache = {};
function tzOffset(instant, tz) {
  if (tz === 'UTC') return 0;
  const dtf = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }));
  const p = Object.fromEntries(dtf.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant;
}
function toInstant(t) {
  if (!t || t.allDay || t.tz === 'UTC') return t ? t.wall : null;
  let guess = t.wall - tzOffset(t.wall, t.tz);
  guess = t.wall - tzOffset(guess, t.tz);
  return guess;
}

// ---------- recurrence expansion ----------

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function byDays(rule) {
  return (rule.BYDAY || '').split(',').filter(Boolean).map(s => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s);
    return m ? { n: m[1] ? +m[1] : 0, day: WEEKDAYS[m[2]] } : null;
  }).filter(Boolean);
}

// Day-of-month candidates (1-based) in a month, per BYDAY / BYMONTHDAY.
function daysInMonth(y, mo, rule, startDay) {
  const len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const out = new Set();
  const bd = byDays(rule);
  if (rule.BYMONTHDAY) {
    for (const s of rule.BYMONTHDAY.split(',')) { const d = +s < 0 ? len + 1 + +s : +s; if (d >= 1 && d <= len) out.add(d); }
  } else if (bd.length) {
    for (const { n, day } of bd) {
      const hits = [];
      for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === day) hits.push(d);
      if (!n) hits.forEach(d => out.add(d));
      else { const d = n > 0 ? hits[n - 1] : hits[hits.length + n]; if (d) out.add(d); }
    }
  } else if (startDay <= len) {
    out.add(startDay);
  }
  return [...out].sort((a, b) => a - b);
}

// Yields wall-clock start times (ms) in order, until `untilWall` or limits hit.
function* occurrences(ev, untilWall) {
  const rule = ev.rrule;
  const start = ev.start.wall;
  const interval = Math.max(1, +rule.INTERVAL || 1);
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  const until = rule.UNTIL ? parseTime({ value: rule.UNTIL, params: {} }) : null;
  const untilInstant = until ? (until.allDay ? until.wall + DAY - 1 : until.wall) : Infinity;
  const s = new Date(start);
  const tod = start - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  const months = rule.BYMONTH ? rule.BYMONTH.split(',').map(m => +m - 1) : null;
  let emitted = 0;

  function* emitDays(dayStarts) {
    for (const d of dayStarts) {
      const t = d + tod;
      if (t < start) continue;
      if (emitted >= count) return;
      if (toInstant({ ...ev.start, wall: t }) > untilInstant || t > untilWall) { emitted = Infinity; return; }
      emitted++;
      yield t;
    }
  }

  const freq = rule.FREQ;
  const dayStart = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  for (let i = 0; i < 5000 && emitted < count; i++) {
    let days = [];
    if (freq === 'DAILY') {
      const d = dayStart + i * interval * DAY;
      const dt = new Date(d);
      const bd = byDays(rule);
      if ((!months || months.includes(dt.getUTCMonth())) && (!bd.length || bd.some(b => b.day === dt.getUTCDay()))) days = [d];
    } else if (freq === 'WEEKLY') {
      const wkst = WEEKDAYS[rule.WKST || 'MO'];
      const weekStart = dayStart - ((s.getUTCDay() - wkst + 7) % 7) * DAY + i * interval * 7 * DAY;
      const bd = byDays(rule);
      const wanted = bd.length ? bd.map(b => b.day) : [s.getUTCDay()];
      days = wanted.map(day => weekStart + ((day - wkst + 7) % 7) * DAY).sort((a, b) => a - b);
    } else if (freq === 'MONTHLY') {
      const total = s.getUTCMonth() + i * interval;
      const y = s.getUTCFullYear() + Math.floor(total / 12), mo = total % 12;
      if (!months || months.includes(mo)) days = daysInMonth(y, mo, rule, s.getUTCDate()).map(d => Date.UTC(y, mo, d));
    } else if (freq === 'YEARLY') {
      const y = s.getUTCFullYear() + i * interval;
      for (const mo of months || [s.getUTCMonth()]) {
        days.push(...daysInMonth(y, mo, rule.BYDAY || rule.BYMONTHDAY ? rule : {}, s.getUTCDate()).map(d => Date.UTC(y, mo, d)));
      }
    } else {
      yield start;
      return;
    }
    yield* emitDays(days);
    if (emitted === Infinity) return;
  }
}

// ---------- public API ----------

async function loadEvents() {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.events;
  const r = await fetch(ICS_URL, { headers: { 'User-Agent': 'loganbrandall-family-hub' } });
  if (!r.ok) throw Object.assign(new Error(`Calendar feed returned ${r.status}`), { status: 502 });
  const events = parseEvents(await r.text()).filter(e => e.start);
  cache = { at: Date.now(), events };
  return events;
}

function toOutput(ev, startWall, overrideOf) {
  const start = { ...ev.start, wall: startWall };
  const dur = ev.end ? ev.end.wall - ev.start.wall : (ev.duration || (ev.start.allDay ? DAY : 0));
  const end = { ...start, wall: startWall + dur };
  const iso = ms => new Date(ms).toISOString();
  const date = ms => iso(ms).slice(0, 10);
  return {
    id: ev.uid + (overrideOf != null || ev.rrule ? '@' + startWall : ''),
    title: ev.title || '(No title)',
    location: ev.location || '',
    description: (ev.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 2000),
    allDay: !!ev.start.allDay,
    // All-day events are dates (end exclusive); timed events are instants.
    start: ev.start.allDay ? date(start.wall) : iso(toInstant(start)),
    end: ev.start.allDay ? date(end.wall) : iso(toInstant(end)),
    recurring: !!(ev.rrule || ev.recurrenceId)
  };
}

export async function eventsBetween(fromISO, toISO) {
  const from = Date.parse(fromISO + 'T00:00:00Z') - DAY;
  const to = Date.parse(toISO + 'T00:00:00Z') + 2 * DAY;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 450 * DAY) {
    throw Object.assign(new Error('Bad date range'), { status: 400 });
  }
  const all = await loadEvents();
  const overrides = new Map(); // uid -> Set of overridden instants
  for (const e of all) if (e.recurrenceId) {
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Set());
    overrides.get(e.uid).add(toInstant(e.recurrenceId));
  }
  const out = [];
  const inRange = o => {
    const s = Date.parse(o.start), e = Date.parse(o.end) || s;
    return e >= from && s <= to;
  };
  for (const ev of all) {
    if (ev.status === 'CANCELLED') continue;
    if (!ev.rrule || ev.recurrenceId) {
      const o = toOutput(ev, ev.start.wall, ev.recurrenceId ? 1 : null);
      if (inRange(o)) out.push(o);
      continue;
    }
    const skip = new Set([...(overrides.get(ev.uid) || []), ...ev.exdates.filter(Boolean).map(toInstant)]);
    for (const wall of occurrences(ev, to + 14 * 3600000)) {
      if (skip.has(toInstant({ ...ev.start, wall }))) continue;
      const o = toOutput(ev, wall);
      if (inRange(o)) out.push(o);
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
