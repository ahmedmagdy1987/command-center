// @ts-check
/* =================================================================================
   SANITIZE — normalize task/project shapes regardless of source (DB, import, etc)

   This is the ONLY sanctioned crossing between DB shape (snake_case rows) and app shape
   (camelCase). Reading `row.workspace_id` anywhere outside this file is a bug.

   Type-checked (`// @ts-check`) — shapes come from ./types.js. See that file's ID
   DISCIPLINE note for why `tasks.id` is TEXT and not a uuid.
================================================================================= */

/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./types.js').TaskRow} TaskRow */
/** @typedef {import('./types.js').TaskWrite} TaskWrite */
/** @typedef {import('./types.js').TaskLink} TaskLink */
/** @typedef {import('./types.js').Subtask} Subtask */
/** @typedef {import('./types.js').Notification} Notification */
/** @typedef {import('./types.js').NotificationRow} NotificationRow */
/** @typedef {import('./types.js').Comment} Comment */
/** @typedef {import('./types.js').CommentRow} CommentRow */
/** @typedef {import('./types.js').Message} Message */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').DmConversation} DmConversation */
/** @typedef {import('./types.js').DirectMessage} DirectMessage */
/** @typedef {import('./types.js').Attachment} Attachment */
/** @typedef {import('./types.js').AttachmentRow} AttachmentRow */

const PRIORITY_IDS = new Set(['critical', 'high', 'medium', 'low']);
const STATUS_IDS = new Set(['inbox', 'must', 'should', 'waiting', 'scheduled', 'done']);
const EFFORT_IDS = new Set(['quick', 'medium', 'deep']);

/** @type {Record<string, string>} */
const LEGACY_PROJECT_MAP = { content: 'blogs', design: 'assets', operations: 'tools', admin: 'other' };
/**
 * Remap a retired seed project id to its current one. Unknown ids pass through unchanged.
 * @param {string} id
 * @returns {string}
 */
export const migrateProjectId = (id) => LEGACY_PROJECT_MAP[id] || id;

/**
 * Client-generated id. NOTE: this is NOT a uuid — it is ~12 chars of base36. It is valid for
 * `tasks.id` / `projects.id` (both TEXT) and for a storage object name, and INVALID for any
 * uuid column (`workspace_id`, `assignee_id`, `created_by`, …), which would reject it with
 * `22P02 invalid input syntax for type uuid`. See the ID DISCIPLINE note in ./types.js.
 * @returns {string}
 */
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** @returns {import('./types.js').IsoTimestamp} */
export const nowISO = () => new Date().toISOString();

// Caps on user-supplied fields. Two different jobs here:
//  - ID_MAX_LEN mirrors the server-side CHECKs (tasks_id_len_chk / tasks_project_len_chk /
//    projects_id_len_chk, all 1..64) so a bad value degrades gracefully instead of hitting a raw
//    23514 that aborts the whole bulk-insert statement.
//  - The collection caps have NO server-side counterpart: tags/subtasks/links/recurring are jsonb
//    with no CHECK, so these are the only limit on a crafted import (a 5000-subtask, 50k-char-tag
//    row was accepted before). Flagged for a future DB-side jsonb cap.
export const ID_MAX_LEN = 64;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 100;
const MAX_SUBTASKS = 200;
const MAX_LINKS = 50;
const MAX_LINK_TEXT_LEN = 500;
const MAX_RECURRING_CHARS = 2000;

// URL-scheme allowlist for user-supplied task links. task.links has no clickable render site
// today, so this is defense-in-depth: it guarantees a javascript:/data:/vbscript: URL can never
// be stored on a link and reach a future render. Legitimate http(s)/mailto links pass through.
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
/**
 * @param {unknown} u
 * @returns {string} The trimmed URL, or `''` if it is not a string or its scheme is not allowlisted.
 */
export const safeLinkUrl = (u) => {
  if (typeof u !== 'string' || !u) return '';
  try { return SAFE_LINK_SCHEMES.has(new URL(u, 'https://x.invalid').protocol) ? u.trim() : ''; }
  catch { return ''; }
};
/**
 * @param {unknown} v
 * @returns {string}
 */
const linkText = (v) => (typeof v === 'string' ? v.slice(0, MAX_LINK_TEXT_LEN) : '');
// Whitelist the known link properties rather than spreading. The old `{...l}` preserved ANY property,
// so a crafted import could park an arbitrarily large blob on a link and it went straight into the
// links jsonb unbounded. No live rows carry links, so nothing is lost by narrowing this.
/**
 * @param {unknown} arr
 * @returns {TaskLink[]}
 */
const normalizeLinks = (arr) =>
  Array.isArray(arr)
    ? arr.filter(l => l && typeof l === 'object').slice(0, MAX_LINKS).map(l => ({
        url: safeLinkUrl(l.url),
        label: linkText(l.label ?? l.title ?? l.text),
      }))
    : [];

// A recurring rule is a short string or a small object; anything bigger is not a rule.
/**
 * @param {unknown} r
 * @returns {unknown} The rule as given if within caps, else null.
 */
const normalizeRecurring = (r) => {
  if (typeof r === 'string') return r.length <= MAX_RECURRING_CHARS ? r : null;
  if (r && typeof r === 'object') {
    try { return JSON.stringify(r).length <= MAX_RECURRING_CHARS ? r : null; } catch { return null; }
  }
  return null;
};

/**
 * Convert a DB-shaped task (snake_case columns) to app shape (camelCase).
 * @param {TaskRow | null | undefined} row
 * @returns {Task | null} `null` for an absent/non-object row — EVERY caller must handle it.
 *   This is the null that reaches the UI as a blank card if ignored.
 */
export const fromDbTask = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description || '',
    assigneeId: row.assignee_id,
    privacy: row.privacy,
    project: row.project,
    status: row.status,
    priority: row.priority,
    effort: row.effort,
    urgent: !!row.urgent,
    important: !!row.important,
    blocked: !!row.blocked,
    blockedReason: row.blocked_reason || '',
    dueDate: row.due_date,
    scheduledDate: row.scheduled_date,
    estimatedMinutes: row.estimated_minutes,
    tags: Array.isArray(row.tags) ? row.tags : [],
    subtasks: Array.isArray(row.subtasks) ? row.subtasks : [],
    links: normalizeLinks(row.links),
    recurring: row.recurring,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    order: Number(row.task_order) || Date.now(),
  };
};

/**
 * Convert app shape (camelCase) → DB shape (snake_case) for a write.
 *
 * The return is deliberately PARTIAL: a key whose value is `undefined` is omitted by
 * PostgREST, which is how an update patch leaves untouched columns alone. `links` relies on
 * this explicitly — see the note below.
 *
 * @param {Partial<Task>} task
 * @returns {TaskWrite}
 */
export const toDbTask = (task) => {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    assignee_id: task.assigneeId,
    privacy: task.privacy,
    project: task.project,
    status: task.status,
    priority: task.priority,
    effort: task.effort,
    urgent: task.urgent,
    important: task.important,
    blocked: task.blocked,
    blocked_reason: task.blockedReason,
    due_date: task.dueDate,
    scheduled_date: task.scheduledDate,
    estimated_minutes: task.estimatedMinutes,
    tags: task.tags,
    subtasks: task.subtasks,
    recurring: task.recurring,
    // Scrub link URL schemes on the WRITE path too (create already runs sanitizeTask; this closes the
    // update path). Preserve undefined so an unrelated update patch doesn't clobber existing links with [].
    links: task.links === undefined ? undefined : normalizeLinks(task.links),
    created_by: task.createdBy,
    completed_at: task.completedAt,
    task_order: task.order,
  };
};

/**
 * Normalize ANY task-shaped input into a valid `Task`. Used on create and on bulk import,
 * so the input is genuinely untrusted and arbitrary — hence `any` on the way in. The
 * valuable half of this contract is the OUTPUT: whatever goes in, a complete `Task` with
 * every field within the server-side CHECK limits comes out.
 *
 * @param {any} raw Untrusted — a DB row, an imported JSON blob, or a partial UI draft.
 * @returns {Task}
 */
export const sanitizeTask = (raw) => {
  const t = raw && typeof raw === 'object' ? raw : {};
  const priority = PRIORITY_IDS.has(t.priority) ? t.priority : 'medium';
  const status = STATUS_IDS.has(t.status) ? t.status : 'inbox';
  const effort = EFFORT_IDS.has(t.effort) ? t.effort : 'medium';
  // Visibility is now INDEPENDENT of assignment: 'workspace' (shared) or 'private' (creator + assignee).
  const privacy = (t.privacy === 'private' || t.privacy === 'workspace') ? t.privacy : 'workspace';
  // Assignee: a single workspace member (auth user id) or null (unassigned).
  const assigneeId = (typeof t.assigneeId === 'string' && t.assigneeId) ? t.assigneeId : null;
  // Accept any non-empty project id (projects are user-creatable now); keep the legacy id remap.
  // Default to 'other' only when missing/blank — no longer clamp to a hardcoded whitelist.
  const migratedProject = migrateProjectId(t.project);
  // Fall back to 'other' when missing/blank OR over the server-side CHECK (an over-long slug would
  // otherwise 23514 and abort the whole bulk-insert statement).
  const project = (typeof migratedProject === 'string' && migratedProject && migratedProject.length <= ID_MAX_LEN)
    ? migratedProject : 'other';
  return {
    // Mint a fresh id rather than TRUNCATING an over-long one — truncation could collide with a real
    // task's id (tasks.id is a global PK) and a collision aborts the entire batch.
    id: (typeof t.id === 'string' && t.id && t.id.length <= ID_MAX_LEN) ? t.id : uid(),
    // Clamp to the server-side length CHECKs (migration 20260713180216) so the bulk-import path — which
    // bypasses the UI's maxLength — degrades gracefully instead of hitting a raw DB constraint error.
    title: typeof t.title === 'string' ? t.title.slice(0, 500) : 'Untitled task',
    description: typeof t.description === 'string' ? t.description.slice(0, 20000) : '',
    assigneeId, privacy, project, status, priority, effort,
    urgent: !!t.urgent,
    important: !!t.important,
    blocked: !!t.blocked,
    blockedReason: typeof t.blockedReason === 'string' ? t.blockedReason.slice(0, 1000) : '',
    dueDate: typeof t.dueDate === 'string' ? t.dueDate : null,
    scheduledDate: typeof t.scheduledDate === 'string' ? t.scheduledDate : null,
    estimatedMinutes: typeof t.estimatedMinutes === 'number' && isFinite(t.estimatedMinutes) ? t.estimatedMinutes : 30,
    tags: Array.isArray(t.tags)
      ? t.tags.filter(x => typeof x === 'string').slice(0, MAX_TAGS).map(x => x.slice(0, MAX_TAG_LEN))
      : [],
    subtasks: Array.isArray(t.subtasks) ? t.subtasks.filter(s => s && typeof s === 'object').slice(0, MAX_SUBTASKS).map(s => ({
      id: (typeof s.id === 'string' && s.id && s.id.length <= ID_MAX_LEN) ? s.id : uid(),
      title: typeof s.title === 'string' ? s.title.slice(0, 500) : '',
      done: !!s.done,
    })) : [],
    links: normalizeLinks(t.links),
    recurring: normalizeRecurring(t.recurring),
    createdBy: t.createdBy || null,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : nowISO(),
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : nowISO(),
    completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
    order: typeof t.order === 'number' ? t.order : Date.now(),
  };
};

/* =================================================================================
   NOTIFICATIONS
================================================================================= */
/**
 * Convert a DB-shaped notification to app shape.
 * @param {NotificationRow | null | undefined} row
 * @returns {Notification | null}
 */
export const fromDbNotification = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    recipientId: row.recipient_id,
    actorId: row.actor_id,
    taskId: row.task_id,
    refId: row.ref_id,        // polymorphic reference (e.g. a DM conversation id for type='dm_received')
    type: row.type,
    title: row.title,
    message: row.message,
    read: !!row.read,
    createdAt: row.created_at,
  };
};

/* =================================================================================
   COMMENTS
================================================================================= */
/**
 * Convert a DB-shaped comment to app shape.
 * @param {CommentRow | null | undefined} row
 * @returns {Comment | null}
 */
export const fromDbComment = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    authorId: row.author_id,
    body: row.body,
    mentions: Array.isArray(row.mentions) ? row.mentions : [],   // user ids @mentioned in this comment
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/* =================================================================================
   TASK ATTACHMENTS
================================================================================= */
/**
 * Convert a DB-shaped task_attachments row to app shape.
 * @param {AttachmentRow | null | undefined} row
 * @returns {Attachment | null}
 */
export const fromDbAttachment = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    uploadedBy: row.uploaded_by,
    storagePath: row.storage_path,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
};

/* =================================================================================
   MESSAGES (team chat)
================================================================================= */
/**
 * Convert a DB-shaped team-chat message to app shape.
 * NOTE `senderId` is nullable — a departed member's messages survive with a null sender.
 * Filtering senders with `!==` silently drops them; compare with null-safe semantics.
 * @param {MessageRow | null | undefined} row
 * @returns {Message | null}
 */
export const fromDbMessage = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderId: row.sender_id,
    body: row.body,
    audioPath: row.audio_path,
    audioDuration: row.audio_duration_seconds,
    mentions: Array.isArray(row.mentions) ? row.mentions : [],   // user ids @mentioned in this message
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,     // non-null once edited; drives the "(edited)" marker
    deletedAt: row.deleted_at,   // non-null = tombstone; content is stripped server-side
  };
};

/* =================================================================================
   DIRECT MESSAGES (1:1)
================================================================================= */
/**
 * Convert a DB-shaped dm_conversations row to app shape.
 * @param {any} row
 * @returns {DmConversation | null}
 */
export const fromDbDmConversation = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userLo: row.user_lo,
    userHi: row.user_hi,
    createdAt: row.created_at,
  };
};

/**
 * Convert a DB-shaped dm_messages row to app shape (mirrors fromDbMessage + conversationId).
 * @param {any} row
 * @returns {DirectMessage | null}
 */
export const fromDbDirectMessage = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    senderId: row.sender_id,
    body: row.body,
    audioPath: row.audio_path,
    audioDuration: row.audio_duration_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,     // non-null once edited; drives the "(edited)" marker
    deletedAt: row.deleted_at,   // non-null = tombstone; content is stripped server-side
  };
};
