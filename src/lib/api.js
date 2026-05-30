import { supabase } from './supabase';
import { fromDbTask, toDbTask, sanitizeTask, fromDbNotification } from './sanitize';

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
