import { supabase } from './supabase';
import { fromDbTask, toDbTask, sanitizeTask, fromDbNotification, fromDbComment, fromDbMessage, fromDbDmConversation, fromDbDirectMessage, fromDbAttachment, uid } from './sanitize';

/* =================================================================================
   AUTH
================================================================================= */
export const auth = {
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },
  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },
  /** Send a password-reset email. The link lands on /reset-password (origin-based so it works on
   *  prod + localhost); that route detects the recovery session and lets the user set a new password. */
  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/reset-password` : undefined,
    });
    if (error) throw error;
  },
  /** Set a new password for the currently-authenticated user (including a Supabase recovery session). */
  async updatePassword(password) {
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    return data;
  },
  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },
  onAuthChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
    return () => data.subscription.unsubscribe();
  },
};

/* =================================================================================
   MEMBERS
================================================================================= */
export const members = {
  async list() {
    const { data, error } = await supabase.from('members').select('*');
    if (error) throw error;
    return data || [];
  },
  async getCurrent() {
    const session = await auth.getSession();
    if (!session) return null;
    const { data, error } = await supabase.from('members').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    return data;
  },
};

/* =================================================================================
   WORKSPACES (multi-tenancy). RLS (workspaces_select_member) scopes selects to the
   workspaces the caller is a member of.
================================================================================= */
export const workspaces = {
  /** The workspaces the current user belongs to, oldest first. */
  async listMine() {
    const { data, error } = await supabase
      .from('workspaces').select('id,name,slug,created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  /**
   * Create a workspace via the sanctioned SECURITY DEFINER RPC — the ONLY write path into
   * workspaces / workspace_members (both are otherwise SELECT-only under RLS). The DB makes the
   * caller the new workspace's owner; name validation (non-empty, <=80) and the auth check run
   * server-side, so those errors surface here. The DB generates a unique URL slug. Returns
   * { id, name, slug, created_at } (listMine() shape).
   */
  async create(name) {
    const { data, error } = await supabase.rpc('create_workspace', { p_name: name });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;   // single-composite RPC; tolerate either shape
    return row ? { id: row.id, name: row.name, slug: row.slug, created_at: row.created_at } : null;
  },
};

/* =================================================================================
   WORKSPACE MEMBERS — the caller's OWN membership rows (workspace_id + role).
   RLS (workspace_members_select_self) scopes to the current user's rows. The role here is
   PER-WORKSPACE and is the authority for owner-gated logic (a user can be owner of one
   workspace and member of another) — unlike the vestigial global members.role.
================================================================================= */
export const workspaceMembers = {
  /** The current user's memberships, as [{ workspaceId, role }]. */
  async listMine() {
    const { data, error } = await supabase
      .from('workspace_members')
      .select('workspace_id, role');
    if (error) throw error;
    return (data || []).map(r => ({ workspaceId: r.workspace_id, role: r.role }));
  },
  /**
   * All members of a workspace the caller belongs to, with profiles — for the assignee picker /
   * member-aware views. Uses the sanctioned SECURITY DEFINER RPC (the self-scoped workspace_members
   * SELECT policy only returns the caller's own row). Returns [{ userId, displayName, email, role }].
   */
  async listForWorkspace(workspaceId) {
    if (!workspaceId) return [];
    const { data, error } = await supabase.rpc('workspace_members_list', { p_workspace_id: workspaceId });
    if (error) throw error;
    return (data || []).map(r => ({ userId: r.user_id, displayName: r.display_name, email: r.email, role: r.role }));
  },

  /**
   * Change a member's role (owner|admin|member|guest) via the sanctioned set_member_role RPC — the
   * ONLY write path to workspace_members.role. ALL guardrails (owner/admin only; admins can't touch
   * owners/admins or grant admin; no self-escalation; no granting above your own rank; never
   * demote the last owner) are enforced server-side; a violation surfaces here as a thrown error.
   */
  async setRole(workspaceId, userId, role) {
    const { error } = await supabase.rpc('set_member_role', { p_ws: workspaceId, p_user: userId, p_role: role });
    if (error) throw error;
  },

  /** Remove a member via the remove_member RPC (owner/admin only; admins can't remove owners/admins;
   *  never the last owner). Server-enforced; violations throw. */
  async remove(workspaceId, userId) {
    const { error } = await supabase.rpc('remove_member', { p_ws: workspaceId, p_user: userId });
    if (error) throw error;
  },
};

/* =================================================================================
   INVITATIONS — email-bound invite + token link. ALL writes go through the sanctioned
   SECURITY DEFINER RPCs (the table is SELECT-only under RLS): create_invitation (owner),
   accept_invitation (email-bound; inserts the workspace_members row as auth.uid()),
   invitation_preview (authenticated; minimal), revoke_invitation (owner).
================================================================================= */
export const invitations = {
  /** Owner view: all invitations for a workspace (RLS invitations_select_owner). */
  async listForWorkspace(workspaceId) {
    if (!workspaceId) return [];
    const { data, error } = await supabase
      .from('invitations')
      .select('id, email, role, status, token, created_at, expires_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  /** Invitee view: the caller's own pending invites (RLS invitations_select_invitee, by auth.email()). */
  async listMine() {
    const { data, error } = await supabase
      .from('invitations')
      .select('id, workspace_id, email, token, created_at, expires_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  /** Owner+admin: create (or refresh) the single pending invite for an email, at the chosen role
   *  ('member' | 'guest'; the RPC rejects owner/admin — those are assigned via set_member_role after
   *  join). Returns the row incl. token. */
  async create(workspaceId, email, role = 'member') {
    const { data, error } = await supabase.rpc('create_invitation', { p_workspace_id: workspaceId, p_email: email, p_role: role });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  },
  /** Email-bound accept. Returns the joined workspace { id, name, slug, created_at }. */
  async accept(token) {
    const { data, error } = await supabase.rpc('accept_invitation', { p_token: token });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? { id: row.id, name: row.name, slug: row.slug, created_at: row.created_at } : null;
  },
  /** Authenticated minimal preview of a token: { workspace_name, email, status, is_expired } or null. */
  async preview(token) {
    const { data, error } = await supabase.rpc('invitation_preview', { p_token: token });
    if (error) throw error;
    return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
  },
  /** Owner-only: revoke a pending invite. */
  async revoke(id) {
    const { error } = await supabase.rpc('revoke_invitation', { p_id: id });
    if (error) throw error;
  },
};

/* =================================================================================
   PROJECTS — scoped to a workspace.
================================================================================= */
export const projects = {
  async list(workspaceId) {
    let q = supabase.from('projects').select('*').order('name');
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  /** Create a project in the given workspace. RLS projects_insert_member gates to membership. */
  async create({ name, color, icon }, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const row = { id: uid(), name, workspace_id: workspaceId, created_by: session.user.id };
    if (color) row.color = color;
    if (icon) row.icon = icon;
    const { data, error } = await supabase.from('projects').insert(row).select().single();
    if (error) throw error;
    return data;
  },

  /** Rename / recolor / re-icon a project. RLS projects_update_member gates to membership. */
  async update(id, patch) {
    const fields = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.color !== undefined) fields.color = patch.color;
    if (patch.icon !== undefined) fields.icon = patch.icon;
    const { data, error } = await supabase.from('projects').update(fields).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  /** Delete a project. RLS projects_delete_owner gates to the workspace owner. */
  async delete(id) {
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) throw error;
  },

  /**
   * Owner-only reliable count of a project's tasks via the project_task_count RPC (a SECURITY
   * DEFINER count that bypasses the caller's RLS blind spots, so a project with another member's
   * private tasks can't be deleted-and-stranded). Throws for non-owners.
   */
  async taskCount(projectId, workspaceId) {
    const { data, error } = await supabase.rpc('project_task_count', { p_project_id: projectId, p_workspace_id: workspaceId });
    if (error) throw error;
    return data ?? 0;
  },
};

/* =================================================================================
   TASKS
================================================================================= */
export const tasks = {
  async list(workspaceId) {
    let q = supabase.from('tasks').select('*').order('task_order', { ascending: false });
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromDbTask);
  },

  /** Fetch a single task by id (text PK), mapped to app shape. Null if not found. */
  async getById(id) {
    const { data, error } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return fromDbTask(data);
  },

  /** Read JUST the freshest subtasks array for a task (RLS-gated). Used to merge a single checklist
   *  change against current DB state so a concurrent edit to another item isn't clobbered. Throws if the
   *  task isn't visible (so we never persist a from-scratch array over a row we couldn't read). */
  async getSubtasks(id) {
    const { data, error } = await supabase.from('tasks').select('subtasks').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Task not found or not visible');
    return Array.isArray(data.subtasks) ? data.subtasks : [];
  },

  async create(partial, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const sanitized = sanitizeTask({ ...partial, createdBy: session.user.id });
    const row = toDbTask(sanitized);
    if (workspaceId) row.workspace_id = workspaceId;   // explicit workspace; else the DB trigger fills it
    const { data, error } = await supabase.from('tasks').insert(row).select().single();
    if (error) throw error;
    return fromDbTask(data);
  },

  async update(id, patch) {
    const dbPatch = toDbTask(patch);
    // Remove undefined fields and id from patch
    delete dbPatch.id;
    Object.keys(dbPatch).forEach(k => dbPatch[k] === undefined && delete dbPatch[k]);
    dbPatch.updated_at = new Date().toISOString();

    // Auto-set completed_at when status changes to/from done
    if (patch.status === 'done') {
      dbPatch.completed_at = dbPatch.completed_at || new Date().toISOString();
    } else if (patch.status && patch.status !== 'done') {
      dbPatch.completed_at = null;
    }

    const { data, error } = await supabase.from('tasks').update(dbPatch).eq('id', id).select().single();
    if (error) throw error;
    return fromDbTask(data);
  },

  async delete(id) {
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) throw error;
  },

  async bulkInsert(taskList, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const rows = taskList.map(t => {
      const row = toDbTask(sanitizeTask({ ...t, createdBy: session.user.id }));
      if (workspaceId) row.workspace_id = workspaceId;
      return row;
    });
    const { data, error } = await supabase.from('tasks').insert(rows).select();
    if (error) throw error;
    return (data || []).map(fromDbTask);
  },

  /**
   * Subscribe to real-time changes. Returns an unsubscribe function.
   * cb is called with { type: 'INSERT' | 'UPDATE' | 'DELETE', task }
   */
  // NOTE: no server-side workspace_id filter — tasks is REPLICA IDENTITY DEFAULT, so a
  // workspace_id filter would drop DELETE events (payload.old carries only the PK). The caller
  // filters INSERT/UPDATE by task.workspaceId; DELETE is by id (a no-op if the row isn't in the
  // current-workspace list). workspaceId only namespaces the channel so a switch re-subscribes.
  subscribe(cb, workspaceId) {
    const channel = supabase
      .channel(`tasks-changes${workspaceId ? `-${workspaceId}` : ''}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
        const type = payload.eventType;
        if (type === 'DELETE') {
          cb({ type, task: { id: payload.old.id } });
        } else {
          cb({ type, task: fromDbTask(payload.new) });
        }
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  },
};

/* =================================================================================
   NOTIFICATIONS
   In-app notification center. Rows are written ONLY by the notify_on_task_created
   DB trigger (clients have no INSERT privilege); clients may read / mark-read /
   delete their own rows (enforced by RLS: recipient_id = auth.uid()).
================================================================================= */
export const notifications = {
  /** List the current user's notifications, newest first. RLS scopes to the recipient. */
  async list(limit = 50, workspaceId) {
    let q = supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);   // recipient scope still enforced by RLS
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromDbNotification);
  },

  /** Mark a single notification read. */
  async markRead(id) {
    const { data, error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return fromDbNotification(data);
  },

  /** Mark all of the current user's unread notifications read. RLS scopes to the recipient. */
  async markAllRead(workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    let q = supabase
      .from('notifications')
      .update({ read: true })
      .eq('recipient_id', session.user.id)
      .eq('read', false);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { error } = await q;
    if (error) throw error;
  },

  /** Delete a single notification. Id-scoped; RLS gates to the recipient (recipient_id = auth.uid()). */
  async delete(id) {
    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  /**
   * Clear (delete) all of the current user's notifications in the given workspace.
   * REQUIRES a workspaceId — scoped to recipient = me AND workspace = current; never a bare/match-all delete.
   * RLS independently gates to the recipient (recipient_id = auth.uid()).
   */
  async clearAll(workspaceId) {
    if (!workspaceId) throw new Error('clearAll requires a workspaceId');
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('recipient_id', session.user.id)
      .eq('workspace_id', workspaceId);
    if (error) throw error;
  },

  /**
   * Subscribe to new notifications for a recipient. Returns an unsubscribe function.
   * cb is called with the app-shaped notification for each INSERT.
   */
  subscribe(recipientId, cb, workspaceId) {
    const channel = supabase
      .channel(`notifications-changes-${recipientId}${workspaceId ? `-${workspaceId}` : ''}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${recipientId}`,   // server-side recipient scope (security gate) kept
      }, (payload) => {
        const n = fromDbNotification(payload.new);
        if (workspaceId && n.workspaceId && n.workspaceId !== workspaceId) return;   // + current-workspace scope on top
        cb(n);
      })
      .subscribe((status, err) => {
        // Surface realtime health so live delivery can be verified (should reach SUBSCRIBED).
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`[notifications realtime] ${status}`, err ?? '');
        } else if (status === 'SUBSCRIBED') {
          console.info('[notifications realtime] SUBSCRIBED');
        }
      });
    return () => supabase.removeChannel(channel);
  },
};

/* =================================================================================
   COMMENTS
   In-task discussion. RLS makes a comment visible exactly when its task is visible;
   INSERT/UPDATE/DELETE are restricted to the author.
================================================================================= */
export const comments = {
  /** List a task's comments, oldest first. */
  async list(taskId) {
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(fromDbComment);
  },

  /** Add a comment to a task (author = current user; enforced by RLS). `mentions` is an array of
   *  @mentioned user ids; the DB trigger notifies only those who can actually see the task. */
  async add(taskId, body, workspaceId, mentions) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const row = { task_id: taskId, author_id: session.user.id, body };
    if (workspaceId) row.workspace_id = workspaceId;   // must equal the task's workspace (RLS WITH CHECK)
    if (Array.isArray(mentions) && mentions.length) row.mentions = mentions;
    const { data, error } = await supabase
      .from('comments')
      .insert(row)
      .select().single();
    if (error) throw error;
    return fromDbComment(data);
  },

  /** Edit one of the current user's own comments (RLS restricts to the author). */
  async update(id, body) {
    const { data, error } = await supabase
      .from('comments')
      .update({ body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single();
    if (error) throw error;
    return fromDbComment(data);
  },

  /** Delete one of the current user's own comments (RLS restricts to the author). */
  async remove(id) {
    const { error } = await supabase.from('comments').delete().eq('id', id);
    if (error) throw error;
  },

  /**
   * Subscribe to realtime INSERT/UPDATE/DELETE for one task's comments (DELETE relies on
   * the table's REPLICA IDENTITY FULL so the per-task filter matches). Returns unsubscribe.
   * cb is called with { type, comment }.
   */
  subscribe(taskId, cb) {
    const opts = (event) => ({ event, schema: 'public', table: 'comments', filter: `task_id=eq.${taskId}` });
    const channel = supabase
      .channel(`comments-${taskId}`)
      .on('postgres_changes', opts('INSERT'), (p) => cb({ type: 'INSERT', comment: fromDbComment(p.new) }))
      .on('postgres_changes', opts('UPDATE'), (p) => cb({ type: 'UPDATE', comment: fromDbComment(p.new) }))
      .on('postgres_changes', opts('DELETE'), (p) => cb({ type: 'DELETE', comment: fromDbComment(p.old) }))
      .subscribe();
    return () => supabase.removeChannel(channel);
  },
};

/* =================================================================================
   MESSAGES — one shared workspace chat channel (text + voice notes).
   RLS: any workspace member reads/sends; edit/delete own only. Voice notes live in
   the private 'voice-notes' bucket at <uid>/<uuid>.<ext>, played via signed URLs.
================================================================================= */
export const messages = {
  /** List the channel: the NEWEST `limit` messages, returned oldest-first. */
  async list(limit = 200, workspaceId) {
    // Order DESC + limit fetches the most-recent N (ASC + limit would return the OLDEST N and hide
    // everything newer once a channel exceeds the limit); reverse back to the oldest-first contract.
    let q = supabase
      .from('messages').select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromDbMessage).reverse();
  },

  /** Count messages newer than `since` (ISO) not sent by `exceptSenderId` — for the unread badge. */
  async unreadCount(since, exceptSenderId, workspaceId) {
    let q = supabase.from('messages').select('*', { count: 'exact', head: true });
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    if (since) q = q.gt('created_at', since);
    if (exceptSenderId) q = q.neq('sender_id', exceptSenderId);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  },

  async sendText(body, workspaceId, mentions) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const row = { sender_id: session.user.id, body };
    if (workspaceId) row.workspace_id = workspaceId;
    if (Array.isArray(mentions) && mentions.length) row.mentions = mentions;   // @mentioned user ids (gated by the DB trigger)
    const { data, error } = await supabase
      .from('messages')
      .insert(row)
      .select().single();
    if (error) throw error;
    return fromDbMessage(data);
  },

  /** Upload a recorded audio blob to the bucket, then insert the message row. */
  async sendVoice(blob, durationSeconds, contentType, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    // Normalize to a base audio type that exactly matches the bucket's allowlist.
    const ct = (contentType || blob.type || 'audio/webm').split(';')[0];
    const ext = ct === 'audio/mp4' ? 'm4a' : ct === 'audio/ogg' ? 'ogg' : ct === 'audio/mpeg' ? 'mp3' : ct === 'audio/wav' ? 'wav' : 'webm';
    const path = `${session.user.id}/${uid()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('voice-notes').upload(path, blob, { contentType: ct, upsert: false });
    if (upErr) throw upErr;
    const row = { sender_id: session.user.id, audio_path: path, audio_duration_seconds: Math.max(1, Math.round(durationSeconds || 0)) };
    if (workspaceId) row.workspace_id = workspaceId;
    const { data, error } = await supabase
      .from('messages')
      .insert(row)
      .select().single();
    if (error) {
      supabase.storage.from('voice-notes').remove([path]).catch(() => {}); // best-effort cleanup of the orphan object
      throw error;
    }
    return fromDbMessage(data);
  },

  /** Edit your own message (text). The DB trigger enforces the 10-minute window and stamps
   *  edited_at authoritatively; a stale/late edit is rejected server-side (P0001). */
  async update(id, body) {
    const { data, error } = await supabase
      .from('messages')
      .update({ body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single();
    if (error) throw error;
    return fromDbMessage(data);
  },

  /**
   * Soft-delete your own message (the UI's only delete path): set deleted_at; the BEFORE UPDATE
   * trigger stamps it server-side, strips body + audio (tombstone), and enforces the 10-minute
   * window. The row survives so the thread renders "This message was deleted" in place. The audio
   * object is no longer referenced, so clean it up best-effort. (Hard-delete `remove` is kept.)
   */
  async softDelete(message) {
    const { data, error } = await supabase
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', message.id)
      .select().single();
    if (error) throw error;
    if (message.audioPath) supabase.storage.from('voice-notes').remove([message.audioPath]).catch(() => {}); // best-effort
    return fromDbMessage(data);
  },

  /** Delete your own message (and its audio object, if any). */
  async remove(message) {
    const { error } = await supabase.from('messages').delete().eq('id', message.id);
    if (error) throw error;
    if (message.audioPath) supabase.storage.from('voice-notes').remove([message.audioPath]).catch(() => {}); // best-effort
  },

  /** Signed URL for playing a voice note. */
  async signedUrl(path, expiresIn = 3600) {
    const { data, error } = await supabase.storage.from('voice-notes').createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  },

  /** Subscribe to realtime INSERT/UPDATE/DELETE. cb -> { type, message }. Returns unsubscribe. */
  // messages is REPLICA IDENTITY FULL, so a server-side workspace_id filter is safe for
  // INSERT/UPDATE/DELETE alike. Channel name is namespaced per workspace so a switch re-subscribes.
  subscribe(cb, channelName = 'messages-changes', workspaceId) {
    const base = { schema: 'public', table: 'messages' };
    const opts = (event) => (workspaceId ? { event, ...base, filter: `workspace_id=eq.${workspaceId}` } : { event, ...base });
    const channel = supabase.channel(`${channelName}${workspaceId ? `-${workspaceId}` : ''}`)
      .on('postgres_changes', opts('INSERT'), (p) => cb({ type: 'INSERT', message: fromDbMessage(p.new) }))
      .on('postgres_changes', opts('UPDATE'), (p) => cb({ type: 'UPDATE', message: fromDbMessage(p.new) }))
      .on('postgres_changes', opts('DELETE'), (p) => cb({ type: 'DELETE', message: fromDbMessage(p.old) }))
      .subscribe();
    return () => supabase.removeChannel(channel);
  },

  /**
   * Realtime Presence channel for typing/recording indicators on the shared chat.
   * onOthers receives an array of { name, typing, recording } for OTHER people who are
   * currently typing or recording. Returns { update(partial), unsubscribe() }.
   */
  presence({ userId, name }, onOthers, channelKey) {
    // channelKey MUST be tenant-scoped (e.g. `chat-presence-<workspaceId>` / `dm-presence-<conversationId>`).
    // Refuse to open a global/unscoped presence channel — an unscoped name is shared across every tenant
    // (the old `chat-presence` cross-tenant leak). No default: a missing key returns an inert no-op handle.
    if (!channelKey) {
      console.warn('[presence] refusing to subscribe without a scoped channelKey');
      return { update() {}, unsubscribe() {} };
    }
    let mine = { userId, name: name || 'Someone', typing: false, recording: false, readAt: null };
    const channel = supabase.channel(channelKey, { config: { presence: { key: userId } } });
    const emit = () => {
      const state = channel.presenceState();
      const others = [];
      for (const key of Object.keys(state)) {
        if (key === userId) continue;
        const metas = Array.isArray(state[key]) ? state[key] : [];
        const meta = metas[metas.length - 1] || {};
        // Emit every present peer (not just typers) so a peer's read cursor (readAt) is available for
        // live read receipts; presenceLabel still filters to typing/recording for the typing strip.
        others.push({ userId: key, name: meta.name || 'Someone', typing: !!meta.typing, recording: !!meta.recording, readAt: meta.readAt || null });
      }
      try { onOthers(others); } catch (e) { console.error('[presence] callback error:', e); }
    };
    channel.on('presence', { event: 'sync' }, emit);
    channel.subscribe((status) => { if (status === 'SUBSCRIBED') channel.track(mine); });
    return {
      update: (partial) => {
        mine = { ...mine, ...partial };
        if (channel.state === 'joined') channel.track(mine);
      },
      unsubscribe: () => { try { channel.untrack(); } catch { /* ignore */ } supabase.removeChannel(channel); },
    };
  },
};

/* =================================================================================
   DIRECT MESSAGES — private 1:1 chat between two members of the same workspace.
   SEPARATE from the broadcast team chat (messages). RLS gates every read/write to the
   two participants (private.is_dm_participant) AND workspace membership; a conversation
   is created ONLY by the get_or_create_dm_conversation RPC (no client INSERT on
   dm_conversations). dm_messages.workspace_id is stamped server-side from the conversation.
   Voice notes reuse the 'voice-notes' bucket (storage SELECT is participant-gated for DMs).
================================================================================= */
export const directMessages = {
  /** Canonical get-or-create the 1:1 conversation with a peer in a workspace. Returns the conversation id. */
  async getOrCreateConversation(peerId, workspaceId) {
    const { data, error } = await supabase.rpc('get_or_create_dm_conversation', { p_workspace_id: workspaceId, p_peer: peerId });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;   // scalar uuid
  },

  /** My conversations in a workspace (RLS scopes to ones I'm a participant of), newest first. */
  async listConversations(workspaceId) {
    let q = supabase.from('dm_conversations').select('*').order('created_at', { ascending: false });
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromDbDmConversation);
  },

  /** Messages in one conversation: the NEWEST `limit`, returned oldest-first. */
  async listMessages(conversationId, limit = 200) {
    // Newest-N (DESC + limit) then reverse — ASC + limit would return the OLDEST N and hide recent ones.
    const { data, error } = await supabase
      .from('dm_messages').select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).map(fromDbDirectMessage).reverse();
  },

  /** Recent messages across all my conversations in a workspace (newest first) — for list previews + unread. */
  async listRecentMessages(workspaceId, limit = 500) {
    let q = supabase.from('dm_messages').select('*').order('created_at', { ascending: false }).limit(limit);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromDbDirectMessage);
  },

  /** My own per-conversation read cursors. */
  async myReads() {
    const session = await auth.getSession();
    if (!session) return [];
    const { data, error } = await supabase
      .from('dm_reads').select('conversation_id, last_read_at')
      .eq('user_id', session.user.id);
    if (error) throw error;
    return (data || []).map(r => ({ conversationId: r.conversation_id, lastReadAt: r.last_read_at }));
  },

  /** Both participants' read cursors for one conversation (RLS returns both rows) — for read receipts. */
  async reads(conversationId) {
    const { data, error } = await supabase
      .from('dm_reads').select('conversation_id, user_id, last_read_at')
      .eq('conversation_id', conversationId);
    if (error) throw error;
    return (data || []).map(r => ({ conversationId: r.conversation_id, userId: r.user_id, lastReadAt: r.last_read_at }));
  },

  /** Advance my read cursor for a conversation (upsert on the (conversation_id,user_id) PK). */
  async markRead(conversationId, coverAt) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    // Anchor the cursor to the latest message's SERVER timestamp when provided (coverAt), so it
    // covers a just-arrived message even if the client clock differs from the server. Writing the
    // client's own now() can land BEFORE a message the server stamped at ~the same instant, which
    // left an already-open conversation showing "unread" / "not seen". Fall back to now().
    const lastReadAt = coverAt || new Date().toISOString();
    const { error } = await supabase
      .from('dm_reads')
      .upsert({ conversation_id: conversationId, user_id: session.user.id, last_read_at: lastReadAt },
              { onConflict: 'conversation_id,user_id' });
    if (error) throw error;
  },

  async sendText(conversationId, body) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const { data, error } = await supabase
      .from('dm_messages')
      .insert({ conversation_id: conversationId, sender_id: session.user.id, body })   // workspace_id stamped by trigger
      .select().single();
    if (error) throw error;
    return fromDbDirectMessage(data);
  },

  /** Upload a recorded blob to the shared voice-notes bucket, then insert the DM message row. */
  async sendVoice(conversationId, blob, durationSeconds, contentType) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const ct = (contentType || blob.type || 'audio/webm').split(';')[0];
    const ext = ct === 'audio/mp4' ? 'm4a' : ct === 'audio/ogg' ? 'ogg' : ct === 'audio/mpeg' ? 'mp3' : ct === 'audio/wav' ? 'wav' : 'webm';
    const path = `${session.user.id}/${uid()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('voice-notes').upload(path, blob, { contentType: ct, upsert: false });
    if (upErr) throw upErr;
    const { data, error } = await supabase
      .from('dm_messages')
      .insert({ conversation_id: conversationId, sender_id: session.user.id, audio_path: path, audio_duration_seconds: Math.max(1, Math.round(durationSeconds || 0)) })
      .select().single();
    if (error) {
      supabase.storage.from('voice-notes').remove([path]).catch(() => {});   // best-effort orphan cleanup
      throw error;
    }
    return fromDbDirectMessage(data);
  },

  /** Edit your own DM (text). The DB trigger enforces the 10-minute window and stamps edited_at. */
  async update(id, body) {
    const { data, error } = await supabase
      .from('dm_messages')
      .update({ body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single();
    if (error) throw error;
    return fromDbDirectMessage(data);
  },

  /**
   * Soft-delete your own DM (the UI's only delete path): set deleted_at; the BEFORE UPDATE trigger
   * stamps it, strips body + audio (tombstone), and enforces the 10-minute window. The row survives
   * so the thread renders "This message was deleted" in place; the audio object is cleaned up
   * best-effort. (Hard-delete `remove` is kept.)
   */
  async softDelete(message) {
    const { data, error } = await supabase
      .from('dm_messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', message.id)
      .select().single();
    if (error) throw error;
    if (message.audioPath) supabase.storage.from('voice-notes').remove([message.audioPath]).catch(() => {}); // best-effort
    return fromDbDirectMessage(data);
  },

  /** Delete your own DM (and its audio object, if any). */
  async remove(message) {
    const { error } = await supabase.from('dm_messages').delete().eq('id', message.id);
    if (error) throw error;
    if (message.audioPath) supabase.storage.from('voice-notes').remove([message.audioPath]).catch(() => {});
  },

  /** Per-workspace subscription (drives the conversation list + unread badge). dm_messages is
   *  REPLICA IDENTITY FULL so the server-side workspace_id filter is safe for INSERT/UPDATE/DELETE. */
  subscribe(cb, workspaceId) {
    const base = { schema: 'public', table: 'dm_messages' };
    const opts = (event) => (workspaceId ? { event, ...base, filter: `workspace_id=eq.${workspaceId}` } : { event, ...base });
    const channel = supabase.channel(`dm-changes${workspaceId ? `-${workspaceId}` : ''}`)
      .on('postgres_changes', opts('INSERT'), (p) => cb({ type: 'INSERT', message: fromDbDirectMessage(p.new) }))
      .on('postgres_changes', opts('UPDATE'), (p) => cb({ type: 'UPDATE', message: fromDbDirectMessage(p.new) }))
      .on('postgres_changes', opts('DELETE'), (p) => cb({ type: 'DELETE', message: fromDbDirectMessage(p.old) }))
      .subscribe();
    return () => supabase.removeChannel(channel);
  },

  /** Per-conversation subscription (drives the open thread). RLS only ever delivers rows the
   *  caller participates in, so the conversation_id filter just narrows to the open thread. */
  subscribeThread(cb, conversationId) {
    const base = { schema: 'public', table: 'dm_messages' };
    const opts = (event) => ({ event, ...base, filter: `conversation_id=eq.${conversationId}` });
    const channel = supabase.channel(`dm-thread-${conversationId}`)
      .on('postgres_changes', opts('INSERT'), (p) => cb({ type: 'INSERT', message: fromDbDirectMessage(p.new) }))
      .on('postgres_changes', opts('UPDATE'), (p) => cb({ type: 'UPDATE', message: fromDbDirectMessage(p.new) }))
      .on('postgres_changes', opts('DELETE'), (p) => cb({ type: 'DELETE', message: fromDbDirectMessage(p.old) }))
      .subscribe();
    return () => supabase.removeChannel(channel);
  },
};

/* =================================================================================
   TASK ATTACHMENTS
   Files on a task (briefs, deliverables, images, docs). Private 'task-attachments'
   bucket; path <workspace_id>/<task_id>/<uid>.<ext>. RLS delegates to the task
   predicates (can_view_task for download, can_edit_task for upload; delete = uploader
   or admin+) — the SERVER is authoritative. The MIME/size/count constants below are for
   friendly client-side pre-validation only; never trust them for security.
   Upload = object then metadata row (best-effort orphan-remove on failure), mirroring
   the voice-note flow.
   ENTITLEMENT SEAM: attachments are ungated by plan today. If they ever move behind a
   paid tier, gate at this seam (and enforce server-side in RLS/quota) — do NOT entangle
   plan logic into the upload path itself.
================================================================================= */
const ATTACHMENT_MAX_BYTES = 26214400;   // 25 MB — mirrors the bucket file_size_limit
const ATTACHMENT_MAX_PER_TASK = 20;      // mirrors the task_attachments_insert policy
const ATTACHMENT_ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export const attachments = {
  ALLOWED_MIME: ATTACHMENT_ALLOWED_MIME,
  MAX_BYTES: ATTACHMENT_MAX_BYTES,
  MAX_PER_TASK: ATTACHMENT_MAX_PER_TASK,

  /** Attachments on a task (RLS-scoped to tasks the caller can view), oldest first. */
  async list(taskId) {
    const { data, error } = await supabase
      .from('task_attachments')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(fromDbAttachment);
  },

  /** Upload a File to <ws>/<task>/<uid>.<ext>, then insert its metadata row. */
  async upload(taskId, file, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    if (!workspaceId) throw new Error('Missing workspace');
    const dot = file.name.lastIndexOf('.');
    const ext = (dot > 0 ? file.name.slice(dot + 1) : '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const path = `${workspaceId}/${taskId}/${uid()}.${ext}`;
    const contentType = file.type || 'application/octet-stream';
    const { error: upErr } = await supabase.storage.from('task-attachments').upload(path, file, { contentType, upsert: false });
    if (upErr) throw upErr;
    // workspace_id is stamped server-side by the trigger from the parent task
    const row = { task_id: taskId, uploaded_by: session.user.id, storage_path: path, filename: file.name, mime_type: file.type || null, size_bytes: file.size ?? null };
    const { data, error } = await supabase.from('task_attachments').insert(row).select().single();
    if (error) {
      supabase.storage.from('task-attachments').remove([path]).catch(() => {});   // best-effort cleanup of the orphan object
      throw error;
    }
    return fromDbAttachment(data);
  },

  /** Short-lived signed URL to download / preview one object. */
  async signedUrl(path, expiresIn = 3600) {
    const { data, error } = await supabase.storage.from('task-attachments').createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
  },

  /** Delete an attachment. Object FIRST (the storage-delete policy needs the metadata row to
   *  authorize it), then the metadata row. RLS enforces uploader-own or admin+ on both. */
  async remove(attachment) {
    if (attachment.storagePath) {
      const { error: sErr } = await supabase.storage.from('task-attachments').remove([attachment.storagePath]);
      if (sErr) throw sErr;
    }
    const { error } = await supabase.from('task_attachments').delete().eq('id', attachment.id);
    if (error) throw error;
  },

  /** Best-effort: remove a task's attachment OBJECTS via the Storage API (frees the S3 blobs) while the
   *  metadata rows still exist to authorize it — call BEFORE deleting the task (the rows then cascade).
   *  Objects the caller can't delete (others' uploads, non-admin) are left for the DB orphan sweep. */
  async removeAllForTask(taskId) {
    const list = await this.list(taskId).catch(() => []);
    const paths = list.map(a => a.storagePath).filter(Boolean);
    if (paths.length) await supabase.storage.from('task-attachments').remove(paths);
  },
};
