/* =================================================================================
   SANITIZE — normalize task/project shapes regardless of source (DB, import, etc)
================================================================================= */

const OWNER_IDS = new Set(['me', 'va', 'shared']);
const PRIORITY_IDS = new Set(['critical', 'high', 'medium', 'low']);
const STATUS_IDS = new Set(['inbox', 'must', 'should', 'waiting', 'scheduled', 'done']);
const EFFORT_IDS = new Set(['quick', 'medium', 'deep']);
const DEFAULT_PROJECT_IDS = new Set(['social','blogs','seo','outreach','assets','personal','website','tools','other']);

const LEGACY_PROJECT_MAP = { content: 'blogs', design: 'assets', operations: 'tools', admin: 'other' };
export const migrateProjectId = (id) => LEGACY_PROJECT_MAP[id] || id;

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const nowISO = () => new Date().toISOString();

/** Convert a DB-shaped task (snake_case columns) to app shape (camelCase) */
export const fromDbTask = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    owner: row.owner,
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
    links: Array.isArray(row.links) ? row.links : [],
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
    owner: task.owner,
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
    links: task.links,
    recurring: task.recurring,
    created_by: task.createdBy,
    completed_at: task.completedAt,
    task_order: task.order,
  };
};

export const sanitizeTask = (raw) => {
  const t = raw && typeof raw === 'object' ? raw : {};
  const owner = OWNER_IDS.has(t.owner) ? t.owner : 'me';
  const priority = PRIORITY_IDS.has(t.priority) ? t.priority : 'medium';
  const status = STATUS_IDS.has(t.status) ? t.status : 'inbox';
  const effort = EFFORT_IDS.has(t.effort) ? t.effort : 'medium';
  // Category drives privacy: 'me' is private to its creator; 'va'/'shared' are workspace.
  // Mirrors the DB tasks_align_privacy trigger so optimistic state matches what gets stored.
  const privacy = owner === 'me' ? 'private' : 'workspace';
  const migratedProject = migrateProjectId(t.project);
  const project = DEFAULT_PROJECT_IDS.has(migratedProject) ? migratedProject : 'other';
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    title: typeof t.title === 'string' ? t.title : 'Untitled task',
    description: typeof t.description === 'string' ? t.description : '',
    owner, privacy, project, status, priority, effort,
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
    links: Array.isArray(t.links) ? t.links.filter(l => l && typeof l === 'object') : [],
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
    recipientId: row.recipient_id,
    actorId: row.actor_id,
    taskId: row.task_id,
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
    taskId: row.task_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    senderId: row.sender_id,
    body: row.body,
    audioPath: row.audio_path,
    audioDuration: row.audio_duration_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
