// Credit scores: typed in (no API gives a person their own score), or read
// from a screenshot of a bank app or Credit Karma by Claude. The image is
// read and thrown away; only the numbers the family confirms are kept.
//
// state.credit: [{ id, person (email), score, model, bureau, date, source,
//   private }]. A private entry is seen only by its person.

import Anthropic from '@anthropic-ai/sdk';
import { updateState, familyDay } from './data.js';
import { financeEmails } from '../session.js';
import { randomId } from '../recipes.js';

const MODEL = 'claude-opus-5-5';
const fail = (status, message) => Object.assign(new Error(message), { status });
export const MODELS = ['FICO 8', 'FICO 9', 'FICO 10', 'FICO Bankcard 8', 'FICO Auto 8', 'VantageScore 3.0', 'VantageScore 4.0', 'Other'];
export const BUREAUS = ['Experian', 'Equifax', 'TransUnion'];

export function visibleCredit(state, viewer) {
  return (state.credit || []).filter(c => !c.private || c.person === viewer)
    .slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function saveCredit(input, viewer) {
  input = input || {};
  return updateState(s => {
    s.credit = s.credit || [];
    let c = input.id ? s.credit.find(x => x.id === input.id) : null;
    if (input.id && (!c || (c.private && c.person !== viewer))) throw fail(404, 'That score wasn’t found.');
    const score = Math.round(Number(input.score));
    if (!Number.isFinite(score) || score < 250 || score > 900) throw fail(400, 'Credit scores run from about 300 to 850.');
    const date = String(input.date || familyDay());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > familyDay()) throw fail(400, 'Pick the date of the score, today or earlier.');
    const priv = !!input.private;
    const person = priv ? viewer : String(input.person || viewer).toLowerCase();
    if (!financeEmails().includes(person)) throw fail(400, 'Pick whose score this is.');
    const fields = {
      person, score, date, private: priv,
      model: String(input.model || '').trim().slice(0, 40),
      bureau: BUREAUS.includes(input.bureau) ? input.bureau : '',
      source: String(input.source || '').trim().slice(0, 40),
      updatedBy: viewer, updatedAt: new Date().toISOString()
    };
    if (c) Object.assign(c, fields);
    else s.credit.push({ id: 'c_' + randomId(10), createdBy: viewer, ...fields });
    if (s.credit.length > 600) s.credit = s.credit.slice(-600);
  });
}

export function deleteCredit(id, viewer) {
  return updateState(s => {
    const c = (s.credit || []).find(x => x.id === id);
    if (!c || (c.private && c.person !== viewer)) throw fail(404, 'That score wasn’t found.');
    s.credit = s.credit.filter(x => x.id !== id);
  });
}

// A screenshot in, the score's details out (to fill the form; nothing saved).
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['found', 'score', 'model', 'bureau', 'date', 'source'],
  properties: {
    found: { type: 'boolean', description: 'False when the image shows no credit score.' },
    score: { type: 'integer', description: 'The credit score number, or 0 when there is none.' },
    model: { type: 'string', enum: MODELS.concat(''), description: 'The scoring model if shown or clearly implied (Credit Karma shows VantageScore 3.0), otherwise empty.' },
    bureau: { type: 'string', enum: BUREAUS.concat(''), description: 'The credit bureau the score is based on, if shown, otherwise empty.' },
    date: { type: 'string', description: 'The date the score is as of, YYYY-MM-DD, if shown, otherwise empty.' },
    source: { type: 'string', description: 'The app or company showing the score (e.g. Credit Karma, Chase, Discover), if recognizable, otherwise empty.' }
  }
};
const TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };

export async function readScreenshot(bytes, contentType) {
  if (!process.env.ANTHROPIC_API_KEY) throw fail(503, 'Reading screenshots isn’t set up (ANTHROPIC_API_KEY is missing). You can type the score in.');
  if (!TYPES[contentType]) throw fail(415, 'That doesn’t look like a picture. Try a PNG or JPEG screenshot.');
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw fail(413, 'That picture is too big (4 MB at most).');
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: 'You read credit-score screenshots from banking and credit apps for a family\'s private finance dashboard. Report only what the image shows. Today is ' + familyDay() + '; a screenshot without a date is probably from today.',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: contentType, data: bytes.toString('base64') } },
        { type: 'text', text: 'What credit score does this show?' }
      ] }]
    });
  } catch (e) {
    console.error('Finance credit read: Claude request failed', e && e.constructor && e.constructor.name, e && e.status);
    throw fail(502, 'The screenshot couldn’t be read right now. You can type the score in.');
  }
  if (res.stop_reason === 'refusal') throw fail(422, 'Couldn’t read a score from that picture.');
  const block = res.content.find(b => b.type === 'text');
  let out;
  try { out = JSON.parse(block ? block.text : ''); } catch (e) { throw fail(502, 'The screenshot reader sent back something unexpected. Try again.'); }
  if (!out.found || !out.score) throw fail(422, 'No credit score found in that picture.');
  return {
    score: out.score,
    model: MODELS.includes(out.model) ? out.model : '',
    bureau: BUREAUS.includes(out.bureau) ? out.bureau : '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date) && out.date <= familyDay() ? out.date : familyDay(),
    source: String(out.source || '').slice(0, 40)
  };
}
