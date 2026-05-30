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
   PROJECTS
================================================================================= */
export const projects = {
  async list() {
    const { data, error } = await supabase.from('projects').select('*').order('name');
    if (error) throw error;
    return data || [];
  },
};

/* =================================================================================
   TASKS
================================================================================= */
export const tasks = {
  async list() {
    const { data, error } = await supabase.from('tasks').select('*').order('task_order', { ascending: false });
    if (error) throw error;
    return (data || []).map(fromDbTask);
  },

  /** Fetch a single task by id (text PK), mapped to app shape. Null if not found. */
  async getById(id) {
    const { data, error } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return fromDbTask(data);
  },

  async create(partial) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const sanitized = sanitizeTask({ ...partial, createdBy: session.user.id });
    const { data, error } = await supabase.from('tasks').insert(toDbTask(sanitized)).select().single();
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

  async bulkInsert(taskList) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const rows = taskList.map(t => toDbTask(sanitizeTask({ ...t, createdBy: session.user.id })));
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
  subscribe(cb) {
    const channel = supabase
      .channel('tasks-changes')
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
  async list(limit = 50) {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
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
  async markAllRead() {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('recipient_id', session.user.id)
      .eq('read', false);
    if (error) throw error;
  },

  /**
   * Subscribe to new notifications for a recipient. Returns an unsubscribe function.
   * cb is called with the app-shaped notification for each INSERT.
   */
  subscribe(recipientId, cb) {
    const channel = supabase
      .channel(`notifications-changes-${recipientId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${recipientId}`,
      }, (payload) => {
        cb(fromDbNotification(payload.new));
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
  async add(taskId, body) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const { data, error } = await supabase
      .from('comments')
      .insert({ task_id: taskId, author_id: session.user.id, body })
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
  async list(limit = 200) {
    const { data, error } = await supabase
      .from('messages').select('*')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(fromDbMessage);
  },

  /** Count messages newer than `since` (ISO) not sent by `exceptSenderId` — for the unread badge. */
  async unreadCount(since, exceptSenderId) {
    let q = supabase.from('messages').select('*', { count: 'exact', head: true });
    if (since) q = q.gt('created_at', since);
    if (exceptSenderId) q = q.neq('sender_id', exceptSenderId);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  },

  async sendText(body) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const { data, error } = await supabase
      .from('messages')
      .insert({ sender_id: session.user.id, body })
      .select().single();
    if (error) throw error;
    return fromDbMessage(data);
  },

  /** Upload a recorded audio blob to the bucket, then insert the message row. */
  async sendVoice(blob, durationSeconds, contentType) {
    const session = await auth.getSession();
    if (!session) throw new Error('Not authenticated');
    // Normalize to a base audio type that exactly matches the bucket's allowlist.
    const ct = (contentType || blob.type || 'audio/webm').split(';')[0];
    const ext = ct === 'audio/mp4' ? 'm4a' : ct === 'audio/ogg' ? 'ogg' : ct === 'audio/mpeg' ? 'mp3' : ct === 'audio/wav' ? 'wav' : 'webm';
    const path = `${session.user.id}/${uid()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('voice-notes').upload(path, blob, { contentType: ct, upsert: false });
    if (upErr) throw upErr;
    const { data, error } = await supabase
      .from('messages')
      .insert({ sender_id: session.user.id, audio_path: path, audio_duration_seconds: Math.max(1, Math.round(durationSeconds || 0)) })
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
  subscribe(cb, channelName = 'messages-changes') {
    const channel = supabase.channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => cb({ type: 'INSERT', message: fromDbMessage(p.new) }))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => cb({ type: 'UPDATE', message: fromDbMessage(p.new) }))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => cb({ type: 'DELETE', message: fromDbMessage(p.old) }))
      .subscribe();
    return () => supabase.removeChannel(channel);
  },
};
