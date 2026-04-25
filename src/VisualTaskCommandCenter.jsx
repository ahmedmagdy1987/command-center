import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, createContext, useContext } from 'react';
import {
  LayoutDashboard, KanbanSquare, Grid3x3, FolderKanban, CalendarDays, Lock, UserCog,
  Plus, Search, Command, Settings, Sun, Moon, Download, Upload, RefreshCw, X, Check,
  Clock, AlertCircle, Flag, Tag, Link2, Trash2, Copy, Archive, ChevronRight, ChevronDown,
  Circle, CheckCircle2, Calendar, Zap, Timer, MoreHorizontal, Edit3, Filter, Eye, EyeOff,
  Flame, TrendingUp, Minimize2, Maximize2, Inbox, PauseCircle, PlayCircle, Sparkles,
  Brain, Target, Hourglass, GripVertical, Info, Keyboard, LogOut, Wifi, WifiOff, Loader2,
  KeyRound
} from 'lucide-react';
import { tasks as tasksApi, projects as projectsApi, members as membersApi, auth } from './lib/api';
import { supabase } from './lib/supabase';
import { sanitizeTask, uid, nowISO } from './lib/sanitize';

/* =================================================================================
   CONSTANTS
================================================================================= */
const OWNERS = {
  me: { id: 'me', label: 'Me', accent: 'violet', hex: '#a78bfa', soft: 'rgba(167,139,250,0.14)' },
  va: { id: 'va', label: 'VA', accent: 'emerald', hex: '#34d399', soft: 'rgba(52,211,153,0.14)' },
  shared: { id: 'shared', label: 'Shared', accent: 'fuchsia', hex: '#e879f9', soft: 'rgba(232,121,249,0.14)' },
};

const PRIORITIES = {
  critical: { id: 'critical', label: 'Critical', rank: 4, hex: '#f43f5e', glow: 'rgba(244,63,94,0.35)', bg: 'rgba(244,63,94,0.12)', ring: 'rgba(244,63,94,0.4)' },
  high:     { id: 'high',     label: 'High',     rank: 3, hex: '#fb923c', glow: 'rgba(251,146,60,0.30)', bg: 'rgba(251,146,60,0.12)', ring: 'rgba(251,146,60,0.4)' },
  medium:   { id: 'medium',   label: 'Medium',   rank: 2, hex: '#facc15', glow: 'rgba(250,204,21,0.25)', bg: 'rgba(250,204,21,0.10)', ring: 'rgba(250,204,21,0.35)' },
  low:      { id: 'low',      label: 'Low',      rank: 1, hex: '#38bdf8', glow: 'rgba(56,189,248,0.25)', bg: 'rgba(56,189,248,0.10)', ring: 'rgba(56,189,248,0.35)' },
};

const STATUSES = {
  inbox:     { id: 'inbox',     label: 'Inbox',     hint: 'Capture, triage later' },
  must:      { id: 'must',      label: 'Must Do',   hint: 'Non-negotiable today' },
  should:    { id: 'should',    label: 'Should Do', hint: 'Important, not urgent' },
  waiting:   { id: 'waiting',   label: 'Waiting',   hint: 'Blocked / needs input' },
  scheduled: { id: 'scheduled', label: 'Scheduled', hint: 'Time-blocked for later' },
  done:      { id: 'done',      label: 'Done',      hint: 'Completed' },
};

const DEFAULT_PROJECTS = [
  { id: 'social',   name: 'Social Media', color: '#a78bfa', icon: '☉' },
  { id: 'blogs',    name: 'Blogs',        color: '#f472b6', icon: '✎' },
  { id: 'seo',      name: 'SEO',          color: '#38bdf8', icon: '◎' },
  { id: 'outreach', name: 'Outreach',     color: '#34d399', icon: '↗' },
  { id: 'assets',   name: 'Assets',       color: '#fb923c', icon: '◈' },
  { id: 'personal', name: 'Personal',     color: '#f43f5e', icon: '♡' },
  { id: 'website',  name: 'Website',      color: '#facc15', icon: '◐' },
  { id: 'tools',    name: 'Tools',        color: '#94a3b8', icon: '⚙' },
  { id: 'other',    name: 'Other',        color: '#64748b', icon: '◇' },
];

const migrateProjects = (projects) => {
  if (!Array.isArray(projects) || projects.length === 0) return DEFAULT_PROJECTS;
  return projects;
};

const EFFORTS = {
  quick:  { id: 'quick',  label: 'Quick',  mins: 15, hex: '#34d399' },
  medium: { id: 'medium', label: 'Medium', mins: 45, hex: '#facc15' },
  deep:   { id: 'deep',   label: 'Deep',   mins: 120, hex: '#fb923c' },
};

const THEME_KEY = 'visual-command-center:theme';

const memStore = {};
const themeStore = {
  get(key) {
    try { if (typeof localStorage !== 'undefined') return localStorage.getItem(key); } catch {}
    return memStore[key] || null;
  },
  set(key, val) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch {}
    memStore[key] = val;
  },
};

/* =================================================================================
   UTILITIES
================================================================================= */
const daysBetween = (a, b) => Math.floor((new Date(b).setHours(0,0,0,0) - new Date(a).setHours(0,0,0,0)) / 86400000);

const formatDue = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  const today = new Date();
  const diff = daysBetween(today, d);
  if (diff < 0) return { label: `${Math.abs(diff)}d overdue`, tone: 'overdue' };
  if (diff === 0) return { label: 'Today', tone: 'today' };
  if (diff === 1) return { label: 'Tomorrow', tone: 'soon' };
  if (diff <= 6) return { label: d.toLocaleDateString(undefined, { weekday: 'short' }), tone: 'soon' };
  return { label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), tone: 'later' };
};

const isOverdue = (task) => task.dueDate && daysBetween(new Date(), task.dueDate) < 0 && task.status !== 'done';
const isDueToday = (task) => task.dueDate && daysBetween(new Date(), task.dueDate) === 0 && task.status !== 'done';
const isDueSoon = (task) => task.dueDate && daysBetween(new Date(), task.dueDate) <= 3 && !isOverdue(task) && task.status !== 'done';

const getNextBestScore = (task, projects) => {
  if (task.status === 'done') return -999;
  let score = 0;
  score += PRIORITIES[task.priority].rank * 20;
  if (task.dueDate) {
    const days = daysBetween(new Date(), task.dueDate);
    if (days < 0) score += 50 + Math.min(30, Math.abs(days) * 3);
    else if (days === 0) score += 40;
    else if (days <= 2) score += 25;
    else if (days <= 7) score += 10;
  }
  if (task.urgent) score += 15;
  if (task.important) score += 15;
  if (task.blocked) score -= 30;
  if (task.effort === 'quick') score += 5;
  if (task.status === 'must') score += 10;
  if (task.status === 'should') score += 5;
  return Math.round(score);
};

const scoreRationale = (task) => {
  const bits = [];
  bits.push(`${PRIORITIES[task.priority].label} priority`);
  if (isOverdue(task)) bits.push('overdue');
  else if (isDueToday(task)) bits.push('due today');
  else if (isDueSoon(task)) bits.push('due soon');
  if (task.urgent) bits.push('urgent');
  if (task.important) bits.push('important');
  if (task.blocked) bits.push('blocked');
  return bits.join(' · ');
};

/* =================================================================================
   APP CONTEXT / STATE
================================================================================= */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

function AppProvider({ children, session, currentMember, onSignOut }) {
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState(DEFAULT_PROJECTS);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState('connecting');

  const [theme, setTheme] = useState(() => {
    const t = themeStore.get(THEME_KEY) || 'dark';
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', t);
    return t;
  });

  const [view, setView] = useState('dashboard');
  const [filters, setFilters] = useState({ owner: 'all', privacy: 'all', project: 'all', search: '' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [compact, setCompact] = useState(false);
  const [draggedId, setDraggedId] = useState(null);

  useEffect(() => { themeStore.set(THEME_KEY, theme); }, [theme]);
  useLayoutEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [t, p] = await Promise.all([tasksApi.list(), projectsApi.list()]);
        if (!mounted) return;
        setTasks(t);
        setProjects(p.length ? p : DEFAULT_PROJECTS);
      } catch (err) {
        console.error('Failed to load:', err);
        setSyncStatus('offline');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setSyncStatus('connecting');
    const unsub = tasksApi.subscribe(({ type, task }) => {
      setSyncStatus('live');
      if (type === 'INSERT') {
        setTasks(prev => prev.some(t => t.id === task.id) ? prev : [task, ...prev]);
      } else if (type === 'UPDATE') {
        setTasks(prev => prev.map(t => t.id === task.id ? task : t));
      } else if (type === 'DELETE') {
        setTasks(prev => prev.filter(t => t.id !== task.id));
      }
    });
    const timer = setTimeout(() => setSyncStatus(s => s === 'connecting' ? 'live' : s), 1000);
    return () => { unsub(); clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const onOnline = () => setSyncStatus('live');
    const onOffline = () => setSyncStatus('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) setSyncStatus('offline');
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    const handler = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = ['INPUT','TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
      else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); setQuickAddOpen(true); }
      else if (!inField && e.key === '/') { e.preventDefault(); document.getElementById('global-search')?.focus(); }
      else if (!inField && e.key.toLowerCase() === 'n' && !mod) { e.preventDefault(); setQuickAddOpen(true); }
      else if (e.key === 'Escape') { setPaletteOpen(false); setQuickAddOpen(false); setEditingTask(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const addTask = useCallback(async (partial) => {
    const optimistic = sanitizeTask({
      id: uid(),
      title: 'New task',
      owner: 'me',
      privacy: 'workspace',
      project: 'other',
      status: 'inbox',
      priority: 'medium',
      effort: 'medium',
      estimatedMinutes: 30,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      order: Date.now(),
      createdBy: session?.user?.id,
      ...partial,
    });
    setTasks(prev => [optimistic, ...prev]);
    try {
      const real = await tasksApi.create(optimistic);
      setTasks(prev => prev.map(t => t.id === optimistic.id ? real : t));
      return real;
    } catch (err) {
      console.error('Add task failed:', err);
      setTasks(prev => prev.filter(t => t.id !== optimistic.id));
      alert('Failed to add task: ' + err.message);
    }
  }, [session]);

  const updateTask = useCallback(async (id, patch) => {
    setTasks(prev => prev.map(t => t.id === id ? {
      ...t, ...patch,
      updatedAt: nowISO(),
      completedAt: patch.status === 'done' ? (t.completedAt || nowISO()) : (patch.status && patch.status !== 'done' ? null : t.completedAt),
    } : t));
    try {
      await tasksApi.update(id, patch);
    } catch (err) {
      console.error('Update task failed:', err);
      tasksApi.list().then(setTasks).catch(() => {});
    }
  }, []);

  const deleteTask = useCallback(async (id) => {
    const prev = tasks;
    setTasks(p => p.filter(t => t.id !== id));
    try {
      await tasksApi.delete(id);
    } catch (err) {
      console.error('Delete failed:', err);
      setTasks(prev);
    }
  }, [tasks]);

  const duplicateTask = useCallback(async (id) => {
    const original = tasks.find(t => t.id === id);
    if (!original) return;
    const copy = { ...original, id: uid(), title: original.title + ' (copy)', createdAt: nowISO(), updatedAt: nowISO(), completedAt: null, status: 'inbox' };
    setTasks(prev => [copy, ...prev]);
    try {
      const real = await tasksApi.create(copy);
      setTasks(prev => prev.map(t => t.id === copy.id ? real : t));
    } catch (err) {
      console.error('Duplicate failed:', err);
      setTasks(prev => prev.filter(t => t.id !== copy.id));
    }
  }, [tasks]);

  const toggleSubtask = useCallback(async (taskId, subId) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const newSubs = task.subtasks.map(s => s.id === subId ? { ...s, done: !s.done } : s);
    await updateTask(taskId, { subtasks: newSubs });
  }, [tasks, updateTask]);

  const resetDemo = async () => {
    if (!confirm('This will delete ALL tasks. Are you sure?')) return;
    try {
      await tasksApi.bulkDelete();
      setTasks([]);
    } catch (err) {
      alert('Failed to clear: ' + err.message);
    }
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ tasks, projects, exportedAt: nowISO() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `command-center-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
  };

  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const d = JSON.parse(e.target.result);
        if (Array.isArray(d.tasks) && d.tasks.length) {
          if (!confirm(`Import ${d.tasks.length} tasks? They will be added to existing tasks.`)) return;
          const created = await tasksApi.bulkInsert(d.tasks);
          setTasks(prev => [...created, ...prev]);
        }
      } catch (err) {
        alert('Invalid JSON file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  const value = {
    tasks, projects, theme, view, filters, compact, draggedId,
    paletteOpen, quickAddOpen, editingTask,
    loading, syncStatus, session, currentMember, onSignOut,
    setTheme, setView, setFilters, setCompact, setDraggedId,
    setPaletteOpen, setQuickAddOpen, setEditingTask,
    addTask, updateTask, deleteTask, duplicateTask, toggleSubtask,
    resetDemo, exportJSON, importJSON,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/* =================================================================================
   SHARED UI PRIMITIVES
================================================================================= */
const cx = (...xs) => xs.filter(Boolean).join(' ');

function PriorityDot({ priority, size = 8, glow = true }) {
  const p = PRIORITIES[priority];
  return <span className="inline-block rounded-full shrink-0" style={{ width: size, height: size, background: p.hex, boxShadow: glow ? `0 0 10px ${p.glow}` : 'none' }} />;
}

function OwnerChip({ owner, showLabel = true, size = 'sm' }) {
  const o = OWNERS[owner];
  const dims = size === 'sm' ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-xs';
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full font-medium tracking-wide', dims)}
      style={{ background: o.soft, color: o.hex, border: `1px solid ${o.hex}33` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: o.hex }} />
      {showLabel && o.label}
    </span>
  );
}

function Badge({ children, tone = 'neutral', icon: Icon }) {
  const tones = {
    neutral: 'bg-white/5 text-white/60 border-white/10',
    overdue: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    today:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
    soon:    'bg-sky-500/15 text-sky-300 border-sky-500/30',
    later:   'bg-white/5 text-white/50 border-white/10',
    block:   'bg-rose-500/15 text-rose-300 border-rose-500/30',
    success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 h-5 text-[10px] font-medium', tones[tone])}>
    {Icon && <Icon className="w-3 h-3" />}{children}
  </span>;
}

function IconButton({ icon: Icon, label, active, onClick, tone = 'default' }) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className={cx(
        'inline-flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200',
        'border border-white/5 hover:border-white/10',
        active ? 'bg-white/10 text-white' : 'bg-white/[0.03] text-white/60 hover:bg-white/[0.07] hover:text-white/90',
      )}>
      <Icon className="w-4 h-4" />
    </button>
  );
}

function Tooltip({ children, content, className = 'inline-flex' }) {
  return (
    <span className={cx('relative group', className)}>
      {children}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 -top-9 whitespace-nowrap text-[10px] font-medium px-2 py-1 rounded-md bg-black/90 border border-white/10 text-white/90 opacity-0 group-hover:opacity-100 transition-opacity z-50">
        {content}
      </span>
    </span>
  );
}

/* =================================================================================
   CHANGE PASSWORD MODAL
================================================================================= */
function ChangePasswordModal({ open, onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (open) {
      setCurrent(''); setNext(''); setConfirm('');
      setError(null); setSuccess(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (next.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    if (next === current) {
      setError('New password must be different from current');
      return;
    }

    setLoading(true);
    try {
      // Verify current password by re-authenticating
      const session = await auth.getSession();
      if (!session?.user?.email) throw new Error('Not signed in');

      await auth.signIn(session.user.email, current);

      // Update to new password
      const { error: updateError } = await supabase.auth.updateUser({ password: next });
      if (updateError) throw updateError;

      setSuccess(true);
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      setError(err.message?.includes('Invalid') ? 'Current password is incorrect' : (err.message || 'Failed to change password'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_.15s_ease]" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white font-display">Change password</h3>
          <button onClick={onClose} className="text-white/50 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        {success ? (
          <div className="py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mx-auto mb-3">
              <Check className="w-6 h-6 text-emerald-400" strokeWidth={3} />
            </div>
            <div className="text-sm text-white/90 font-medium">Password changed successfully</div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Current password</label>
              <input type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoFocus
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 h-10 text-sm text-white outline-none focus:border-violet-400/50" />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">New password</label>
              <input type="password" value={next} onChange={e => setNext(e.target.value)} required minLength={6}
                placeholder="At least 6 characters"
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 h-10 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50" />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Confirm new password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 h-10 text-sm text-white outline-none focus:border-violet-400/50" />
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} disabled={loading}
                className="flex-1 h-10 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-sm text-white/80 font-medium transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={loading || !current || !next || !confirm}
                className="flex-1 h-10 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Change'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* =================================================================================
   TASK CARD
================================================================================= */
function TaskCard({ task, compact = false, onClick, draggable = true, showOwner = true }) {
  const { setDraggedId, updateTask, projects } = useApp();
  const priority = PRIORITIES[task.priority];
  const owner = OWNERS[task.owner];
  const project = projects.find(p => p.id === task.project);
  const due = formatDue(task.dueDate);
  const overdue = isOverdue(task);
  const doneCount = task.subtasks.filter(s => s.done).length;
  const totalSub = task.subtasks.length;
  const isPrivate = task.privacy === 'private';
  const done = task.status === 'done';

  const handleDragStart = (e) => {
    if (!draggable) return;
    setDraggedId(task.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  };

  return (
    <div
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={() => setDraggedId(null)}
      onClick={onClick}
      className={cx(
        'group relative rounded-xl border cursor-pointer transition-all duration-200',
        'border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-white/[0.015]',
        'hover:border-white/15 hover:from-white/[0.06] hover:to-white/[0.02]',
        'hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30',
        done && 'opacity-50',
        compact ? 'p-3' : 'p-4',
      )}
      style={{
        boxShadow: overdue ? `inset 0 0 0 1px ${priority.ring}, 0 0 20px -8px ${priority.glow}` : undefined,
      }}
    >
      <div className="absolute top-0 left-0 h-full w-[3px] rounded-l-xl" style={{ background: `linear-gradient(180deg, ${priority.hex}, ${priority.hex}00)` }} />

      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={(e) => { e.stopPropagation(); updateTask(task.id, { status: done ? 'inbox' : 'done' }); }}
            className="shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all"
            style={{ borderColor: done ? priority.hex : 'rgba(255,255,255,0.2)', background: done ? priority.hex : 'transparent' }}
          >
            {done && <Check className="w-2.5 h-2.5 text-black" strokeWidth={3} />}
          </button>
          <PriorityDot priority={task.priority} />
          {isPrivate && <Lock className="w-3 h-3 text-white/40 shrink-0" />}
          {isRecurring(task.recurring) && <RefreshCw className="w-3 h-3 text-white/30 shrink-0" />}
          {task.blocked && <PauseCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
        </div>
        {showOwner && <OwnerChip owner={task.owner} showLabel={!compact} size="sm" />}
      </div>

      <div className={cx('font-medium leading-snug text-white/95 mb-2', done && 'line-through text-white/50', compact ? 'text-sm' : 'text-[15px]')}>
        {task.title}
      </div>

      {!compact && task.description && (
        <p className="text-xs text-white/50 leading-relaxed mb-3 line-clamp-2">{task.description}</p>
      )}

      {totalSub > 0 && !compact && (
        <div className="mb-3">
          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${(doneCount/totalSub)*100}%`, background: `linear-gradient(90deg, ${priority.hex}, ${owner.hex})` }} />
          </div>
          <div className="text-[10px] text-white/40 mt-1 font-medium tracking-wide">{doneCount}/{totalSub} subtasks</div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {project && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-white/60">
            <span style={{ color: project.color }}>{project.icon}</span>
            <span>{project.name}</span>
          </span>
        )}
        {due && <Badge tone={due.tone} icon={Clock}>{due.label}</Badge>}
        {task.effort && !compact && (
          <Badge><Timer className="w-3 h-3" />{EFFORTS[task.effort].mins}m</Badge>
        )}
        {task.blocked && <Badge tone="block">Blocked</Badge>}
        {task.tags.slice(0, compact ? 0 : 2).map(t => (
          <span key={t} className="text-[10px] text-white/40">#{t}</span>
        ))}
      </div>
    </div>
  );
}

/* =================================================================================
   TASK MODAL
================================================================================= */
function TaskModal() {
  const { editingTask, setEditingTask, updateTask, deleteTask, duplicateTask, projects, toggleSubtask } = useApp();
  const t = editingTask;
  const [newSub, setNewSub] = useState('');
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  useEffect(() => { setNewSub(''); setRecurrenceOpen(false); }, [editingTask?.id]);

  if (!t) return null;
  const set = (patch) => { updateTask(t.id, patch); setEditingTask({ ...t, ...patch }); };
  const addSubtask = () => {
    if (!newSub.trim()) return;
    const sub = { id: uid(), title: newSub.trim(), done: false };
    set({ subtasks: [...t.subtasks, sub] });
    setNewSub('');
  };
  const removeSub = (id) => set({ subtasks: t.subtasks.filter(s => s.id !== id) });
  const toggleSub = (id) => { toggleSubtask(t.id, id); setEditingTask({ ...t, subtasks: t.subtasks.map(s => s.id === id ? {...s, done:!s.done} : s) }); };

  const priority = PRIORITIES[t.priority];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-6 animate-[fadeIn_.15s_ease]" onClick={() => setEditingTask(null)}>
      <div onClick={e => e.stopPropagation()} className="w-full sm:max-w-2xl max-h-screen sm:max-h-[85vh] overflow-hidden rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl flex flex-col">
        <div className="px-6 pt-5 pb-3 border-b border-white/5" style={{ background: `linear-gradient(180deg, ${priority.bg}, transparent)` }}>
          <div className="flex items-center gap-2 mb-3">
            <OwnerChip owner={t.owner} />
            {t.privacy === 'private' && <Badge icon={Lock}>Private</Badge>}
            {isRecurring(t.recurring) && <Badge icon={RefreshCw}>{formatRecurrence(t.recurring) || 'Repeats'}</Badge>}
            <div className="flex-1" />
            <IconButton icon={Copy} label="Duplicate" onClick={() => { duplicateTask(t.id); setEditingTask(null); }} />
            <IconButton icon={Trash2} label="Delete" onClick={() => { if (confirm('Delete this task?')) { deleteTask(t.id); setEditingTask(null); } }} />
            <IconButton icon={X} label="Close" onClick={() => setEditingTask(null)} />
          </div>
          <input
            value={t.title}
            onChange={e => set({ title: e.target.value })}
            className="w-full bg-transparent text-xl sm:text-2xl font-semibold text-white placeholder-white/30 outline-none font-display"
            placeholder="Task title"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="flex flex-wrap gap-2">
            <SelectPill label="Status" value={t.status} options={Object.values(STATUSES).map(s => [s.id, s.label])} onChange={v => set({ status: v })} />
            <SelectPill label="Priority" value={t.priority} options={Object.values(PRIORITIES).map(p => [p.id, p.label])} onChange={v => set({ priority: v })} color={priority.hex} />
            <SelectPill label="Owner" value={t.owner} options={Object.values(OWNERS).map(o => [o.id, o.label])} onChange={v => set({ owner: v })} color={OWNERS[t.owner].hex} />
            <SelectPill label="Privacy" value={t.privacy} options={[['workspace','Workspace'],['private','Private']]} onChange={v => set({ privacy: v })} />
            <SelectPill label="Project" value={t.project} options={projects.map(p => [p.id, p.name])} onChange={v => set({ project: v })} />
            <SelectPill label="Effort" value={t.effort} options={Object.values(EFFORTS).map(e => [e.id, `${e.label} (${e.mins}m)`])} onChange={v => set({ effort: v, estimatedMinutes: EFFORTS[v].mins })} />
          </div>

          <div className="flex flex-wrap gap-2">
            <ToggleChip active={t.urgent} onClick={() => set({ urgent: !t.urgent })} icon={Zap} label="Urgent" color="#fb923c" />
            <ToggleChip active={t.important} onClick={() => set({ important: !t.important })} icon={Flag} label="Important" color="#a78bfa" />
            <ToggleChip active={t.blocked} onClick={() => set({ blocked: !t.blocked })} icon={PauseCircle} label="Blocked" color="#f43f5e" />
            <button onClick={() => setRecurrenceOpen(true)} type="button"
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
                isRecurring(t.recurring) ? 'text-white' : 'text-white/50 border-white/10 bg-white/5 hover:bg-white/10')}
              style={isRecurring(t.recurring) ? { background: '#34d39922', borderColor: '#34d39955', color: '#34d399' } : {}}>
              <RefreshCw className="w-3.5 h-3.5" />
              {isRecurring(t.recurring) ? formatRecurrence(t.recurring) : 'Repeat'}
            </button>
          </div>

          {recurrenceOpen && (
            <RecurrencePicker
              value={t.recurring}
              onChange={r => set({ recurring: r })}
              onClose={() => setRecurrenceOpen(false)} />
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5">Due date</div>
              <input type="date" value={t.dueDate ? t.dueDate.slice(0,10) : ''} onChange={e => set({ dueDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-white/25" />
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5">Scheduled for</div>
              <input type="date" value={t.scheduledDate ? t.scheduledDate.slice(0,10) : ''} onChange={e => set({ scheduledDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-white/25" />
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5">Notes</div>
            <textarea value={t.description} onChange={e => set({ description: e.target.value })} rows={4}
              placeholder="Context, acceptance criteria, links…"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white/90 outline-none focus:border-white/25 resize-y" />
          </div>

          {t.blocked && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-widest text-rose-300/70 mb-1.5">Blocked because</div>
              <input value={t.blockedReason} onChange={e => set({ blockedReason: e.target.value })} placeholder="Waiting on…"
                className="w-full bg-rose-500/5 border border-rose-500/20 rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-rose-500/40" />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">Subtasks</div>
              {t.subtasks.length > 0 && <div className="text-[10px] text-white/40 font-medium">{t.subtasks.filter(s=>s.done).length}/{t.subtasks.length}</div>}
            </div>
            <div className="space-y-1.5">
              {t.subtasks.map(s => (
                <div key={s.id} className="flex items-center gap-2 group">
                  <button onClick={() => toggleSub(s.id)} className="shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-all"
                    style={{ borderColor: s.done ? priority.hex : 'rgba(255,255,255,0.2)', background: s.done ? priority.hex : 'transparent' }}>
                    {s.done && <Check className="w-2.5 h-2.5 text-black" strokeWidth={3} />}
                  </button>
                  <div className={cx('flex-1 text-sm', s.done ? 'text-white/40 line-through' : 'text-white/85')}>{s.title}</div>
                  <button onClick={() => removeSub(s.id)} className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-rose-400 transition-opacity">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <input value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSubtask()}
                  placeholder="Add subtask…"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/90 outline-none focus:border-white/25" />
                <button onClick={addSubtask} className="px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 text-sm">Add</button>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-white/5 text-[11px] text-white/30 flex flex-wrap gap-x-4 gap-y-1">
            <span>Created {new Date(t.createdAt).toLocaleDateString()}</span>
            <span>Updated {new Date(t.updatedAt).toLocaleDateString()}</span>
            {t.completedAt && <span>Completed {new Date(t.completedAt).toLocaleDateString()}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function SelectPill({ label, value, options, onChange, color }) {
  const current = options.find(([v]) => v === value);
  const currentLabel = current ? current[1] : value;
  return (
    <div className="relative inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 h-8 text-xs text-white/85 hover:bg-white/10 transition-colors cursor-pointer">
      {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      <span className="text-white/40">{label}:</span>
      <span className="text-white/95 font-medium">{currentLabel}</span>
      <ChevronDown className="w-3 h-3 text-white/40" />
      <select value={value} onChange={e => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
        {options.map(([v,l]) => <option key={v} value={v} className="bg-[#0f1017] text-white">{l}</option>)}
      </select>
    </div>
  );
}

function ToggleChip({ active, onClick, icon: Icon, label, color }) {
  return (
    <button onClick={onClick}
      className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
        active ? 'text-white' : 'text-white/50 border-white/10 bg-white/5 hover:bg-white/10')}
      style={active ? { background: `${color}22`, borderColor: `${color}55`, color } : {}}>
      <Icon className="w-3.5 h-3.5" />{label}
    </button>
  );
}

/* =================================================================================
   RECURRENCE
================================================================================= */
const DAY_LABELS = ['S','M','T','W','T','F','S'];
const DAY_NAMES_FULL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function isRecurring(r) {
  if (!r || r === 'none') return false;
  if (typeof r === 'string') return true;
  if (typeof r === 'object') return true;
  return false;
}

function normalizeRecurrence(r) {
  if (!r || r === 'none') return null;
  if (r === 'weekly') return { interval: 1, unit: 'week', daysOfWeek: [], ends: { type: 'never' } };
  if (typeof r === 'object') {
    return {
      interval: r.interval || 1,
      unit: r.unit || 'week',
      daysOfWeek: Array.isArray(r.daysOfWeek) ? r.daysOfWeek : [],
      ends: r.ends || { type: 'never' },
    };
  }
  return null;
}

function formatRecurrence(r) {
  const n = normalizeRecurrence(r);
  if (!n) return null;
  const unitMap = { day: 'day', week: 'week', month: 'month', year: 'year' };
  const unit = unitMap[n.unit] || n.unit;
  let s = n.interval === 1 ? `Every ${unit}` : `Every ${n.interval} ${unit}s`;
  if (n.unit === 'week' && n.daysOfWeek.length > 0 && n.daysOfWeek.length < 7) {
    const days = [...n.daysOfWeek].sort().map(d => DAY_NAMES_FULL[d]).join(', ');
    s += ` on ${days}`;
  }
  if (n.ends?.type === 'on' && n.ends.date) {
    s += `, until ${new Date(n.ends.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  } else if (n.ends?.type === 'after' && n.ends.count) {
    s += `, ${n.ends.count} times`;
  }
  return s;
}

function RecurrencePicker({ value, onChange, onClose }) {
  const initial = normalizeRecurrence(value) || { interval: 1, unit: 'week', daysOfWeek: [new Date().getDay()], ends: { type: 'never' } };
  const [r, setR] = useState(initial);

  const toggleDay = (i) => setR(p => ({
    ...p,
    daysOfWeek: p.daysOfWeek.includes(i)
      ? p.daysOfWeek.filter(d => d !== i)
      : [...p.daysOfWeek, i].sort(),
  }));

  const setEnds = (ends) => setR(p => ({ ...p, ends }));

  const todayIso = (() => { const d = new Date(); d.setHours(12,0,0,0); return d.toISOString(); })();

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_.15s_ease]" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-sm bg-[#0f1017] rounded-2xl border border-white/10 p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white font-display">Repeat</h3>
          <button onClick={onClose} className="text-white/50 hover:text-white transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div>
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5">Repeats every</div>
          <div className="flex gap-2">
            <input type="number" min="1" value={r.interval}
              onChange={e => setR(p => ({ ...p, interval: Math.max(1, parseInt(e.target.value) || 1) }))}
              className="w-20 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-violet-400/40" />
            <SelectPill label="Unit" value={r.unit}
              options={[['day','day'],['week','week'],['month','month'],['year','year']]}
              onChange={v => setR(p => ({ ...p, unit: v }))} />
          </div>
        </div>

        {r.unit === 'week' && (
          <div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-2">On these days</div>
            <div className="flex gap-1.5 justify-between">
              {DAY_LABELS.map((label, i) => {
                const active = r.daysOfWeek.includes(i);
                return (
                  <button key={i} onClick={() => toggleDay(i)} type="button"
                    className={cx('w-9 h-9 rounded-full text-xs font-semibold transition-all',
                      active
                        ? 'bg-violet-500 text-white shadow-md shadow-violet-500/40'
                        : 'bg-white/5 text-white/60 hover:bg-white/10 border border-white/10')}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-2">Ends</div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 cursor-pointer">
              <input type="radio" name="ends" checked={r.ends.type === 'never'}
                onChange={() => setEnds({ type: 'never' })}
                className="accent-violet-500" />
              <span className="text-sm text-white/85 flex-1">Never</span>
            </label>
            <label className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 cursor-pointer">
              <input type="radio" name="ends" checked={r.ends.type === 'on'}
                onChange={() => setEnds({ type: 'on', date: r.ends.date || todayIso })}
                className="accent-violet-500" />
              <span className="text-sm text-white/85">On</span>
              <input type="date" disabled={r.ends.type !== 'on'}
                value={r.ends.type === 'on' && r.ends.date ? r.ends.date.slice(0,10) : ''}
                onChange={e => setEnds({ type: 'on', date: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : todayIso })}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white/90 outline-none focus:border-violet-400/40 disabled:opacity-40 ml-auto" />
            </label>
            <label className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 cursor-pointer">
              <input type="radio" name="ends" checked={r.ends.type === 'after'}
                onChange={() => setEnds({ type: 'after', count: r.ends.count || 10 })}
                className="accent-violet-500" />
              <span className="text-sm text-white/85">After</span>
              <input type="number" min="1" disabled={r.ends.type !== 'after'}
                value={r.ends.type === 'after' ? (r.ends.count || 10) : 10}
                onChange={e => setEnds({ type: 'after', count: Math.max(1, parseInt(e.target.value) || 1) })}
                className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white outline-none focus:border-violet-400/40 disabled:opacity-40 ml-auto" />
              <span className="text-xs text-white/50">occurrences</span>
            </label>
          </div>
        </div>

        <div className="rounded-lg bg-violet-500/10 border border-violet-500/20 px-3 py-2 text-xs text-violet-200 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 shrink-0" />
          <span className="leading-snug">{formatRecurrence(r) || 'Set repeat schedule'}</span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {value && isRecurring(value) && (
            <button onClick={() => { onChange(null); onClose(); }} type="button"
              className="px-3 py-2 text-xs text-rose-300 hover:text-rose-200 transition-colors mr-auto">
              Remove repeat
            </button>
          )}
          <button onClick={onClose} type="button"
            className="px-4 py-2 text-xs text-white/70 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={() => { onChange(r); onClose(); }} type="button"
            className="px-4 py-2 text-xs font-semibold rounded-full bg-violet-500 text-white hover:bg-violet-400 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* =================================================================================
   QUICK ADD
================================================================================= */
function QuickAdd() {
  const { quickAddOpen, setQuickAddOpen, addTask, projects, view } = useApp();
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('me');
  const [priority, setPriority] = useState('medium');
  const [project, setProject] = useState('other');
  const [privacy, setPrivacy] = useState('workspace');
  const inputRef = useRef(null);

  useEffect(() => {
    if (quickAddOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      if (view === 'private') { setPrivacy('private'); setProject('personal'); }
      else if (view === 'va') { setOwner('va'); setPrivacy('workspace'); }
      else { setPrivacy('workspace'); }
    } else {
      setTitle('');
    }
  }, [quickAddOpen, view]);

  if (!quickAddOpen) return null;

  const submit = () => {
    if (!title.trim()) return;
    addTask({ title: title.trim(), owner, priority, project, privacy, status: 'inbox' });
    setQuickAddOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 px-4 animate-[fadeIn_.15s_ease]" onClick={() => setQuickAddOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="What needs to get done?"
            className="flex-1 bg-transparent text-lg text-white outline-none placeholder-white/30 font-display" />
          <kbd className="text-[10px] text-white/30 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Enter</kbd>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {Object.values(OWNERS).map(o => (
              <button key={o.id} onClick={() => setOwner(o.id)}
                className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
                  owner === o.id ? 'text-white' : 'text-white/50 border-white/10 bg-white/5')}
                style={owner === o.id ? { background: o.soft, borderColor: o.hex + '55', color: o.hex } : {}}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: o.hex }} />{o.label}
              </button>
            ))}
            <div className="w-px h-6 bg-white/10 self-center mx-1" />
            {Object.values(PRIORITIES).map(p => (
              <button key={p.id} onClick={() => setPriority(p.id)}
                className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
                  priority === p.id ? 'text-white' : 'text-white/50 border-white/10 bg-white/5')}
                style={priority === p.id ? { background: p.bg, borderColor: p.ring, color: p.hex } : {}}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.hex, boxShadow: `0 0 8px ${p.glow}` }} />{p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={project} onChange={e => setProject(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-full px-3 h-8 text-xs text-white/80 outline-none cursor-pointer">
              {projects.map(p => <option key={p.id} value={p.id} className="bg-[#0f1017]">{p.icon} {p.name}</option>)}
            </select>
            <button onClick={() => setPrivacy(p => p === 'private' ? 'workspace' : 'private')}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium',
                privacy === 'private' ? 'border-white/20 bg-white/10 text-white' : 'border-white/10 bg-white/5 text-white/50')}>
              {privacy === 'private' ? <Lock className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {privacy === 'private' ? 'Private' : 'Workspace'}
            </button>
            <div className="flex-1" />
            <button onClick={submit} disabled={!title.trim()}
              className="inline-flex items-center gap-1.5 rounded-full px-4 h-8 text-xs font-semibold bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity">
              <Plus className="w-3.5 h-3.5" />Add task
            </button>
          </div>
          <div className="text-[11px] text-white/30">Tip: press <kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded">⌘N</kbd> or <kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded">N</kbd> anywhere to capture.</div>
        </div>
      </div>
    </div>
  );
}

/* =================================================================================
   COMMAND PALETTE
================================================================================= */
function CommandPalette() {
  const { paletteOpen, setPaletteOpen, tasks, setEditingTask, setView, setQuickAddOpen, setTheme, theme, resetDemo, exportJSON } = useApp();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => { if (paletteOpen) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 50); } }, [paletteOpen]);

  const commands = useMemo(() => [
    { id: 'new-task', label: 'New task', icon: Plus, run: () => { setPaletteOpen(false); setQuickAddOpen(true); } },
    { id: 'v-dash', label: 'Go to Dashboard', icon: LayoutDashboard, run: () => { setView('dashboard'); setPaletteOpen(false); } },
    { id: 'v-kan', label: 'Go to Kanban', icon: KanbanSquare, run: () => { setView('kanban'); setPaletteOpen(false); } },
    { id: 'v-mat', label: 'Go to Priority Matrix', icon: Grid3x3, run: () => { setView('matrix'); setPaletteOpen(false); } },
    { id: 'v-proj', label: 'Go to Projects', icon: FolderKanban, run: () => { setView('projects'); setPaletteOpen(false); } },
    { id: 'v-sched', label: 'Go to Schedule', icon: CalendarDays, run: () => { setView('schedule'); setPaletteOpen(false); } },
    { id: 'v-priv', label: 'Go to Private', icon: Lock, run: () => { setView('private'); setPaletteOpen(false); } },
    { id: 'v-va', label: 'Go to VA Desk', icon: UserCog, run: () => { setView('va'); setPaletteOpen(false); } },
    { id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`, icon: theme === 'dark' ? Sun : Moon, run: () => { setTheme(theme === 'dark' ? 'light' : 'dark'); setPaletteOpen(false); } },
    { id: 'export', label: 'Export JSON backup', icon: Download, run: () => { exportJSON(); setPaletteOpen(false); } },
    { id: 'reset', label: 'Clear all tasks', icon: RefreshCw, run: () => { setPaletteOpen(false); resetDemo(); } },
  ], [theme]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return { cmds: commands.slice(0, 8), tasks: [] };
    const cmds = commands.filter(c => c.label.toLowerCase().includes(term));
    const tList = tasks.filter(t => {
      const title = (t.title || '').toLowerCase();
      const desc  = (t.description || '').toLowerCase();
      return title.includes(term) || desc.includes(term);
    }).slice(0, 6);
    return { cmds, tasks: tList };
  }, [q, tasks, commands]);

  const flat = [...results.cmds.map(c => ({ type: 'cmd', item: c })), ...results.tasks.map(t => ({ type: 'task', item: t }))];

  useEffect(() => { setIdx(0); }, [q]);

  const handleKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = flat[idx];
      if (!sel) return;
      if (sel.type === 'cmd') sel.item.run();
      else { setEditingTask(sel.item); setPaletteOpen(false); }
    }
  };

  if (!paletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 px-4 animate-[fadeIn_.15s_ease]" onClick={() => setPaletteOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center gap-3">
          <Command className="w-4 h-4 text-white/40" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={handleKey}
            placeholder="Search tasks or run a command…"
            className="flex-1 bg-transparent text-base text-white outline-none placeholder-white/30" />
          <kbd className="text-[10px] text-white/30 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto py-2">
          {results.cmds.length > 0 && (
            <div className="px-2">
              <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-white/30">Commands</div>
              {results.cmds.map((c, i) => {
                const active = i === idx;
                return (
                  <button key={c.id} onClick={c.run} onMouseEnter={() => setIdx(i)}
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                      active ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5')}>
                    <c.icon className="w-4 h-4" />{c.label}
                  </button>
                );
              })}
            </div>
          )}
          {results.tasks.length > 0 && (
            <div className="px-2 pt-2">
              <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-white/30">Tasks</div>
              {results.tasks.map((t, i) => {
                const ii = results.cmds.length + i;
                const active = ii === idx;
                return (
                  <button key={t.id} onClick={() => { setEditingTask(t); setPaletteOpen(false); }} onMouseEnter={() => setIdx(ii)}
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                      active ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5')}>
                    <PriorityDot priority={t.priority} />
                    <span className="flex-1 truncate">{t.title}</span>
                    <OwnerChip owner={t.owner} showLabel={false} />
                  </button>
                );
              })}
            </div>
          )}
          {flat.length === 0 && <div className="px-4 py-8 text-center text-white/40 text-sm">No matches</div>}
        </div>
      </div>
    </div>
  );
}

/* =================================================================================
   SIDEBAR
================================================================================= */
function Sidebar() {
  const { view, setView, tasks } = useApp();

  const counts = useMemo(() => {
    const open = tasks.filter(t => t.status !== 'done');
    return {
      all: open.length,
      me: open.filter(t => t.owner === 'me').length,
      va: open.filter(t => t.owner === 'va').length,
      private: open.filter(t => t.privacy === 'private').length,
      overdue: open.filter(isOverdue).length,
    };
  }, [tasks]);

  const item = (id, icon, label, badge) => (
    <button onClick={() => setView(id)}
      className={cx('w-full flex items-center gap-3 px-3 h-10 rounded-xl text-sm transition-all',
        view === id ? 'bg-white/[0.08] text-white border border-white/10' : 'text-white/55 hover:text-white hover:bg-white/[0.04] border border-transparent')}>
      {React.createElement(icon, { className: 'w-4 h-4' })}
      <span className="flex-1 text-left font-medium">{label}</span>
      {badge != null && badge > 0 && (
        <span className="text-[10px] font-semibold text-white/50 bg-white/5 border border-white/10 rounded-md px-1.5 h-5 flex items-center">{badge}</span>
      )}
    </button>
  );

  return (
    <aside className="hidden lg:flex flex-col w-64 shrink-0 border-r border-white/5 bg-[#0a0b11]">
      <div className="px-5 pt-6 pb-5 border-b border-white/5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-white font-display tracking-tight">Command</div>
            <div className="text-[10px] text-white/40 uppercase tracking-widest">Visual task center</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-widest text-white/30">Workspace</div>
        {item('dashboard', LayoutDashboard, 'Dashboard')}
        {item('kanban', KanbanSquare, 'Kanban', counts.all)}
        {item('matrix', Grid3x3, 'Priority Matrix')}
        {item('projects', FolderKanban, 'Projects')}
        {item('schedule', CalendarDays, 'Schedule')}

        <div className="px-3 pt-5 pb-2 text-[10px] font-medium uppercase tracking-widest text-white/30">Lanes</div>
        {item('va', UserCog, 'VA Desk', counts.va)}
        {item('private', Lock, 'Private', counts.private)}
      </div>

      <div className="p-3 border-t border-white/5">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <div className="text-[10px] uppercase tracking-widest text-white/30 mb-1.5">Overview</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-white font-display">{counts.all}</div>
            <div className="text-[11px] text-white/40">open tasks</div>
          </div>
          {counts.overdue > 0 && (
            <div className="mt-2 text-[11px] text-rose-300 flex items-center gap-1">
              <Flame className="w-3 h-3" />{counts.overdue} overdue
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/* =================================================================================
   MOBILE TAB BAR
================================================================================= */
function MobileTabs() {
  const { view, setView } = useApp();
  const items = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Home' },
    { id: 'kanban',    icon: KanbanSquare,    label: 'Board' },
    { id: 'matrix',    icon: Grid3x3,         label: 'Matrix' },
    { id: 'projects',  icon: FolderKanban,    label: 'Projects' },
    { id: 'schedule',  icon: CalendarDays,    label: 'Plan' },
    { id: 'va',        icon: UserCog,         label: 'VA' },
    { id: 'private',   icon: Lock,            label: 'Private' },
  ];
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-white/5 bg-[#0a0b11]/95 backdrop-blur">
      <div className="flex overflow-x-auto no-scrollbar">
        {items.map(it => (
          <button key={it.id} onClick={() => setView(it.id)}
            className={cx('flex-1 min-w-[64px] py-2.5 flex flex-col items-center justify-center gap-0.5 transition-colors',
              view === it.id ? 'text-white' : 'text-white/40')}>
            <it.icon className="w-5 h-5" />
            <span className="text-[9px] font-medium tracking-wide">{it.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/* =================================================================================
   TOP BAR
================================================================================= */
function TopBar() {
  const { theme, setTheme, setPaletteOpen, setQuickAddOpen, filters, setFilters, view, compact, setCompact, exportJSON, importJSON, resetDemo, projects, syncStatus, currentMember, onSignOut } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const fileRef = useRef(null);

  const showFilters = ['kanban', 'projects', 'schedule', 'matrix'].includes(view);

  const syncDot = {
    live: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]',
    connecting: 'bg-amber-400 animate-pulse',
    offline: 'bg-rose-400',
  }[syncStatus];
  const syncLabel = { live: 'Synced', connecting: 'Connecting…', offline: 'Offline' }[syncStatus];

  return (
    <>
    <header className="sticky top-0 z-20 border-b border-white/5 bg-[#0a0b11]/80 backdrop-blur-xl">
      <div className="flex items-center gap-2 px-4 lg:px-6 h-14">
        <div className="lg:hidden flex items-center gap-2 mr-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
        </div>

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
          <input id="global-search" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            placeholder="Search tasks… ( / )"
            className="search-input w-full bg-black/30 border border-white/10 rounded-xl pl-9 pr-8 h-9 text-sm text-white placeholder-white/45 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
          {filters.search && (
            <button onClick={() => setFilters(f => ({ ...f, search: '' }))} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {showFilters && (
          <div className="hidden sm:flex items-center gap-1 pl-2 overflow-x-auto no-scrollbar">
            <FilterPill label="Owner" value={filters.owner} options={[['all','All'],['me','Me'],['va','VA'],['shared','Shared']]} onChange={v => setFilters(f => ({ ...f, owner: v }))} />
            <FilterPill label="View" value={filters.privacy} options={[['all','All'],['workspace','Business'],['private','Private']]} onChange={v => setFilters(f => ({ ...f, privacy: v }))} />
            <FilterPill label="Project" value={filters.project} options={[['all','All'], ...projects.map(p => [p.id, p.name])]} onChange={v => setFilters(f => ({ ...f, project: v }))} />
          </div>
        )}

        <div className="flex-1" />

        <div className="hidden md:flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-white/5 bg-white/[0.02]" title={syncLabel}>
          <span className={cx('w-1.5 h-1.5 rounded-full transition-colors', syncDot)} />
          <span className="text-[10px] font-medium text-white/50">{syncLabel}</span>
        </div>

        <div className="flex items-center gap-1.5">
          {view === 'kanban' && (
            <IconButton icon={compact ? Maximize2 : Minimize2} label="Toggle compact" active={compact} onClick={() => setCompact(c => !c)} />
          )}
          <IconButton icon={Command} label="Command palette (⌘K)" onClick={() => setPaletteOpen(true)} />
          <button onClick={() => setQuickAddOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-white text-black text-xs font-semibold hover:bg-white/90 transition-colors">
            <Plus className="w-3.5 h-3.5" />New<kbd className="hidden sm:inline text-[9px] text-black/50 bg-black/10 rounded px-1 py-0.5">N</kbd>
          </button>
          <div className="relative">
            <IconButton icon={Settings} label="Settings" onClick={() => setMenuOpen(o => !o)} />
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl py-1.5">
                  {currentMember && (
                    <div className="px-3 py-2.5 border-b border-white/5">
                      <div className="text-xs font-medium text-white/90 truncate">{currentMember.email}</div>
                      <div className="text-[10px] text-white/40 mt-0.5 capitalize">{currentMember.role}</div>
                    </div>
                  )}
                  <MenuItem icon={theme === 'dark' ? Sun : Moon} onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); setMenuOpen(false); }}>Switch to {theme === 'dark' ? 'light' : 'dark'}</MenuItem>
                  <MenuItem icon={Download} onClick={() => { exportJSON(); setMenuOpen(false); }}>Export JSON</MenuItem>
                  <MenuItem icon={Upload} onClick={() => { fileRef.current?.click(); setMenuOpen(false); }}>Import JSON</MenuItem>
                  <div className="h-px bg-white/5 my-1" />
                  <MenuItem icon={KeyRound} onClick={() => { setPasswordModalOpen(true); setMenuOpen(false); }}>Change password</MenuItem>
                  <div className="h-px bg-white/5 my-1" />
                  <MenuItem icon={LogOut} onClick={() => { onSignOut?.(); setMenuOpen(false); }}>Sign out</MenuItem>
                </div>
                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                  onChange={e => { if (e.target.files?.[0]) importJSON(e.target.files[0]); e.target.value = ''; }} />
              </>
            )}
          </div>
        </div>
      </div>
    </header>
    <ChangePasswordModal open={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} />
    </>
  );
}
function MenuItem({ icon: Icon, children, onClick }) {
  return <button onClick={onClick} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors">
    <Icon className="w-3.5 h-3.5" />{children}
  </button>;
}
function FilterPill({ label, value, options, onChange }) {
  const current = options.find(([v]) => v === value);
  const currentLabel = current ? current[1] : value;
  return (
    <div className="relative inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-2.5 h-9 text-xs cursor-pointer transition-colors shrink-0">
      <Filter className="w-3 h-3 text-white/40 shrink-0" />
      <span className="text-white/40 shrink-0">{label}:</span>
      <span className="text-white/90 font-medium">{currentLabel}</span>
      <ChevronDown className="w-3 h-3 text-white/40 shrink-0" />
      <select value={value} onChange={e => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
        {options.map(([v,l]) => <option key={v} value={v} className="bg-[#0f1017] text-white">{l}</option>)}
      </select>
    </div>
  );
}

/* =================================================================================
   SECTION WRAPPER
================================================================================= */
function ViewHeader({ title, subtitle, accent }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl lg:text-3xl font-semibold text-white font-display tracking-tight" style={{ letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle && <p className="text-sm text-white/45 mt-1">{subtitle}</p>}
      </div>
      {accent && <div className="hidden sm:block text-[10px] uppercase tracking-widest text-white/30">{accent}</div>}
    </div>
  );
}

function Card({ children, className, title, subtitle, action, accent }) {
  return (
    <section className={cx('relative rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.025] to-white/[0.005] overflow-hidden', className)}>
      {accent && <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />}
      {(title || action) && (
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div>
            {title && <h3 className="text-[13px] font-semibold text-white font-display tracking-tight">{title}</h3>}
            {subtitle && <p className="text-[11px] text-white/40 mt-0.5">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

/* =================================================================================
   DASHBOARD
================================================================================= */
function DashboardView() {
  const { tasks, projects, setEditingTask, setView } = useApp();

  const open = tasks.filter(t => t.status !== 'done');
  const ranked = [...open].map(t => ({ t, s: getNextBestScore(t, projects) })).sort((a,b) => b.s - a.s);
  const top3 = ranked.slice(0, 3);
  const myUpcoming = open.filter(t => t.owner === 'me' && t.dueDate).sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate)).slice(0, 5);
  const vaUpcoming = open.filter(t => t.owner === 'va' && t.dueDate).sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate)).slice(0, 5);
  const sharedPriority = open.filter(t => t.owner === 'shared').sort((a,b) => PRIORITIES[b.priority].rank - PRIORITIES[a.priority].rank).slice(0, 4);
  const overdue = open.filter(isOverdue).sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));
  const stuck = open.filter(t => t.blocked || t.status === 'waiting').slice(0, 5);
  const recent = [...tasks].sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5);

  const counts = {
    me: open.filter(t => t.owner === 'me').length,
    va: open.filter(t => t.owner === 'va').length,
    shared: open.filter(t => t.owner === 'shared').length,
    critical: open.filter(t => t.priority === 'critical').length,
    high: open.filter(t => t.priority === 'high').length,
    medium: open.filter(t => t.priority === 'medium').length,
    low: open.filter(t => t.priority === 'low').length,
    doneToday: tasks.filter(t => t.status === 'done' && t.completedAt && daysBetween(new Date(), t.completedAt) === 0).length,
    doneWeek: tasks.filter(t => t.status === 'done' && t.completedAt && daysBetween(new Date(), t.completedAt) >= -6).length,
  };

  const progress = tasks.length ? Math.round((tasks.filter(t => t.status === 'done').length / tasks.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <ViewHeader title="Mission control" subtitle="Today's ranked priorities, flagged blockers, and where your energy should go." accent={new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric'})} />

      <Card title="Top 3 priorities — right now" subtitle="Auto-ranked by priority, due date, urgency, and blockers." accent="#a78bfa">
        {top3.length === 0 ? (
          <EmptyState icon={Sparkles} text="Nothing on fire. Beautiful." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {top3.map((r, i) => (
              <div key={r.t.id} className="relative">
                <div className="absolute -top-2 -left-2 z-10 w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-xs font-bold flex items-center justify-center shadow-lg shadow-fuchsia-500/30 font-display">
                  {i + 1}
                </div>
                <Tooltip content={`Why: ${scoreRationale(r.t)}`} className="block w-full">
                  <TaskCard task={r.t} onClick={() => setEditingTask(r.t)} />
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Me" value={counts.me} color={OWNERS.me.hex} icon={<span className="w-2 h-2 rounded-full" style={{background:OWNERS.me.hex}} />} onClick={() => setView('kanban')} />
        <StatCard label="VA" value={counts.va} color={OWNERS.va.hex} icon={<span className="w-2 h-2 rounded-full" style={{background:OWNERS.va.hex}} />} onClick={() => setView('va')} />
        <StatCard label="Shared" value={counts.shared} color={OWNERS.shared.hex} icon={<span className="w-2 h-2 rounded-full" style={{background:OWNERS.shared.hex}} />} />
        <StatCard label="Completed this week" value={counts.doneWeek} color="#34d399" icon={<CheckCircle2 className="w-3 h-3 text-emerald-400" />} />
      </div>

      <Card title="Priority distribution" subtitle="Open tasks by urgency level">
        <div className="space-y-2">
          {['critical','high','medium','low'].map(p => {
            const c = counts[p];
            const max = Math.max(counts.critical, counts.high, counts.medium, counts.low, 1);
            const pr = PRIORITIES[p];
            return (
              <div key={p} className="flex items-center gap-3">
                <div className="w-20 flex items-center gap-2 text-xs">
                  <PriorityDot priority={p} size={6} />
                  <span className="text-white/70 font-medium">{pr.label}</span>
                </div>
                <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${(c/max)*100}%`, background: pr.hex, boxShadow: `0 0 12px ${pr.glow}` }} />
                </div>
                <div className="w-8 text-right text-xs font-semibold text-white/80 tabular-nums">{c}</div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="My upcoming" subtitle="Due dates coming for you" accent={OWNERS.me.hex} action={<button onClick={() => setView('kanban')} className="text-[11px] text-white/40 hover:text-white/80 inline-flex items-center gap-0.5">See all <ChevronRight className="w-3 h-3" /></button>}>
          {myUpcoming.length === 0 ? <EmptyState icon={Calendar} text="No upcoming — nothing on your plate." /> :
            <div className="space-y-2">{myUpcoming.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
        <Card title="VA's upcoming" subtitle="What your VA is working on" accent={OWNERS.va.hex} action={<button onClick={() => setView('va')} className="text-[11px] text-white/40 hover:text-white/80 inline-flex items-center gap-0.5">See all <ChevronRight className="w-3 h-3" /></button>}>
          {vaUpcoming.length === 0 ? <EmptyState icon={UserCog} text="VA desk is clear." /> :
            <div className="space-y-2">{vaUpcoming.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Shared priorities" subtitle="Both of you touch these" accent={OWNERS.shared.hex}>
          {sharedPriority.length === 0 ? <EmptyState icon={Sparkles} text="No shared items — add collaborative work here." /> :
            <div className="space-y-2">{sharedPriority.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
        <Card title="Overdue" subtitle={overdue.length ? "Needs attention" : "All clear"} accent="#f43f5e">
          {overdue.length === 0 ? <EmptyState icon={CheckCircle2} text="Nothing overdue. Keep it up." /> :
            <div className="space-y-2">{overdue.slice(0, 5).map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Stuck tasks" subtitle="Blocked or waiting — needs unblocking" accent="#fb923c">
          {stuck.length === 0 ? <EmptyState icon={PlayCircle} text="Nothing stuck. Flow state." /> :
            <div className="space-y-2">{stuck.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} showBlocked />)}</div>}
        </Card>
        <Card title="Recently updated" subtitle="What changed lately">
          <div className="space-y-2">{recent.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} showTime />)}</div>
        </Card>
      </div>

      <Card title="Overall progress" subtitle={`${tasks.filter(t => t.status==='done').length} of ${tasks.length} tasks complete`}>
        <div className="flex items-center gap-4">
          <div className="relative w-20 h-20 shrink-0">
            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
              <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="url(#g1)" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={`${(progress / 100) * 94.2478} 94.2478`} />
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#e879f9" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-white font-display">{progress}%</div>
          </div>
          <div className="flex-1 grid grid-cols-3 gap-3 text-center">
            <Metric label="Open" value={open.length} />
            <Metric label="Done today" value={counts.doneToday} />
            <Metric label="Done this week" value={counts.doneWeek} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value, color, icon, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={cx('relative text-left rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.03] to-white/[0.005] p-4 overflow-hidden group transition-all w-full',
      onClick && 'hover:border-white/15 hover:-translate-y-0.5 cursor-pointer')}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-20 blur-2xl" style={{ background: color }} />
      <div className="relative">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-white/40 mb-2">{icon}{label}</div>
        <div className="text-3xl font-semibold text-white font-display tabular-nums" style={{ color }}>{value}</div>
      </div>
    </Tag>
  );
}
function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] py-2">
      <div className="text-xl font-semibold text-white font-display tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
    </div>
  );
}
function MiniRow({ task, onClick, showBlocked, showTime }) {
  const due = formatDue(task.dueDate);
  const { projects } = useApp();
  const proj = projects.find(p => p.id === task.project);
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 p-2 -mx-2 rounded-lg hover:bg-white/[0.04] text-left transition-colors group">
      <PriorityDot priority={task.priority} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-white/90 font-medium truncate">{task.title}</div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-white/40">
          <span style={{ color: proj?.color }}>{proj?.icon} {proj?.name}</span>
          {due && <><span>·</span><span className={cx(due.tone==='overdue' && 'text-rose-400', due.tone==='today' && 'text-amber-300')}>{due.label}</span></>}
          {showTime && <><span>·</span><span>{new Date(task.updatedAt).toLocaleDateString(undefined, { month:'short', day:'numeric'})}</span></>}
          {showBlocked && task.blocked && <><span>·</span><span className="text-rose-400">blocked</span></>}
        </div>
      </div>
      <OwnerChip owner={task.owner} showLabel={false} />
    </button>
  );
}
function EmptyState({ icon: Icon, text }) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center mb-2">
        <Icon className="w-4 h-4 text-white/40" />
      </div>
      <div className="text-xs text-white/40">{text}</div>
    </div>
  );
}

/* =================================================================================
   KANBAN
================================================================================= */
function KanbanView() {
  const { tasks, filters, draggedId, updateTask, setEditingTask, compact } = useApp();

  const filtered = useMemo(() => {
    const term = (filters.search || '').toLowerCase();
    return tasks.filter(t => {
      if (filters.owner !== 'all' && t.owner !== filters.owner) return false;
      if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
      if (filters.project !== 'all' && t.project !== filters.project) return false;
      if (term) {
        const hay = ((t.title || '') + ' ' + (t.description || '')).toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [tasks, filters]);

  const byStatus = useMemo(() => {
    const g = {};
    Object.keys(STATUSES).forEach(s => { g[s] = []; });
    filtered.forEach(t => { (g[t.status] = g[t.status] || []).push(t); });
    Object.keys(g).forEach(k => g[k].sort((a,b) => PRIORITIES[b.priority].rank - PRIORITIES[a.priority].rank));
    return g;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <ViewHeader title="Kanban board" subtitle="Drag between columns. Priority color on the left, owner chip on the right." />
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-4 lg:-mx-6 px-4 lg:px-6 snap-x">
        {Object.values(STATUSES).map(col => (
          <KanbanColumn key={col.id} column={col} tasks={byStatus[col.id] || []} />
        ))}
      </div>
    </div>
  );
}

function ColumnQuickAdd({ status }) {
  const { addTask, filters } = useApp();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30); }, [open]);

  const submit = () => {
    if (!title.trim()) return;
    addTask({
      title: title.trim(),
      status,
      owner: filters.owner !== 'all' ? filters.owner : 'me',
      project: filters.project !== 'all' ? filters.project : 'other',
      privacy: filters.privacy !== 'all' ? filters.privacy : 'workspace',
    });
    setTitle('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} type="button"
        className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-white/40 hover:text-white/90 hover:bg-white/[0.04] border border-dashed border-white/10 hover:border-white/20 rounded-lg transition-colors">
        <Plus className="w-3 h-3" /> Add task
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-violet-400/30 bg-white/[0.05] p-1.5">
      <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          else if (e.key === 'Escape') { setOpen(false); setTitle(''); }
        }}
        onBlur={() => { if (!title.trim()) setOpen(false); }}
        placeholder="New task — Enter to add"
        className="w-full bg-transparent text-sm text-white outline-none placeholder-white/30 px-2 py-1" />
    </div>
  );
}

function KanbanColumn({ column, tasks }) {
  const { draggedId, updateTask, setEditingTask, compact } = useApp();
  const [over, setOver] = useState(false);

  const onDrop = (e) => {
    e.preventDefault(); setOver(false);
    const id = e.dataTransfer.getData('text/plain') || draggedId;
    if (id) updateTask(id, { status: column.id });
  };

  const columnAccent = {
    inbox: '#64748b', must: '#f43f5e', should: '#fb923c', waiting: '#facc15', scheduled: '#38bdf8', done: '#34d399',
  }[column.id];

  return (
    <div
      onDragOver={e => { e.preventDefault(); if (!over) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx('shrink-0 w-[290px] snap-start rounded-2xl border transition-all duration-200',
        over ? 'border-white/25 bg-white/[0.04]' : 'border-white/[0.06] bg-white/[0.015]')}>
      <div className="px-4 pt-4 pb-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: columnAccent, boxShadow: `0 0 8px ${columnAccent}99` }} />
          <h4 className="text-sm font-semibold text-white font-display tracking-tight">{column.label}</h4>
          <span className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded-md px-1.5 h-4 flex items-center">{tasks.length}</span>
        </div>
      </div>
      <div className="p-2 space-y-2 min-h-[120px] max-h-[calc(100vh-240px)] overflow-y-auto">
        {column.id !== 'done' && <ColumnQuickAdd status={column.id} />}
        {tasks.length === 0 ? (
          <div className="text-center py-6 text-[11px] text-white/30">{column.hint}</div>
        ) : (
          tasks.map(t => <TaskCard key={t.id} task={t} compact={compact} onClick={() => setEditingTask(t)} />)
        )}
      </div>
    </div>
  );
}

/* =================================================================================
   PRIVATE VIEW
================================================================================= */
function PrivateView() {
  const { tasks, setEditingTask, setQuickAddOpen, updateTask } = useApp();
  const privateTasks = tasks.filter(t => t.privacy === 'private');

  const open = privateTasks.filter(t => t.status !== 'done');
  const done = privateTasks.filter(t => t.status === 'done');
  const sections = {
    overdue: open.filter(isOverdue),
    today: open.filter(isDueToday),
    soon: open.filter(t => isDueSoon(t) && !isDueToday(t)),
    later: open.filter(t => !t.dueDate || (!isOverdue(t) && !isDueToday(t) && !isDueSoon(t))),
  };

  return (
    <div className="space-y-6">
      <div className="relative rounded-3xl border border-white/5 bg-gradient-to-br from-[#1a1530] via-[#14101e] to-[#0a0b11] p-6 overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-20 w-64 h-64 rounded-full bg-fuchsia-500/5 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 backdrop-blur px-2.5 h-6 text-[10px] font-medium uppercase tracking-widest text-white/70 mb-3">
              <Lock className="w-3 h-3" />Private space · only you
            </div>
            <h1 className="text-3xl lg:text-4xl font-semibold text-white font-display tracking-tight" style={{letterSpacing:'-0.02em'}}>My private list</h1>
            <p className="text-sm text-white/50 mt-2 max-w-md">Personal tasks that never appear in any workspace view. Your VA cannot see this.</p>
          </div>
          <button onClick={() => setQuickAddOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-white text-black text-xs font-semibold hover:bg-white/90">
            <Plus className="w-3.5 h-3.5" />Add private task
          </button>
        </div>
      </div>

      {privateTasks.length === 0 ? (
        <Card><EmptyState icon={Lock} text="No private tasks yet. Hit ‘Add private task’ to start." /></Card>
      ) : (
        <>
          {sections.overdue.length > 0 && <PrivateSection title="Overdue" accent="#f43f5e" tasks={sections.overdue} />}
          {sections.today.length > 0 && <PrivateSection title="Today" accent="#facc15" tasks={sections.today} />}
          {sections.soon.length > 0 && <PrivateSection title="This week" accent="#38bdf8" tasks={sections.soon} />}
          {sections.later.length > 0 && <PrivateSection title="Someday" accent="#8b92a8" tasks={sections.later} />}
          {done.length > 0 && (
            <Card title="Completed" subtitle={`${done.length} done`}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {done.slice(0, 10).map(t => <TaskCard key={t.id} task={t} compact onClick={() => setEditingTask(t)} />)}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
function PrivateSection({ title, accent, tasks }) {
  const { setEditingTask } = useApp();
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}99` }} />
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-white/50">{title}</h3>
        <span className="text-[10px] text-white/30">{tasks.length}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tasks.map(t => <TaskCard key={t.id} task={t} onClick={() => setEditingTask(t)} />)}
      </div>
    </section>
  );
}

/* =================================================================================
   VA DESK
================================================================================= */
function VAView() {
  const { tasks, setEditingTask, updateTask, setQuickAddOpen } = useApp();
  const vaTasks = tasks.filter(t => t.owner === 'va');
  const byStatus = {
    active:   vaTasks.filter(t => ['must','should','inbox'].includes(t.status)),
    waiting:  vaTasks.filter(t => t.status === 'waiting' || t.blocked),
    scheduled: vaTasks.filter(t => t.status === 'scheduled'),
    done:     vaTasks.filter(t => t.status === 'done'),
  };
  const overdue = vaTasks.filter(isOverdue);

  return (
    <div className="space-y-6">
      <div className="relative rounded-3xl border border-white/5 bg-gradient-to-br from-[#0d2a20] via-[#0c1a18] to-[#0a0b11] p-6 overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 h-6 text-[10px] font-medium uppercase tracking-widest text-emerald-300 mb-3">
              <UserCog className="w-3 h-3" />Manager view
            </div>
            <h1 className="text-3xl lg:text-4xl font-semibold text-white font-display tracking-tight">VA desk</h1>
            <p className="text-sm text-white/50 mt-2">Assign, prioritize, and unblock your VA's work.</p>
          </div>
          <button onClick={() => setQuickAddOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-emerald-500 text-black text-xs font-semibold hover:bg-emerald-400">
            <Plus className="w-3.5 h-3.5" />Assign task
          </button>
        </div>
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          <VaStat label="Active" value={byStatus.active.length} />
          <VaStat label="Waiting" value={byStatus.waiting.length} tone="warning" />
          <VaStat label="Overdue" value={overdue.length} tone="danger" />
          <VaStat label="Done this week" value={byStatus.done.filter(t => t.completedAt && daysBetween(new Date(), t.completedAt) >= -6).length} tone="success" />
        </div>
      </div>

      {overdue.length > 0 && (
        <Card title="Overdue — unblock or reschedule" accent="#f43f5e">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {overdue.map(t => <TaskCard key={t.id} task={t} onClick={() => setEditingTask(t)} />)}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Active" subtitle={`${byStatus.active.length} in motion`} accent={OWNERS.va.hex}>
          {byStatus.active.length === 0 ? <EmptyState icon={Inbox} text="No active VA work. Time to assign." /> :
            <div className="space-y-2">{byStatus.active.map(t => <TaskCard key={t.id} task={t} compact onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
        <Card title="Waiting / Blocked" subtitle="Needs your input to move" accent="#facc15">
          {byStatus.waiting.length === 0 ? <EmptyState icon={PlayCircle} text="Nothing waiting. Great flow." /> :
            <div className="space-y-2">{byStatus.waiting.map(t => (
              <div key={t.id} className="relative">
                <TaskCard task={t} compact onClick={() => setEditingTask(t)} />
                {t.blockedReason && <div className="mt-1 ml-2 text-[11px] text-rose-300/80 italic">↳ {t.blockedReason}</div>}
              </div>
            ))}</div>}
        </Card>
      </div>
    </div>
  );
}
function VaStat({ label, value, tone = 'default' }) {
  const tones = { default: '#34d399', warning: '#facc15', danger: '#f43f5e', success: '#34d399' };
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 backdrop-blur p-3">
      <div className="text-[10px] uppercase tracking-widest text-white/50 mb-1">{label}</div>
      <div className="text-2xl font-semibold font-display tabular-nums" style={{ color: tones[tone] }}>{value}</div>
    </div>
  );
}

/* =================================================================================
   PRIORITY MATRIX
================================================================================= */
const MATRIX_FLAGS = {
  q1: { urgent: true,  important: true  },
  q2: { urgent: false, important: true  },
  q3: { urgent: true,  important: false },
  q4: { urgent: false, important: false },
};

function MatrixQuad({ id, title, subtitle, tasks, accent }) {
  const { updateTask, setEditingTask, draggedId } = useApp();
  const [over, setOver] = useState(false);
  const onDrop = (e) => {
    e.preventDefault(); setOver(false);
    const tid = e.dataTransfer.getData('text/plain') || draggedId;
    if (tid) updateTask(tid, MATRIX_FLAGS[id]);
  };
  return (
    <div
      onDragOver={e => { e.preventDefault(); if (!over) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx('relative rounded-2xl border p-4 min-h-[280px] transition-all overflow-hidden',
        over ? 'border-white/30 bg-white/[0.05]' : 'border-white/[0.06] bg-white/[0.015]')}>
      <div className="pointer-events-none absolute inset-x-6 -top-10 h-20 rounded-full opacity-40 blur-2xl" style={{ background: accent }} />
      <div className="relative flex items-start justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-white font-display" style={{ color: accent }}>{title}</h4>
          <p className="text-[11px] text-white/40 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded-md px-1.5 h-5 flex items-center">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="relative flex items-center justify-center h-40 text-[11px] text-white/30 italic">Drop tasks here</div>
      ) : (
        <div className="relative space-y-2">
          {tasks.slice(0, 6).map(t => <TaskCard key={t.id} task={t} compact onClick={() => setEditingTask(t)} />)}
          {tasks.length > 6 && <div className="text-[11px] text-white/40 pl-1">+ {tasks.length - 6} more</div>}
        </div>
      )}
    </div>
  );
}

function MatrixView() {
  const { tasks, filters } = useApp();

  const open = useMemo(() => tasks.filter(t => {
    if (t.status === 'done') return false;
    if (filters.owner !== 'all' && t.owner !== filters.owner) return false;
    if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
    return true;
  }), [tasks, filters]);

  const quadrants = useMemo(() => ({
    q1: open.filter(t => t.urgent && t.important),
    q2: open.filter(t => !t.urgent && t.important),
    q3: open.filter(t => t.urgent && !t.important),
    q4: open.filter(t => !t.urgent && !t.important),
  }), [open]);

  return (
    <div className="space-y-6">
      <ViewHeader title="Priority matrix" subtitle="Drag tasks into quadrants to reframe what actually matters." />

      <div className="hidden md:flex items-center justify-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-white/70 md:ml-10">
        <Flame className="w-3.5 h-3.5 text-rose-400" />
        <span>More urgent →</span>
      </div>

      <div className="flex gap-3 md:gap-4">
        <div className="hidden md:flex items-center justify-center w-7 shrink-0" aria-hidden>
          <div
            className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-white/70 whitespace-nowrap"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            <TrendingUp className="w-3.5 h-3.5 text-violet-400" />
            <span>More important →</span>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 min-w-0">
          <MatrixQuad id="q1" title="Do first"  subtitle="Urgent + Important"          tasks={quadrants.q1} accent="#f43f5e" />
          <MatrixQuad id="q2" title="Schedule"  subtitle="Important, not urgent"       tasks={quadrants.q2} accent="#a78bfa" />
          <MatrixQuad id="q3" title="Delegate"  subtitle="Urgent, not important"       tasks={quadrants.q3} accent="#fb923c" />
          <MatrixQuad id="q4" title="Eliminate" subtitle="Neither — consider dropping" tasks={quadrants.q4} accent="#64748b" />
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-white/40 justify-center text-center px-4">
        <Info className="w-3 h-3 shrink-0" />
        <span>Urgency and importance update automatically from priority + due date. Drag a task to override.</span>
      </div>
    </div>
  );
}

/* =================================================================================
   PROJECTS VIEW
================================================================================= */
function ProjectsView() {
  const { tasks, projects, setEditingTask, filters } = useApp();

  const filtered = tasks.filter(t => {
    if (filters.owner !== 'all' && t.owner !== filters.owner) return false;
    if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <ViewHeader title="Projects & areas" subtitle="Work grouped by where it lives." />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.map(p => {
          const pTasks = filtered.filter(t => t.project === p.id);
          const open = pTasks.filter(t => t.status !== 'done');
          const done = pTasks.filter(t => t.status === 'done');
          const pct = pTasks.length ? Math.round((done.length / pTasks.length) * 100) : 0;
          return (
            <section key={p.id} className="relative rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.03] to-transparent p-5 overflow-hidden">
              <div className="absolute top-0 right-0 w-40 h-40 rounded-full blur-3xl opacity-20" style={{ background: p.color }} />
              <div className="relative">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold" style={{ background: p.color + '22', color: p.color, border: `1px solid ${p.color}44` }}>
                      {p.icon}
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-white font-display">{p.name}</h3>
                      <div className="text-[11px] text-white/40">{open.length} open · {done.length} done</div>
                    </div>
                  </div>
                </div>
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden mb-4">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: p.color, boxShadow: `0 0 12px ${p.color}99` }} />
                </div>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {open.slice(0, 5).map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}
                  {open.length === 0 && <div className="text-[11px] text-white/30 italic py-4 text-center">No open tasks in {p.name}.</div>}
                  {open.length > 5 && <div className="text-[11px] text-white/40 pl-1">+ {open.length - 5} more</div>}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* =================================================================================
   SCHEDULE
================================================================================= */
function ScheduleView() {
  const { tasks, setEditingTask, filters } = useApp();

  const filtered = tasks.filter(t => {
    if (t.status === 'done') return false;
    if (filters.owner !== 'all' && t.owner !== filters.owner) return false;
    if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
    return true;
  });

  const days = useMemo(() => {
    const out = [];
    const today = new Date(); today.setHours(0,0,0,0);
    for (let i = -1; i < 10; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const dStr = d.toDateString();
      const dayTasks = filtered.filter(t => {
        const target = t.scheduledDate || t.dueDate;
        return target && new Date(target).toDateString() === dStr;
      }).sort((a,b) => PRIORITIES[b.priority].rank - PRIORITIES[a.priority].rank);
      out.push({ date: d, tasks: dayTasks, isToday: i === 0, isPast: i < 0 });
    }
    return out;
  }, [filtered]);

  const undated = filtered.filter(t => !t.dueDate && !t.scheduledDate).slice(0, 12);

  return (
    <div className="space-y-6">
      <ViewHeader title="Schedule" subtitle="Next 10 days of due dates and time-blocked work." />

      <div className="space-y-2">
        {days.map((d) => {
          const weekday = d.date.toLocaleDateString(undefined, { weekday: 'short' });
          const dayNum = d.date.getDate();
          const month = d.date.toLocaleDateString(undefined, { month: 'short' });
          return (
            <div key={d.date.toISOString()}
              className={cx('grid grid-cols-[80px,1fr] gap-4 rounded-2xl border p-4 transition-colors',
                d.isToday ? 'border-violet-500/30 bg-violet-500/[0.06]' :
                d.isPast ? 'border-white/[0.04] bg-white/[0.01] opacity-70' :
                'border-white/[0.06] bg-white/[0.015]')}>
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-widest text-white/40">{weekday}</div>
                <div className={cx('text-2xl font-semibold font-display tabular-nums leading-none mt-1', d.isToday ? 'text-violet-300' : 'text-white')}>{dayNum}</div>
                <div className="text-[10px] text-white/40 mt-0.5">{month}</div>
                {d.isToday && <div className="inline-flex mt-2 text-[9px] font-semibold uppercase tracking-widest text-violet-300">Today</div>}
              </div>
              <div className="min-w-0">
                {d.tasks.length === 0 ? (
                  <div className="h-full flex items-center text-[11px] text-white/25 italic">— Nothing scheduled —</div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                    {d.tasks.map(t => <TaskCard key={t.id} task={t} compact onClick={() => setEditingTask(t)} />)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {undated.length > 0 && (
        <Card title="Undated" subtitle="No due or scheduled date — consider planning these in">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {undated.map(t => <TaskCard key={t.id} task={t} compact onClick={() => setEditingTask(t)} />)}
          </div>
        </Card>
      )}
    </div>
  );
}

/* =================================================================================
   MAIN APP
================================================================================= */
export default function App({ session, currentMember, onSignOut }) {
  return (
    <AppProvider session={session} currentMember={currentMember} onSignOut={onSignOut}>
      <AppShell />
    </AppProvider>
  );
}

function AppShell() {
  const { view, theme, loading } = useApp();

  const content = useMemo(() => {
    switch (view) {
      case 'dashboard': return <DashboardView />;
      case 'kanban':    return <KanbanView />;
      case 'matrix':    return <MatrixView />;
      case 'projects':  return <ProjectsView />;
      case 'schedule':  return <ScheduleView />;
      case 'private':   return <PrivateView />;
      case 'va':        return <VAView />;
      default:          return <DashboardView />;
    }
  }, [view]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#070810] text-white flex items-center justify-center">
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Outfit:wght@300..700&display=swap');
          body { font-family: 'Outfit', sans-serif; background: #070810; }
          .font-display { font-family: 'Fraunces', serif; }`}</style>
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-2xl shadow-fuchsia-500/30 animate-pulse">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <div className="text-sm text-white/50">Loading your workspace…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-[#070810] text-white" data-theme={theme}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Outfit:wght@300..700&display=swap');
        body { font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif; font-feature-settings: "ss01","cv11"; background: #070810; }
        .font-display { font-family: 'Fraunces', ui-serif, serif; font-optical-sizing: auto; font-weight: 500; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.12); border: 2px solid transparent; background-clip: padding-box; }
        .no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        select option { color: white; background: #0f1017; }
        kbd { font-family: 'Outfit', sans-serif; }
        :root:not([data-theme="light"]) input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.6); cursor: pointer; }
        [data-theme="light"] input[type="date"]::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.6; }
        [data-theme="light"] { color-scheme: light; }
        [data-theme="light"] body, [data-theme="light"] { background: #f6f5f2 !important; color: #17181c !important; }
        [data-theme="light"] .bg-\\[\\#070810\\] { background: #f6f5f2 !important; }
        [data-theme="light"] .bg-\\[\\#0a0b11\\] { background: #fbfaf7 !important; border-color: rgba(0,0,0,0.06) !important; }
        [data-theme="light"] .bg-\\[\\#0a0b11\\]\\/80 { background: rgba(251,250,247,0.9) !important; }
        [data-theme="light"] .bg-\\[\\#0a0b11\\]\\/95 { background: rgba(251,250,247,0.95) !important; }
        [data-theme="light"] .bg-\\[\\#0f1017\\] { background: #ffffff !important; color: #17181c !important; }
        [data-theme="light"] .text-white, [data-theme="light"] .text-white\\/95, [data-theme="light"] .text-white\\/90, [data-theme="light"] .text-white\\/85 { color: #17181c !important; }
        [data-theme="light"] .text-white\\/70, [data-theme="light"] .text-white\\/80 { color: #3a3c44 !important; }
        [data-theme="light"] .text-white\\/60, [data-theme="light"] .text-white\\/55, [data-theme="light"] .text-white\\/50 { color: #5a5d69 !important; }
        [data-theme="light"] .text-white\\/45, [data-theme="light"] .text-white\\/40 { color: #6a6d79 !important; }
        [data-theme="light"] .text-white\\/30, [data-theme="light"] .text-white\\/25 { color: #9a9da9 !important; }
        [data-theme="light"] .border-white\\/5, [data-theme="light"] .border-white\\/10, [data-theme="light"] .border-white\\/\\[0\\.06\\], [data-theme="light"] .border-white\\/\\[0\\.08\\] { border-color: rgba(0,0,0,0.08) !important; }
        [data-theme="light"] .bg-white\\/\\[0\\.04\\], [data-theme="light"] .bg-white\\/\\[0\\.03\\], [data-theme="light"] .bg-white\\/\\[0\\.02\\], [data-theme="light"] .bg-white\\/\\[0\\.015\\], [data-theme="light"] .bg-white\\/\\[0\\.005\\], [data-theme="light"] .bg-white\\/5 { background: rgba(0,0,0,0.025) !important; }
        [data-theme="light"] .bg-white\\/\\[0\\.08\\], [data-theme="light"] .bg-white\\/10 { background: rgba(0,0,0,0.06) !important; }
        [data-theme="light"] .search-input { background: #ffffff !important; border-color: rgba(0,0,0,0.12) !important; color: #17181c !important; }
        [data-theme="light"] .search-input::placeholder { color: rgba(0,0,0,0.4) !important; }
        [data-theme="light"] .hover\\:bg-white\\/5:hover, [data-theme="light"] .hover\\:bg-white\\/\\[0\\.04\\]:hover, [data-theme="light"] .hover\\:bg-white\\/\\[0\\.07\\]:hover { background: rgba(0,0,0,0.04) !important; }

        /* Action buttons — keep dark-on-light for "New" button */
        [data-theme="light"] .bg-white { background: #17181c !important; color: #ffffff !important; }
        [data-theme="light"] .text-black { color: #ffffff !important; }
        [data-theme="light"] .hover\\:bg-white\\/90:hover { background: #000 !important; }
        [data-theme="light"] kbd { background: rgba(255,255,255,0.15) !important; color: rgba(255,255,255,0.7) !important; }

        /* Hero sections (Private + VA) — keep them dark for visual contrast */
        [data-theme="light"] .from-\\[\\#1a1530\\] { --tw-gradient-from: #2a2245 !important; }
        [data-theme="light"] .via-\\[\\#14101e\\] { --tw-gradient-via: #1f1a30 !important; }
        [data-theme="light"] .from-\\[\\#0d2a20\\] { --tw-gradient-from: #134032 !important; }
        [data-theme="light"] .via-\\[\\#0c1a18\\] { --tw-gradient-via: #0f2820 !important; }
        [data-theme="light"] .to-\\[\\#0a0b11\\] { --tw-gradient-to: #1a1d28 !important; }

        /* Hero text stays white (since hero bg stays dark) */
        [data-theme="light"] .from-\\[\\#1a1530\\] *, [data-theme="light"] .from-\\[\\#0d2a20\\] * { color: inherit; }
        [data-theme="light"] .from-\\[\\#1a1530\\] h1, [data-theme="light"] .from-\\[\\#0d2a20\\] h1 { color: #ffffff !important; }
        [data-theme="light"] .from-\\[\\#1a1530\\] p, [data-theme="light"] .from-\\[\\#0d2a20\\] p { color: rgba(255,255,255,0.7) !important; }
        [data-theme="light"] .from-\\[\\#1a1530\\] .bg-black\\/30, [data-theme="light"] .from-\\[\\#0d2a20\\] .bg-black\\/30 { background: rgba(0,0,0,0.3) !important; }
        [data-theme="light"] .from-\\[\\#1a1530\\] .bg-white, [data-theme="light"] .from-\\[\\#0d2a20\\] .bg-white { background: #ffffff !important; color: #17181c !important; }
        [data-theme="light"] .from-\\[\\#1a1530\\] .bg-white .text-black, [data-theme="light"] .from-\\[\\#0d2a20\\] .bg-white .text-black { color: #17181c !important; }
        [data-theme="light"] .from-\\[\\#0d2a20\\] .bg-emerald-500 { background: #10b981 !important; color: #ffffff !important; }
        [data-theme="light"] .from-\\[\\#0d2a20\\] .bg-emerald-500 .text-black { color: #ffffff !important; }
        [data-theme="light"] .from-\\[\\#0d2a20\\] .text-white\\/50 { color: rgba(255,255,255,0.6) !important; }
        [data-theme="light"] .from-\\[\\#1a1530\\] .text-white\\/50 { color: rgba(255,255,255,0.6) !important; }
        [data-theme="light"] .from-\\[\\#0d2a20\\] .text-white\\/70, [data-theme="light"] .from-\\[\\#1a1530\\] .text-white\\/70 { color: rgba(255,255,255,0.85) !important; }`}</style>

      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-4 lg:px-6 py-6 pb-24 lg:pb-10">
          <div className="max-w-[1400px] mx-auto animate-[slideUp_.25s_ease]" key={view}>
            {content}
          </div>
        </main>
      </div>
      <MobileTabs />
      <QuickAdd />
      <CommandPalette />
      <TaskModal />
    </div>
  );
}
