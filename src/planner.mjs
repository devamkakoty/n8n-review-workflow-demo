import { createHash } from 'node:crypto';

/**
 * Synthetic fixture planner only: no LLM calls, execution, sending or integrations.
 * Input keys (no extras): {notes, ledger = {}, enabled = true}.
 * notes: <=50 dense items {noteId, text, modelResult}; noteId: 1..128 chars,
 * text: 0..20000 chars. modelResult: {status:'unavailable'} OR
 * {status:'ok', actions:[{kind, title, body?, dueAt?}]} (<=10 actions).
 * kind: task|email_draft|calendar_draft; title: 1..200 nonblank chars;
 * body: <=4000 chars; dueAt: <=64 nonblank chars (opaque, NOT date-validated).
 * Text/draft content is untrusted inert text, not HTML or instructions to execute.
 * Consumers must escape it for their display context and require human review.
 * Ledger: <=1000 own noteId keys, each {textHash, proposalIds}; textHash is
 * lowercase SHA256 hex, proposalIds is <=10 unique "proposal_<SHA256>" strings.
 * Only ordinary/null-prototype records and dense ordinary arrays are accepted;
 * unknown fields, accessors, symbols and non-JSON-ish field values are rejected.
 *
 * Output keys: {results, ledger, summary}. Every result has exactly
 * {noteId, status, proposals, error}; noteId is string or null for invalid input;
 * error is null or a static error-code string (never includes source content).
 * Status: pending_review|no_actions|duplicate|conflict|model_unavailable|
 * invalid|disabled. Proposals: {id, sourceNoteId, kind, title, body?, dueAt?,
 * status:'pending_review', autoExecute:false}. IDs hash canonical action content,
 * note identity/text hash and action index. No fields are executable.
 * summary: {total, pending_review, no_actions, duplicate, conflict,
 * model_unavailable, invalid, disabled, proposalCount} (integer counts).
 *
 * Invalid envelope/ledger throws TypeError; malformed notes return invalid.
 * Enabled notes are fully shape-validated before duplicate/conflict checks.
 * Successful notes, including no_actions, update a cloned ledger; failures do
 * not. Disabled skips note validation and returns disabled for each batch slot,
 * preserving the validated ledger's contents in an independent clone.
 * All outputs are fresh; ledger holds only hashes/IDs, never text/draft bodies.
 * Strings must be well-formed Unicode; bounds use JS UTF-16 string lengths.
 * Caller objects must not be hostile Proxies.
 */
const LIMIT = { notes: 50, ledger: 1000, actions: 10 };
const STATUSES = ['pending_review', 'no_actions', 'duplicate', 'conflict',
  'model_unavailable', 'invalid', 'disabled'];
const own = (o, k) => Object.hasOwn(o, k);
const fail = (code) => { throw new TypeError(code); };
const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function record(value) {
  if (!value || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('invalid_record');
  }
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !own(d, 'value')) {
      fail('invalid_record');
    }
  }
  return value;
}

function shape(value, required, optional = []) {
  record(value);
  if (required.some((key) => !own(value, key)) ||
      Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    fail('invalid_fields');
  }
  return value;
}

function list(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > max || Reflect.ownKeys(value).length !== value.length + 1) {
    fail('invalid_array');
  }
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !own(d, 'value')) fail('invalid_array');
  }
  return value;
}

function text(value, max, nonblank = false) {
  if (typeof value !== 'string' || value.length > max ||
      /[\uD800-\uDFFF]/u.test(value) || (nonblank && !value.trim())) fail('invalid_string');
  return value;
}

function cloneLedger(value) {
  record(value);
  if (Object.keys(value).length > LIMIT.ledger) fail('invalid_ledger');
  return new Map(Object.entries(value).map(([id, entry]) => {
    text(id, 128, true);
    shape(entry, ['textHash', 'proposalIds']);
    if (typeof entry.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.textHash)) {
      fail('invalid_ledger_hash');
    }
    const ids = list(entry.proposalIds, LIMIT.actions);
    if (ids.some((id) => typeof id !== 'string' || !/^proposal_[a-f0-9]{64}$/.test(id)) ||
        new Set(ids).size !== ids.length) fail('invalid_ledger_ids');
    return [id, { textHash: entry.textHash, proposalIds: [...ids] }];
  }));
}

function validateNote(note) {
  shape(note, ['noteId', 'text', 'modelResult']);
  text(note.noteId, 128, true);
  text(note.text, 20000);
  const model = record(note.modelResult);
  if (model.status === 'unavailable') {
    shape(model, ['status']);
    return [];
  }
  if (model.status !== 'ok') fail('invalid_model_status');
  shape(model, ['status', 'actions']);
  return list(model.actions, LIMIT.actions).map((action) => {
    shape(action, ['kind', 'title'], ['body', 'dueAt']);
    if (!['task', 'email_draft', 'calendar_draft'].includes(action.kind)) {
      fail('unsupported_action_kind');
    }
    const clean = { kind: action.kind, title: text(action.title, 200, true) };
    if (own(action, 'body')) clean.body = text(action.body, 4000);
    if (own(action, 'dueAt')) clean.dueAt = text(action.dueAt, 64, true);
    return clean;
  });
}

function safeNoteId(note) {
  if (!note || typeof note !== 'object') return null;
  const d = Object.getOwnPropertyDescriptor(note, 'noteId');
  return d && own(d, 'value') && typeof d.value === 'string' &&
    d.value.length <= 128 && d.value.trim() ? d.value : null;
}

export function planReviewBatch(input) {
  shape(input, ['notes'], ['ledger', 'enabled']);
  const { notes, ledger = {}, enabled = true } = input;
  list(notes, LIMIT.notes);
  if (typeof enabled !== 'boolean') fail('invalid_enabled');
  const next = cloneLedger(ledger);
  const results = notes.map((note) => {
    const result = { noteId: safeNoteId(note), status: 'disabled', proposals: [], error: null };
    const reject = (status, error) => Object.assign(result, { status, error });
    if (!enabled) return result;
    let actions;
    try { actions = validateNote(note); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return reject('invalid', error.message);
    }
    const textHash = hash(note.text);
    const prior = next.get(note.noteId);
    if (prior) return prior.textHash === textHash
      ? Object.assign(result, { status: 'duplicate' })
      : reject('conflict', 'note_text_changed');
    if (note.modelResult.status === 'unavailable') {
      return reject('model_unavailable', 'model_unavailable');
    }
    if (next.size >= LIMIT.ledger) return reject('invalid', 'ledger_capacity_exceeded');
    result.proposals = actions.map((action, index) => ({
      id: `proposal_${hash(JSON.stringify([note.noteId, textHash, index, action]))}`,
      sourceNoteId: note.noteId,
      ...action,
      status: 'pending_review',
      autoExecute: false,
    }));
    result.status = actions.length ? 'pending_review' : 'no_actions';
    next.set(note.noteId, { textHash, proposalIds: result.proposals.map((p) => p.id) });
    return result;
  });
  const summary = { total: results.length,
    ...Object.fromEntries(STATUSES.map((s) => [s, 0])), proposalCount: 0 };
  for (const result of results) {
    summary[result.status]++;
    summary.proposalCount += result.proposals.length;
  }
  return { results, ledger: Object.fromEntries(next), summary };
}
