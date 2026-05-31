import { supabase } from './supabase';
import { fromDbTask, toDbTask, sanitizeTask, fromDbNotification, fromDbComment, fromDbMessage, uid } from './sanitize';

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
  /** Send a password-reset email; the link returns the user to the app to set a new password. */
  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
    });
    if (error) throw error;
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
      .from('workspaces').select('id,name,created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  /**
   * Create a workspace via the sanctioned SECURITY DEFINER RPC — the ONLY write path into
   * workspaces / workspace_members (both are otherwise SELECT-only under RLS). The DB makes the
   * caller the new workspace's owner; name validation (non-empty, <=80) and the auth check run
   * server-side, so those errors surface here. Returns { id, name, created_at } (listMine() shape).
   */
  async create(name) {
    const { data, error } = await supabase.rpc('create_workspace', { p_name: name });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;   // single-composite RPC; tolerate either shape
    return row ? { id: row.id, name: row.name, created_at: row.created_at } : null;
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

  async bulkDelete() {
    const { error } = await supabase.from('tasks').delete().neq('id', '__nope__');
    if (error) throw error;
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

  /** Add a comment to a task (author = current user; enforced by RLS). */
  async add(taskId, body, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const row = { task_id: taskId, author_id: session.user.id, body };
    if (workspaceId) row.workspace_id = workspaceId;   // must equal the task's workspace (RLS WITH CHECK)
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
  /** List the channel, oldest first. */
  async list(limit = 200, workspaceId) {
    let q = supabase
      .from('messages').select('*')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromDbMessage);
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

  async sendText(body, workspaceId) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const row = { sender_id: session.user.id, body };
    if (workspaceId) row.workspace_id = workspaceId;
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

  async update(id, body) {
    const { data, error } = await supabase
      .from('messages')
      .update({ body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single();
    if (error) throw error;
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
  presence({ userId, name }, onOthers) {
    let mine = { userId, name: name || 'Someone', typing: false, recording: false };
    const channel = supabase.channel('chat-presence', { config: { presence: { key: userId } } });
    const emit = () => {
      const state = channel.presenceState();
      const others = [];
      for (const key of Object.keys(state)) {
        if (key === userId) continue;
        const metas = Array.isArray(state[key]) ? state[key] : [];
        const meta = metas[metas.length - 1] || {};
        if (meta.typing || meta.recording) others.push({ name: meta.name || 'Someone', typing: !!meta.typing, recording: !!meta.recording });
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
