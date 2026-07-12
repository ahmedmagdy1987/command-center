/* =================================================================================
   SANITIZE — normalize task/project shapes regardless of source (DB, import, etc)
================================================================================= */

const PRIORITY_IDS = new Set(['critical', 'high', 'medium', 'low']);
const STATUS_IDS = new Set(['inbox', 'must', 'should', 'waiting', 'scheduled', 'done']);
const EFFORT_IDS = new Set(['quick', 'medium', 'deep']);

const LEGACY_PROJECT_MAP = { content: 'blogs', design: 'assets', operations: 'tools', admin: 'other' };
export const migrateProjectId = (id) => LEGACY_PROJECT_MAP[id] || id;

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const nowISO = () => new Date().toISOString();

// URL-scheme allowlist for user-supplied task links. task.links has no clickable render site
// today, so this is defense-in-depth: it guarantees a javascript:/data:/vbscript: URL can never
// be stored on a link and reach a future render. Legitimate http(s)/mailto links pass through
// unchanged; any other property on a link object is preserved.
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
export const safeLinkUrl = (u) => {
  if (typeof u !== 'string' || !u) return '';
  try { return SAFE_LINK_SCHEMES.has(new URL(u, 'https://x.invalid').protocol) ? u.trim() : ''; }
  catch { return ''; }
};
const normalizeLinks = (arr) =>
  Array.isArray(arr)
    ? arr.filter(l => l && typeof l === 'object').map(l => {
        const out = { ...l };
        if ('url' in out) out.url = safeLinkUrl(out.url);
        if ('href' in out) out.href = safeLinkUrl(out.href);
        return out;
      })
    : [];

/** Convert a DB-shaped task (snake_case columns) to app shape (camelCase) */
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

/** Convert app shape (camelCase) → DB shape (snake_case) */
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
  const project = (typeof migratedProject === 'string' && migratedProject) ? migratedProject : 'other';
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    title: typeof t.title === 'string' ? t.title : 'Untitled task',
    description: typeof t.description === 'string' ? t.description : '',
    assigneeId, privacy, project, status, priority, effort,
    urgent: !!t.urgent,
    important: !!t.important,
    blocked: !!t.blocked,
    blockedReason: typeof t.blockedReason === 'string' ? t.blockedReason : '',
    dueDate: typeof t.dueDate === 'string' ? t.dueDate : null,
    scheduledDate: typeof t.scheduledDate === 'string' ? t.scheduledDate : null,
    estimatedMinutes: typeof t.estimatedMinutes === 'number' && isFinite(t.estimatedMinutes) ? t.estimatedMinutes : 30,
    tags: Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [],
    subtasks: Array.isArray(t.subtasks) ? t.subtasks.filter(s => s && typeof s === 'object').map(s => ({
      id: typeof s.id === 'string' && s.id ? s.id : uid(),
      title: typeof s.title === 'string' ? s.title : '',
      done: !!s.done,
    })) : [],
    links: normalizeLinks(t.links),
    recurring: t.recurring && (typeof t.recurring === 'string' || typeof t.recurring === 'object') ? t.recurring : null,
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
/** Convert a DB-shaped notification (snake_case columns) to app shape (camelCase) */
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
/** Convert a DB-shaped comment (snake_case columns) to app shape (camelCase) */
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
/** Convert a DB-shaped task_attachments row (snake_case) to app shape (camelCase) */
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
/** Convert a DB-shaped chat message (snake_case columns) to app shape (camelCase) */
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
/** Convert a DB-shaped dm_conversations row to app shape. */
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

/** Convert a DB-shaped dm_messages row to app shape (mirrors fromDbMessage + conversationId). */
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
