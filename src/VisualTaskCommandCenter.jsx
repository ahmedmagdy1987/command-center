import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import {
  LayoutDashboard, KanbanSquare, Grid3x3, FolderKanban, CalendarDays, Lock, UserCog,
  Plus, Search, Command, Settings, Sun, Moon, Download, Upload, RefreshCw, X, Check, CheckCheck,
  Clock, AlertCircle, Flag, Link2, Trash2, Copy, ChevronRight, ChevronDown, ChevronUp,
  CheckCircle2, Calendar, Zap, Timer, MoreHorizontal, Edit3, Filter,
  Flame, TrendingUp, Minimize2, Maximize2, Inbox, PauseCircle, PlayCircle, Sparkles,
  Info, LogOut, Loader2,
  KeyRound, Bell, MessageSquare, MessagesSquare, Send, Mic, Square, Play, Pause, Users, Mail, UserPlus, ArrowRight,
  FileText, Shield, Paperclip, FileImage, User
} from 'lucide-react';
import { tasks as tasksApi, projects as projectsApi, members as membersApi, notifications as notificationsApi, comments as commentsApi, messages as messagesApi, directMessages as directMessagesApi, workspaces as workspacesApi, workspaceMembers as workspaceMembersApi, invitations as invitationsApi, attachments as attachmentsApi, auth } from './lib/api';
import { supabase } from './lib/supabase';
import { sanitizeTask, uid, nowISO } from './lib/sanitize';
import { resolvePlanId, computeEntitlements, getPreviewPlanId, clearPreviewPlan } from './lib/entitlements';
import { FEATURE_META, PLANS } from './lib/plans';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import AuthShell, { AuthBanner, AuthCTA } from './AuthShell';

/* Route <-> view mapping. Each main view gets its own shareable URL. */
const VIEW_TO_PATH = {
  dashboard: '/',
  kanban: '/kanban',
  matrix: '/priority-matrix',
  projects: '/projects',
  schedule: '/schedule',
  mine: '/my-tasks',
  private: '/private',
  chat: '/chat',
  dms: '/dms',
  members: '/members',
};
const PATH_TO_VIEW = Object.fromEntries(Object.entries(VIEW_TO_PATH).map(([v, p]) => [p, v]));
const GUEST_VIEWS = new Set(['mine', 'dms']);

// Bulk import used to accept any file of any size with any number of rows: the ONLY check was
// "is .tasks a non-empty array". These caps are UX guardrails — the DB is the authority (the
// tasks_id_len_chk/tasks_project_len_chk CHECKs, tasks_insert_role, enforce_guest_task_pin).
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB — thousands of realistic tasks, well under the PostgREST body limit
const IMPORT_MAX_ROWS = 1000;   // a Guest's only relevant destinations: own/assigned tasks + DMs

// OS-aware keyboard modifier label. The keydown handler already accepts Ctrl OR Cmd, so only
// the *displayed* hint needs to differ: ⌘ on macOS, Ctrl elsewhere (Windows/Linux).
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(
  navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
);
const shortcutLabel = (key) => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`);

/* =================================================================================
   CONSTANTS
================================================================================= */
// Per-assignee color, deterministic from the user id, + the neutral "unassigned" style.
const ASSIGNEE_PALETTE = [
  { hex: '#a78bfa', soft: 'rgba(167,139,250,0.14)' },
  { hex: '#34d399', soft: 'rgba(52,211,153,0.14)' },
  { hex: '#e879f9', soft: 'rgba(232,121,249,0.14)' },
  { hex: '#38bdf8', soft: 'rgba(56,189,248,0.14)' },
  { hex: '#fb923c', soft: 'rgba(251,146,60,0.14)' },
  { hex: '#f43f5e', soft: 'rgba(244,63,94,0.14)' },
  { hex: '#facc15', soft: 'rgba(250,204,21,0.14)' },
];
const UNASSIGNED_STYLE = { hex: '#8b92a8', soft: 'rgba(139,146,168,0.14)' };
const hashStr = (s) => { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const assigneeColor = (userId) => (userId ? ASSIGNEE_PALETTE[hashStr(userId) % ASSIGNEE_PALETTE.length] : UNASSIGNED_STYLE);
const initialsOf = (s) => (s || '?').trim().slice(0, 1).toUpperCase();
// Two-letter initials for avatars: "Ahmed Magdy" -> AM, "ahmed@x.com" -> AH (the local part only —
// the domain is the same for everyone and carries no identity). Returns '' when there is no name to
// work with, which is the signal for <Avatar> to fall back to the silhouette instead of rendering
// a lone "?" in a circle. Distinct from initialsOf, which stays single-letter for the compact
// assignee chips where a second glyph doesn't fit.
const initialsFor = (s) => {
  const t = (s || '').trim();
  if (!t) return '';
  const base = t.includes('@') ? t.split('@')[0] : t;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
};

// Assignee-filter match: 'all' | 'me' | 'unassigned' | <userId>.
const matchesAssignee = (task, filterVal, meId) =>
  filterVal === 'all' ? true
  : filterVal === 'me' ? task.assigneeId === meId
  : filterVal === 'unassigned' ? !task.assigneeId
  : task.assigneeId === filterVal;

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

// DEFAULT_PROJECTS used to be substituted whenever a workspace had ZERO projects
// (`setProjects(p.length ? p : DEFAULT_PROJECTS)`), which meant an empty workspace rendered NINE
// phantom projects backed by no DB row: ProjectsView listed them, task chips resolved against them,
// and clicking delete on one raised 42704 with no UI path out. It also made the real "No projects
// yet" empty state below unreachable dead code. Removed 2026-07-16 — the client now shows exactly
// what the DB holds. Note `tasks.project` still DEFAULTs to 'other' and sanitizeTask still coerces
// blank -> 'other', and no 'other' project row exists in any workspace, so such a task simply
// renders no chip (`projects.find(...)` -> undefined). That is the intended graceful degradation.

// Palette + glyphs offered when creating/editing a project.
const PROJECT_PALETTE = ['#a78bfa','#f472b6','#38bdf8','#34d399','#fb923c','#f43f5e','#facc15','#94a3b8','#64748b','#22d3ee','#c084fc','#4ade80'];
const PROJECT_ICONS = ['◇','◈','◎','☉','✎','↗','♡','◐','⚙','★','✦','⬢'];


const EFFORTS = {
  quick:  { id: 'quick',  label: 'Quick',  mins: 15, hex: '#34d399' },
  medium: { id: 'medium', label: 'Medium', mins: 45, hex: '#facc15' },
  deep:   { id: 'deep',   label: 'Deep',   mins: 120, hex: '#fb923c' },
};

const THEME_KEY = 'visual-command-center:theme';
const FIRST_RUN_HINTS_KEY = 'cc:firstRunHintsDismissed';   // persists the "dismiss starter hints" choice

const memStore = {};
const themeStore = {
  get(key) {
    try { if (typeof localStorage !== 'undefined') return localStorage.getItem(key); } catch { /* ignore */ }
    return memStore[key] || null;
  },
  set(key, val) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch { /* ignore */ }
    memStore[key] = val;
  },
};

/* =================================================================================
   UTILITIES
================================================================================= */
// Math.round (not floor): the gap between two LOCAL midnights is 23h/25h across DST, so floor would
// mis-count a next-day date as "today" once a year. Matches dayLabel's rounding.
const daysBetween = (a, b) => Math.round((new Date(b).setHours(0,0,0,0) - new Date(a).setHours(0,0,0,0)) / 86400000);

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

const getNextBestScore = (task) => {
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
/** Plan + limits abstraction: can(feature), isOver(limit), usage, plan, etc. (see lib/entitlements.js). */
const useEntitlements = () => useApp().entitlements;

// Per-user persistence of the chosen workspace (survives reload).
const wsStorageKey = (userId) => `cc:currentWorkspace:${userId || 'anon'}`;
const readStoredWorkspace = (userId) => { try { return localStorage.getItem(wsStorageKey(userId)); } catch { return null; } };
const writeStoredWorkspace = (userId, id) => { try { localStorage.setItem(wsStorageKey(userId), id); } catch { /* ignore */ } };

// A ?ws= value is either a human-readable workspace slug or a legacy/bookmarked workspace UUID.
// We accept both: UUID -> match by id (and self-upgrade the URL to the slug); else -> match by slug.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function AppProvider({ children, session, currentMember, onSignOut, refreshCurrentMember }) {
  const location = useLocation();
  const navigate = useNavigate();
  const userId = session?.user?.id;
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState('connecting');

  // Multi-tenancy: the workspaces the user belongs to + which one is currently shown.
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(null);
  // Per-workspace memberships ([{ workspaceId, role }]) — the authority for owner-gated logic.
  // membershipsLoaded gates role-aware UI so it never renders with an unresolved role.
  const [memberships, setMemberships] = useState([]);
  const [membershipsLoaded, setMembershipsLoaded] = useState(false);
  // All members of the CURRENT workspace ([{userId, displayName, email, role}]) — for the assignee
  // picker + member-aware views/labels. Loaded per workspace via the workspace_members_list RPC.
  const [members, setMembers] = useState([]);
  const [membersReloadKey, setMembersReloadKey] = useState(0);   // bump to re-fetch the roster (after a role change)
  // Tasks mid-exit-animation (id present -> the card renders its fade/slide-out before actual removal).
  const [exitingIds, setExitingIds] = useState(() => new Set());
  // Project cards mid-exit-animation (same two-phase pattern as tasks).
  const [exitingProjectIds, setExitingProjectIds] = useState(() => new Set());
  // The caller's pending invitations into OTHER workspaces (for the accept surfaces).
  const [pendingInvites, setPendingInvites] = useState([]);
  // Refs: the just-created "+ Add task" draft (auto-deleted if abandoned empty) + a stable Esc-time closer.
  const draftIdRef = useRef(null);
  const closeEditingRef = useRef(null);

  const [theme, setTheme] = useState(() => {
    const t = themeStore.get(THEME_KEY) || 'dark';
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', t);
    return t;
  });

  // View is driven by the URL (react-router) so each view has a shareable, bookmarkable route.
  const view = PATH_TO_VIEW[location.pathname] ?? 'dashboard';
  // The URL carries the workspace SLUG (human-readable); everything internal (state, api.js,
  // realtime channels, localStorage) stays on the UUID. Falls back to the id when a slug isn't
  // loaded yet — which also keeps old ?ws=<uuid> links working.
  const slugFor = useCallback(
    (id) => workspaces.find(w => w.id === id)?.slug ?? id,
    [workspaces],
  );
  // Keep the current workspace (?ws=) on every view navigation so it survives reload + navigation.
  const setView = useCallback((v) => {
    const path = VIEW_TO_PATH[v] ?? '/';
    navigate(currentWorkspaceId ? `${path}?ws=${slugFor(currentWorkspaceId)}` : path);
  }, [navigate, currentWorkspaceId, slugFor]);
  const [filters, setFilters] = useState({ assignee: 'all', privacy: 'all', project: 'all', search: '' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [compact, setCompact] = useState(false);
  const [draggedId, setDraggedId] = useState(null);
  const [chatUnread, setChatUnread] = useState(0);
  // Minimal app-level toast (transient errors that shouldn't use a native alert) + import-confirm state.
  const [appToasts, setAppToasts] = useState([]);
  const [importPreview, setImportPreview] = useState(null);
  const showToast = useCallback((message, tone = 'error') => {
    const id = uid();
    setAppToasts(p => [...p, { id, message, tone }]);
    setTimeout(() => setAppToasts(p => p.filter(x => x.id !== id)), 4500);
  }, []);
  const chatViewRef = useRef(view);
  useEffect(() => { chatViewRef.current = view; }, [view]);
  const markChatRead = useCallback(() => {
    // Per-workspace key: a single global cursor mis-counts across workspaces (reading chat in A would
    // mark B's older-but-unseen messages as read). The unread effect reads the same per-workspace key.
    try { if (currentWorkspaceId) localStorage.setItem(`cc_chat_last_seen:${currentWorkspaceId}`, new Date().toISOString()); } catch { /* ignore */ }
    setChatUnread(0);
  }, [currentWorkspaceId]);

  // ---- Direct messages (1:1) ---- conversation summaries + handlers live here (the state hub);
  // the open thread loads its own messages. Read state is server-side (dm_reads), so unread + receipts
  // work across devices. currentWorkspaceId stays the scope; everything clears on a workspace switch.
  const [dmConversations, setDmConversations] = useState([]);   // [{ id, peerId, lastAt, preview, unread }]
  const [dmActiveConv, setDmActiveConv] = useState(null);       // open conversation (also set by a notification deep-link)
  // Ref mirror of dmActiveConv (alongside chatViewRef) so refreshDms can tell, without a stale
  // closure, which thread is being actively viewed — and hold that thread's badge at 0 (see refreshDms).
  const dmActiveConvRef = useRef(dmActiveConv);
  useEffect(() => { dmActiveConvRef.current = dmActiveConv; }, [dmActiveConv]);
  const dmUnread = useMemo(() => dmConversations.reduce((n, c) => n + (c.unread || 0), 0), [dmConversations]);

  const refreshDms = useCallback(async (wsId) => {
    const ws = wsId || currentWorkspaceId;
    const me = userId;
    if (!ws || !me) return;
    try {
      const [convs, msgs, unreadRows] = await Promise.all([
        directMessagesApi.listConversations(ws),
        directMessagesApi.listRecentMessages(ws, 500),   // for the last-message PREVIEW per conversation
        directMessagesApi.unreadCounts(ws),               // accurate per-conversation UNREAD at any volume (server-side)
      ]);
      const unreadMap = new Map(unreadRows.map(r => [r.conversationId, r.unread]));
      const lastMsg = new Map();   // conversationId -> newest message (msgs are newest-first, so first-seen wins)
      for (const m of msgs) if (!lastMsg.has(m.conversationId)) lastMsg.set(m.conversationId, m);
      setDmConversations(convs.map(c => {
        const peerId = c.userLo === me ? c.userHi : c.userLo;
        const last = lastMsg.get(c.id) || null;
        // Badge-race fix: while this thread is the one being actively viewed, markDmRead has already
        // zeroed it optimistically; don't let the lagging server value re-inflate the badge here.
        const viewing = chatViewRef.current === 'dms' && c.id === dmActiveConvRef.current;
        return { id: c.id, peerId, lastAt: last?.createdAt || c.createdAt, preview: last, unread: viewing ? 0 : (unreadMap.get(c.id) || 0) };
      }).sort((x, y) => new Date(y.lastAt) - new Date(x.lastAt)));
    } catch (e) { console.error('Failed to load direct messages:', e); }
  }, [currentWorkspaceId, userId]);

  const markDmRead = useCallback(async (conversationId, coverAt) => {
    if (!conversationId) return;
    setDmConversations(prev => prev.map(c => c.id === conversationId ? { ...c, unread: 0 } : c));
    try { await directMessagesApi.markRead(conversationId, coverAt); } catch (e) { console.error('markDmRead failed:', e); }
  }, []);

  const startDm = useCallback(async (peerId) => {
    if (!peerId || !currentWorkspaceId) return null;
    const convId = await directMessagesApi.getOrCreateConversation(peerId, currentWorkspaceId);
    await refreshDms(currentWorkspaceId);
    setDmActiveConv(convId);
    setView('dms');
    return convId;
  }, [currentWorkspaceId, refreshDms, setView]);

  useEffect(() => { themeStore.set(THEME_KEY, theme); }, [theme]);
  useLayoutEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  // Ref mirror of the active workspace (alongside chatViewRef / dmActiveConvRef) so a reconcile
  // refetch that was in flight across a workspace switch can bail instead of applying stale data.
  const currentWorkspaceIdRef = useRef(null);
  useEffect(() => { currentWorkspaceIdRef.current = currentWorkspaceId; }, [currentWorkspaceId]);

  // Resolve the current workspace BEFORE any data query/subscription. Precedence:
  // ?ws= (only if the user is a member) -> localStorage (only if still valid) -> first workspace.
  // An invalid/stale choice silently falls back to the first valid one and corrects URL + storage,
  // so we never fire a query for a workspace the user can't access.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Fetch the workspaces (names for the switcher) AND the caller's per-workspace roles
        // together, so the active workspace's role is known before any role-aware UI renders.
        const [ws, mine] = await Promise.all([workspacesApi.listMine(), workspaceMembersApi.listMine()]);
        if (!mounted) return;
        setWorkspaces(ws);
        setMemberships(mine);
        setMembershipsLoaded(true);
        if (!ws.length) { setCurrentWorkspaceId(null); setLoading(false); return; }   // no workspace -> placeholder
        const ids = new Set(ws.map(w => w.id));
        const bySlug = new Map(ws.map(w => [String(w.slug).toLowerCase(), w.id]));
        const urlWs = new URLSearchParams(window.location.search).get('ws');
        // Resolve ?ws= to a UUID: a UUID matches by id (legacy/bookmarked links); anything else by slug.
        // An unknown/non-member slug or stale UUID resolves to null and falls through cleanly (no throw).
        const fromUrl = urlWs
          ? (UUID_RE.test(urlWs) ? (ids.has(urlWs) ? urlWs : null)
                                 : (bySlug.get(urlWs.toLowerCase()) ?? null))
          : null;
        const stored = readStoredWorkspace(userId);                       // localStorage holds the UUID
        const chosen = fromUrl ?? ((stored && ids.has(stored)) ? stored : ws[0].id);
        setCurrentWorkspaceId(chosen);                                    // currentWorkspaceId stays a UUID
        writeStoredWorkspace(userId, chosen);
        // Normalize the URL to the SLUG (old ?ws=<uuid> links self-upgrade to the slug here).
        const chosenSlug = ws.find(w => w.id === chosen)?.slug ?? chosen;
        navigate(`${window.location.pathname}?ws=${chosenSlug}`, { replace: true });
      } catch (err) {
        console.error('Failed to resolve workspace:', err);
        setSyncStatus('offline');
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [userId, navigate]);

  // 5b: server-computed workspace task aggregates (RLS-scoped) for headline numbers that shouldn't need the
  // whole task array. Kept fresh by a debounced effect below; cleared on switch.
  const [workspaceStats, setWorkspaceStats] = useState(null);

  // Load the current workspace's data once it's resolved; re-runs (clear + refetch) on switch.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setTasks([]);                  // clear so a switch doesn't flash the previous workspace's data
      setProjects([]);
      setWorkspaceStats(null);
      try {
        const [t, p, s] = await Promise.all([tasksApi.list(currentWorkspaceId), projectsApi.list(currentWorkspaceId), tasksApi.stats(currentWorkspaceId).catch(() => null)]);
        if (!mounted) return;
        setTasks(t);
        setProjects(p);
        setWorkspaceStats(s);
      } catch (err) {
        console.error('Failed to load:', err);
        setSyncStatus('offline');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [currentWorkspaceId]);

  // 5b: refresh the server task stats after any task change (own edit or realtime), debounced so a burst
  // collapses into one aggregate query. The initial load fetches them above; this keeps them current.
  useEffect(() => {
    if (!currentWorkspaceId) return undefined;
    const t = setTimeout(() => { tasksApi.stats(currentWorkspaceId).then(setWorkspaceStats).catch(() => {}); }, 500);
    return () => clearTimeout(t);
  }, [currentWorkspaceId, tasks]);

  // Load the current workspace's members for the assignee picker + member-aware views/labels.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let on = true;
    workspaceMembersApi.listForWorkspace(currentWorkspaceId)
      .then(m => { if (on) setMembers(m); })
      .catch(e => console.error('Failed to load workspace members:', e));
    // Clear on switch/unmount so a workspace change can't briefly show the prior workspace's roster
    // (mirrors the tasks/projects reset in the data-load effect).
    return () => { on = false; setMembers([]); };
  }, [currentWorkspaceId, membersReloadKey]);

  useEffect(() => {
    if (!currentWorkspaceId) return;
    setSyncStatus('connecting');
    const unsub = tasksApi.subscribe(({ type, task }) => {
      setSyncStatus('live');
      if (type === 'DELETE') {
        setTasks(prev => prev.filter(t => t.id !== task.id));   // id-only; no-op if not in this workspace's list
      } else if (task.workspaceId && task.workspaceId !== currentWorkspaceId) {
        // ignore INSERT/UPDATE for other workspaces (one subscription sees all the user's rows via RLS)
      } else if (type === 'INSERT') {
        setTasks(prev => prev.some(t => t.id === task.id) ? prev : [task, ...prev]);
      } else if (type === 'UPDATE') {
        setTasks(prev => prev.map(t => t.id === task.id ? task : t));
      }
    }, currentWorkspaceId);
    const timer = setTimeout(() => setSyncStatus(s => s === 'connecting' ? 'live' : s), 1000);
    return () => { unsub(); clearTimeout(timer); };
  }, [currentWorkspaceId]);

  // Live unread badge for chat: count messages newer than the user's last-seen (localStorage)
  // and bump it on new messages from others while they're not viewing the channel.
  useEffect(() => {
    const me = session?.user?.id;
    if (!me || !currentWorkspaceId) return;
    let on = true;
    let lastSeen = null;
    try { lastSeen = localStorage.getItem(`cc_chat_last_seen:${currentWorkspaceId}`); } catch { /* ignore */ }
    messagesApi.unreadCount(lastSeen, me, currentWorkspaceId).then(n => { if (on) setChatUnread(n); }).catch(() => {});
    const unsub = messagesApi.subscribe(({ type, message }) => {
      if (type !== 'INSERT' || !message || !on) return;
      if (message.senderId === me) return;
      if (chatViewRef.current === 'chat') return;   // viewing -> ChatView keeps it read
      setChatUnread(n => n + 1);
    }, 'messages-unread', currentWorkspaceId);
    return () => { on = false; unsub(); };
  }, [session?.user?.id, currentWorkspaceId]);

  // Direct messages: load the workspace's conversation summaries + live-refresh on any DM change
  // (cheap re-summarize; recomputes previews + unread from the server-side cursors). Clears on switch.
  useEffect(() => {
    if (!currentWorkspaceId || !userId) return;   // clearing is handled by the prior run's cleanup
    let on = true;
    let timer = null;
    // Coalesce bursts: refreshDms runs THREE queries (listConversations + listRecentMessages(500) +
    // unreadCounts). Firing that per incoming DM event is a thundering herd once a busy workspace has
    // several active threads. A trailing debounce collapses a burst into one re-summarize; the open
    // thread itself stays instant (it's driven by the separate per-conversation subscribeThread).
    const scheduleRefresh = () => {
      if (timer) return;                                    // one refresh already queued; this event is covered
      timer = setTimeout(() => { timer = null; if (on) refreshDms(currentWorkspaceId); }, 400);
    };
    Promise.resolve().then(() => { if (on) refreshDms(currentWorkspaceId); });   // initial load: immediate
    const unsub = directMessagesApi.subscribe(({ message }) => {
      if (!on || !message) return;
      scheduleRefresh();
    }, currentWorkspaceId);
    return () => { on = false; if (timer) clearTimeout(timer); unsub(); setDmConversations([]); setDmActiveConv(null); };
  }, [currentWorkspaceId, userId, refreshDms]);

  // Reconcile global state after a reconnect / tab-refocus. Realtime auto-reconnects, but any events
  // that fired while the socket or network was down are gone for good — without this, the board and DM
  // list can show stale data indefinitely. Unlike the workspace-switch effect this does NOT clear-and-
  // flash; it refetches in place. Throttled so an online/focus flap can't stampede the queries, and
  // guarded by the workspace ref so a refetch that raced a switch is discarded.
  const lastReconcileRef = useRef(0);
  const reconcile = useCallback(async (reason) => {
    const ws = currentWorkspaceId;
    if (!ws || !userId) return;
    const now = Date.now();
    if (now - lastReconcileRef.current < 8000) return;   // at most one reconcile per 8s
    lastReconcileRef.current = now;
    try {
      const [t, p] = await Promise.all([tasksApi.list(ws), projectsApi.list(ws)]);
      if (currentWorkspaceIdRef.current !== ws) return;   // a switch raced us — drop the stale result
      setTasks(t);
      setProjects(p);
      setSyncStatus('live');
    } catch (e) {
      console.error(`Reconcile (${reason}) failed:`, e);
      setSyncStatus('offline');
    }
    refreshDms(ws);
  }, [currentWorkspaceId, userId, refreshDms]);

  useEffect(() => {
    const onOnline = () => { setSyncStatus('live'); reconcile('online'); };
    const onOffline = () => setSyncStatus('offline');
    // A dropped websocket often does NOT fire a window offline/online event (the network is fine, the
    // socket just died); catching the tab regaining visibility reconciles that common case too.
    const onVisible = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) reconcile('visible'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) setSyncStatus('offline');
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reconcile]);

  useEffect(() => {
    const handler = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = ['INPUT','TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
      else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); setQuickAddOpen(true); }
      else if (!inField && e.key === '/') { e.preventDefault(); document.getElementById('global-search')?.focus(); }
      else if (!inField && e.key.toLowerCase() === 'n' && !mod) { e.preventDefault(); setQuickAddOpen(true); }
      else if (e.key === 'Escape') { setPaletteOpen(false); setQuickAddOpen(false); closeEditingRef.current?.(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const addTask = useCallback(async (partial) => {
    const optimistic = {
      ...sanitizeTask({
        id: uid(),
        title: 'New task',
        assigneeId: session?.user?.id ?? null,
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
      }),
      workspaceId: currentWorkspaceId,
    };
    setTasks(prev => [optimistic, ...prev]);
    try {
      const real = await tasksApi.create(optimistic, currentWorkspaceId);
      setTasks(prev => prev.map(t => t.id === optimistic.id ? real : t));
      return real;
    } catch (err) {
      console.error('Add task failed:', err);
      setTasks(prev => prev.filter(t => t.id !== optimistic.id));
      showToast("Couldn't add the task. Please try again.");
    }
  }, [session, currentWorkspaceId, showToast]);

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
      // Reconcile within the CURRENT workspace only — a bare list() would pull tasks from every
      // workspace the user belongs to into the active view (RLS-safe, but wrong scope on screen).
      // Also re-sync the open modal so it doesn't keep showing an edit the server rejected.
      tasksApi.list(currentWorkspaceId).then(fresh => { setTasks(fresh); setEditingTask(et => et ? (fresh.find(t => t.id === et.id) ?? et) : et); }).catch(() => {});
      showToast("Couldn't save that change — reverted to the last saved version.");
    }
  }, [currentWorkspaceId, showToast]);

  // Two-phase delete: fade/slide the card out (~180ms), then remove + persist. Reduced-motion -> immediate.
  const deleteTask = useCallback((id) => {
    const finish = () => {
      setTasks(p => p.filter(t => t.id !== id));
      setExitingIds(p => { const n = new Set(p); n.delete(id); return n; });
      // Best-effort: remove attachment objects (Storage API) while their metadata rows still exist to
      // authorize it, THEN delete the task (its attachment metadata cascades). The hourly DB sweep is
      // the backstop for any objects the caller couldn't remove (others' uploads, non-admin).
      attachmentsApi.removeAllForTask(id).catch(() => {}).finally(() => {
        tasksApi.delete(id).catch(err => {
          console.error('Delete failed:', err);
          tasksApi.list(currentWorkspaceId).then(setTasks).catch(() => {});   // reconcile with server on failure
          showToast("Couldn't delete the task — it's back in the list.");
        });
      });
    };
    if (prefersReducedMotion()) { finish(); return; }
    setExitingIds(p => new Set(p).add(id));
    setTimeout(finish, 180);
  }, [currentWorkspaceId, showToast]);

  // ---- Projects: create (member), rename/recolor (member), delete (owner; all RLS-enforced) ----
  const createProject = useCallback(async ({ name, color, icon }) => {
    const created = await projectsApi.create({ name, color, icon }, currentWorkspaceId);
    setProjects(p => [...p, created].sort((a, b) => a.name.localeCompare(b.name)));
    return created;
  }, [currentWorkspaceId]);

  const renameProject = useCallback(async (id, patch) => {
    setProjects(p => p.map(x => x.id === id ? { ...x, ...patch } : x).sort((a, b) => a.name.localeCompare(b.name)));
    try {
      await projectsApi.update(id, patch);
    } catch (err) {
      console.error('Update project failed:', err);
      projectsApi.list(currentWorkspaceId).then(p => setProjects(p)).catch(() => {});
      showToast("Couldn't save the project change — reverted.");
    }
  }, [currentWorkspaceId, showToast]);

  // Two-phase delete via the sanctioned delete_project RPC: fade the card out (~180ms), then run the
  // cascade/unassign and refetch (both tasks and projects changed server-side). Reduced-motion ->
  // immediate. mode: 'cascade' (owner: delete tasks too) | 'unassign' (owner+admin: re-file to reassignTo).
  const deleteProject = useCallback((id, mode, reassignTo) => {
    const reconcile = () => Promise.all([tasksApi.list(currentWorkspaceId), projectsApi.list(currentWorkspaceId)])
      .then(([t, p]) => { setTasks(t); setProjects(p); }).catch(() => {});
    const finish = async () => {
      setProjects(p => p.filter(x => x.id !== id));
      setExitingProjectIds(p => { const n = new Set(p); n.delete(id); return n; });
      try {
        await projectsApi.deleteViaRpc(id, currentWorkspaceId, mode, reassignTo);
        await reconcile();
      } catch (err) {
        console.error('Delete project failed:', err);
        await reconcile();
        showToast("Couldn't delete the project — nothing was changed.");
      }
    };
    if (prefersReducedMotion()) { finish(); return; }
    setExitingProjectIds(p => new Set(p).add(id));
    setTimeout(finish, 180);
  }, [currentWorkspaceId, showToast]);

  const duplicateTask = useCallback(async (id) => {
    const original = tasks.find(t => t.id === id);
    if (!original) return;
    const copy = { ...original, id: uid(), title: original.title + ' (copy)', createdAt: nowISO(), updatedAt: nowISO(), completedAt: null, status: 'inbox' };
    setTasks(prev => [copy, ...prev]);
    try {
      const real = await tasksApi.create(copy, currentWorkspaceId);
      setTasks(prev => prev.map(t => t.id === copy.id ? real : t));
    } catch (err) {
      console.error('Duplicate failed:', err);
      setTasks(prev => prev.filter(t => t.id !== copy.id));
    }
  }, [tasks, currentWorkspaceId]);

  // All checklist mutations funnel through here. To avoid the lost-update CLOBBER (two people editing
  // different items on the same shared task, or acting on a stale local snapshot), we never rewrite the
  // whole array from local state: we re-read the FRESHEST subtasks from the DB and re-apply the SAME
  // by-id change to that, so a concurrent change to a DIFFERENT item — already committed — is preserved.
  // Local state + the open modal snapshot update optimistically for instant feedback, then reconcile to
  // the merged result. (`mutate` must be a pure by-id transform so re-applying it to fresh data is safe.)
  const mutateSubtasks = useCallback(async (taskId, mutate) => {
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, subtasks: mutate(t.subtasks || []) } : t));
    setEditingTask(et => (et && et.id === taskId ? { ...et, subtasks: mutate(et.subtasks || []) } : et));
    try {
      const fresh = await tasksApi.getSubtasks(taskId);   // current DB array, not our (possibly stale) snapshot
      const merged = mutate(fresh);                        // re-apply the by-id change to the freshest data
      await tasksApi.update(taskId, { subtasks: merged });
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, subtasks: merged } : t));
      setEditingTask(et => (et && et.id === taskId ? { ...et, subtasks: merged } : et));
    } catch (err) {
      console.error('Subtask update failed:', err);
      // Reconcile to server on failure — including the open modal, which otherwise keeps the stale checklist.
      tasksApi.list(currentWorkspaceId).then(fresh => { setTasks(fresh); setEditingTask(et => et ? (fresh.find(t => t.id === et.id) ?? et) : et); }).catch(() => {});
      showToast("Couldn't save the checklist change — reverted to the server copy.");
    }
  }, [currentWorkspaceId, showToast]);

  const toggleSubtask = useCallback((taskId, subId) =>
    mutateSubtasks(taskId, subs => subs.map(s => s.id === subId ? { ...s, done: !s.done } : s)),
  [mutateSubtasks]);

  const addSubtask = useCallback((taskId, title) => {
    const clean = (title || '').trim();
    if (!clean) return undefined;
    const item = { id: uid(), title: clean, done: false };   // created ONCE so the id is stable across re-applies
    return mutateSubtasks(taskId, subs => [...subs, item]);
  }, [mutateSubtasks]);

  const removeSubtask = useCallback((taskId, subId) =>
    mutateSubtasks(taskId, subs => subs.filter(s => s.id !== subId)),
  [mutateSubtasks]);

  // Reorder by id against the FRESH order, so a concurrent add/remove can't scramble the move.
  const moveSubtask = useCallback((taskId, subId, dir) =>
    mutateSubtasks(taskId, subs => {
      const i = subs.findIndex(s => s.id === subId);
      if (i < 0) return subs;
      const j = i + dir;
      if (j < 0 || j >= subs.length) return subs;
      const next = subs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    }),
  [mutateSubtasks]);

  const exportJSON = useCallback(() => {
    const blob = new Blob([JSON.stringify({ tasks, projects, exportedAt: nowISO() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `command-center-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
  }, [tasks, projects]);

  const importJSON = useCallback((file) => {
    // Derived from memberships here rather than the isGuest binding: isGuest is declared further down,
    // so naming it in this dep array would be a TDZ ReferenceError on every render. Same source of
    // truth as the myRole memo. (UI half only — the DB is authoritative.)
    const role = memberships.find(m => m.workspaceId === currentWorkspaceId)?.role ?? null;
    if (role === 'guest') { showToast("Guests can't import tasks.", 'info'); return; }
    if (file.size > IMPORT_MAX_BYTES) {
      showToast(`That file is too large (max ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const d = JSON.parse(e.target.result);
        if (!Array.isArray(d.tasks) || !d.tasks.length) { showToast('That file has no tasks to import.', 'info'); return; }
        if (d.tasks.length > IMPORT_MAX_ROWS) {
          showToast(`That file has ${d.tasks.length} tasks — the limit is ${IMPORT_MAX_ROWS} per import.`);
          return;
        }
        setImportPreview({ tasks: d.tasks, count: d.tasks.length });   // opens a ConfirmModal
      } catch {
        showToast("That file isn't valid JSON.");
      }
    };
    reader.onerror = () => showToast("Couldn't read that file.");
    reader.readAsText(file);
  }, [showToast, memberships, currentWorkspaceId]);

  const confirmImport = useCallback(async () => {
    const pv = importPreview; setImportPreview(null);
    if (!pv) return;
    // Never trust ids from a file. Minting fresh ones kills two problems at once: a colliding id
    // aborts the WHOLE batch (bulkInsert is one statement), and 23505-vs-success would otherwise be a
    // cross-tenant probe for whether a task id exists (ids are a global TEXT PK).
    // Also pin assignee to a real member of THIS workspace — an unknown id is only FK-checked against
    // auth.users, so it would fire notify_on_task_assigned and write a notification row in a stranger's
    // name that nobody can read.
    const memberIds = new Set(members.map(m => m.id));
    const rows = pv.tasks.map(t => {
      const row = { ...(t && typeof t === 'object' ? t : {}) };
      delete row.id;                                                              // mint a fresh id (see above)
      if (!memberIds.has(row.assigneeId)) row.assigneeId = null;                  // pin to a real member of this workspace
      return row;
    });
    try { const created = await tasksApi.bulkInsert(rows, currentWorkspaceId); setTasks(prev => [...created, ...prev]); }
    catch (err) { console.error('Import failed:', err); showToast("Couldn't import those tasks. Please try again."); }
  }, [importPreview, currentWorkspaceId, showToast, members]);

  const switchWorkspace = useCallback((id) => {
    if (id === currentWorkspaceId || !workspaces.some(w => w.id === id)) return;
    setCurrentWorkspaceId(id);
    writeStoredWorkspace(userId, id);
    navigate(`${window.location.pathname}?ws=${slugFor(id)}`, { replace: true });
  }, [currentWorkspaceId, workspaces, userId, navigate, slugFor]);

  // Create a workspace, then land in it as its OWNER. CRITICAL ordering: after the RPC succeeds we
  // RE-FETCH both the workspaces list AND the per-workspace memberships BEFORE switching, because
  // isOwner/isMember are derived from `memberships`. Switching with a stale memberships list would
  // resolve the brand-new workspace as NOT its owner. Errors (validation / auth) propagate to the
  // caller's form so it can surface them cleanly.
  const createWorkspace = useCallback(async (name) => {
    const created = await workspacesApi.create(name);
    const [ws, mine] = await Promise.all([workspacesApi.listMine(), workspaceMembersApi.listMine()]);
    setWorkspaces(ws);
    setMemberships(mine);
    setMembershipsLoaded(true);
    const targetId = created?.id ?? ws[ws.length - 1]?.id ?? null;
    if (targetId) {
      setCurrentWorkspaceId(targetId);          // triggers the data-load effect -> clean empty states
      writeStoredWorkspace(userId, targetId);
      const targetSlug = created?.slug ?? ws.find(w => w.id === targetId)?.slug ?? targetId;
      navigate(`${VIEW_TO_PATH.dashboard}?ws=${targetSlug}`, { replace: true });
    }
    return created;
  }, [userId, navigate]);

  // Pending invitations the caller can accept (into OTHER workspaces). Loaded by email via RLS, then
  // enriched with the workspace name via the authenticated preview (the invitee isn't a member yet,
  // so workspaces RLS would otherwise hide the name). Expired invites are dropped.
  const refreshInvites = useCallback(async () => {
    if (!userId) { setPendingInvites([]); return; }
    try {
      const mine = await invitationsApi.listMine();
      const enriched = await Promise.all(mine.map(async (inv) => {
        try { const p = await invitationsApi.preview(inv.token); return { ...inv, workspaceName: p?.workspace_name || 'a workspace', isExpired: !!p?.is_expired }; }
        catch { return { ...inv, workspaceName: 'a workspace', isExpired: false }; }
      }));
      setPendingInvites(enriched.filter(i => !i.isExpired));
    } catch (err) { console.error('Failed to load pending invites:', err); }
  }, [userId]);
  useEffect(() => { refreshInvites(); }, [refreshInvites]);

  // Accept an invite, then refetch workspaces + memberships and switch into the new one
  // (the createWorkspace pattern, minus the create — so isOwner/isMember derive correctly).
  const acceptInvitation = useCallback(async (token) => {
    const ws = await invitationsApi.accept(token);
    const [wss, mine] = await Promise.all([workspacesApi.listMine(), workspaceMembersApi.listMine()]);
    setWorkspaces(wss);
    setMemberships(mine);
    setMembershipsLoaded(true);
    setPendingInvites(prev => prev.filter(i => i.token !== token));
    const targetId = ws?.id ?? null;
    if (targetId) {
      setCurrentWorkspaceId(targetId);
      writeStoredWorkspace(userId, targetId);
      const targetSlug = ws?.slug ?? wss.find(w => w.id === targetId)?.slug ?? targetId;
      navigate(`${VIEW_TO_PATH.dashboard}?ws=${targetSlug}`, { replace: true });
    }
    return ws;
  }, [userId, navigate]);

  // Authoritative role for the CURRENTLY-selected workspace (from workspace_members) — NOT the
  // vestigial global members.role. Recomputed on workspace switch, so a user who is owner in one
  // workspace and member in another always sees the role matching the active workspace.
  const myRole = useMemo(
    () => memberships.find(m => m.workspaceId === currentWorkspaceId)?.role ?? null,
    [memberships, currentWorkspaceId],
  );
  const isOwner = myRole === 'owner';
  const isAdmin = myRole === 'admin';
  const isMember = myRole === 'member';
  const isGuest = myRole === 'guest';
  const canManageMembers = isOwner || isAdmin;   // owner+admin manage members/invites/roles

  // Reload the current workspace's roster (after a role change / removal) AND the caller's own
  // memberships (so myRole / canManageMembers update if they changed their own role).
  const refreshMembers = useCallback(async () => {
    setMembersReloadKey(k => k + 1);
    try { setMemberships(await workspaceMembersApi.listMine()); } catch (e) { console.error('refresh memberships failed:', e); }
  }, []);

  // Resolve an assignee id -> { id, label, hex, soft, initials } for chips/labels. 'Me' for self,
  // 'Unassigned' (neutral) for null, display name otherwise. Color is deterministic per user id.
  const resolveAssignee = useCallback((assigneeId) => {
    if (!assigneeId) return { id: null, label: 'Unassigned', hex: UNASSIGNED_STYLE.hex, soft: UNASSIGNED_STYLE.soft, initials: '·', avatarUrl: null };
    const m = members.find(x => x.userId === assigneeId);
    const name = m?.displayName || m?.email || 'Member';
    const c = assigneeColor(assigneeId);
    return { id: assigneeId, label: assigneeId === userId ? 'Me' : name, hex: c.hex, soft: c.soft, initials: initialsOf(name), avatarUrl: m?.avatarUrl || null };
  }, [members, userId]);

  // "Added by X" label for a task's creator: 'you' for self, the member's name, or a graceful fallback.
  const creatorLabel = useCallback((id) => {
    if (!id) return 'someone';
    if (id === userId) return 'you';
    const m = members.find(x => x.userId === id);
    return m ? (m.displayName || m.email) : 'a former member';
  }, [members, userId]);

  // "+ Add task" (Kanban): create a row immediately (empty title) and open the full TaskModal on it.
  const startDraftTask = useCallback(async (partial) => {
    const real = await addTask({ title: '', ...partial });
    if (real) { draftIdRef.current = real.id; setEditingTask(real); }
    return real;
  }, [addTask]);

  // Close the task modal; if the open task is an abandoned "+ Add task" draft with an empty title, delete it.
  const closeEditing = useCallback(() => {
    if (editingTask && editingTask.id === draftIdRef.current && !(editingTask.title || '').trim()) {
      deleteTask(editingTask.id);
    }
    draftIdRef.current = null;
    setEditingTask(null);
  }, [editingTask, deleteTask]);
  useEffect(() => { closeEditingRef.current = closeEditing; });   // keep the Esc-time closer current (ref write off-render)

  // ── Monetization: resolve this workspace's plan + entitlements, plus a small
  // channel for "show the upgrade prompt for feature X". Plan resolution is the
  // seam in lib/entitlements.js (everyone -> 'founding' all-access today, so no
  // existing user is gated). No DB column and no payment SDK in this pass.
  const [upgradeFeature, setUpgradeFeature] = useState(null);
  const requestUpgrade = useCallback((featureKey) => setUpgradeFeature(featureKey), []);
  const dismissUpgrade = useCallback(() => setUpgradeFeature(null), []);
  const entitlements = useMemo(() => computeEntitlements({
    planId: resolvePlanId(currentWorkspaceId),   // seam ignores the arg today; will key the DB plan lookup later
    seatCount: members.length,
    ownedWorkspaceCount: memberships.filter(m => m.role === 'owner').length,
    isPreview: !!getPreviewPlanId(),
  }), [members.length, memberships, currentWorkspaceId]);

  // Memoize the context value so a re-render of AppProvider that DIDN'T change any of these members
  // (e.g. a parent/App re-render) doesn't hand every useApp() consumer a fresh object and reconcile
  // the whole tree. All setters/useCallback handlers are already stable, so in practice this only
  // produces a new value when a state/derived field actually changes. Deps list every member; the
  // stable ones are harmless to include, but omitting a state field would ship a stale closure.
  const value = useMemo(() => ({
    tasks, projects, workspaceStats, theme, view, filters, compact, draggedId,
    paletteOpen, quickAddOpen, editingTask,
    loading, membershipsLoaded, syncStatus, session, currentMember, refreshCurrentMember, isMember, isOwner, isAdmin, isGuest, canManageMembers, myRole, onSignOut,
    workspaces, currentWorkspaceId, switchWorkspace, createWorkspace,
    members, meId: userId, resolveAssignee, refreshMembers,
    setTheme, setView, setFilters, setCompact, setDraggedId,
    setPaletteOpen, setQuickAddOpen, setEditingTask,
    addTask, updateTask, deleteTask, duplicateTask, toggleSubtask, addSubtask, removeSubtask, moveSubtask,
    createProject, renameProject, deleteProject, exitingProjectIds,
    pendingInvites, acceptInvitation, refreshInvites,
    startDraftTask, closeEditing, exitingIds, creatorLabel,
    exportJSON, importJSON, showToast,
    chatUnread, markChatRead,
    dmConversations, dmUnread, dmActiveConv, setDmActiveConv, markDmRead, startDm, refreshDms,
    entitlements, upgradeFeature, requestUpgrade, dismissUpgrade,
  }), [
    tasks, projects, workspaceStats, theme, view, filters, compact, draggedId,
    paletteOpen, quickAddOpen, editingTask,
    loading, membershipsLoaded, syncStatus, session, currentMember, refreshCurrentMember, isMember, isOwner, isAdmin, isGuest, canManageMembers, myRole, onSignOut,
    workspaces, currentWorkspaceId, switchWorkspace, createWorkspace,
    members, userId, resolveAssignee, refreshMembers,
    setTheme, setView, setFilters, setCompact, setDraggedId,
    setPaletteOpen, setQuickAddOpen, setEditingTask,
    addTask, updateTask, deleteTask, duplicateTask, toggleSubtask, addSubtask, removeSubtask, moveSubtask,
    createProject, renameProject, deleteProject, exitingProjectIds,
    pendingInvites, acceptInvitation, refreshInvites,
    startDraftTask, closeEditing, exitingIds, creatorLabel,
    exportJSON, importJSON, showToast,
    chatUnread, markChatRead,
    dmConversations, dmUnread, dmActiveConv, setDmActiveConv, markDmRead, startDm, refreshDms,
    entitlements, upgradeFeature, requestUpgrade, dismissUpgrade,
  ]);
  return (
    <AppCtx.Provider value={value}>
      {children}
      {createPortal(
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[200] flex flex-col items-center gap-2 pointer-events-none w-[calc(100vw-2rem)] max-w-sm">
          {appToasts.map(tt => (
            <div key={tt.id} style={{ animation: 'slideUp .2s ease' }}
              className={cx('pointer-events-auto w-full flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur',
                tt.tone === 'error' ? 'border-rose-500/25 bg-rose-500/10 text-rose-200' : 'border-white/10 bg-[#0f1017]/90 text-white/80')}>
              {tt.tone === 'error' ? <AlertCircle className="w-4 h-4 shrink-0 mt-px" /> : <Info className="w-4 h-4 shrink-0 mt-px" />}
              <span className="flex-1 break-words">{tt.message}</span>
              <button onClick={() => setAppToasts(p => p.filter(x => x.id !== tt.id))} aria-label="Dismiss"
                className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>,
        document.body
      )}
      <ConfirmModal open={!!importPreview} icon={Upload} tone="primary" confirmLabel="Import" title="Import tasks"
        message={importPreview ? `${importPreview.count} task${importPreview.count === 1 ? '' : 's'} will be added to your existing tasks.` : ''}
        onConfirm={confirmImport} onClose={() => setImportPreview(null)} />
    </AppCtx.Provider>
  );
}

/* =================================================================================
   SHARED UI PRIMITIVES
================================================================================= */
const cx = (...xs) => xs.filter(Boolean).join(' ');

// Respect the user's reduced-motion preference (skip exit animations + their delays entirely).
const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Relative "time ago" label for notifications (e.g. "just now", "5m ago", "Apr 3"). */
const timeAgo = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function PriorityDot({ priority, size = 8, glow = true }) {
  const p = PRIORITIES[priority];
  return <span className="inline-block rounded-full shrink-0" style={{ width: size, height: size, background: p.hex, boxShadow: glow ? `0 0 10px ${p.glow}` : 'none' }} />;
}

function AssigneeChip({ assigneeId, showLabel = true, size = 'sm' }) {
  const { resolveAssignee } = useApp();
  const a = resolveAssignee(assigneeId);
  const dims = size === 'sm' ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-xs';
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full font-medium tracking-wide', dims)}
      style={{ background: a.soft, color: a.hex, border: `1px solid ${a.hex}33` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: a.hex }} />
      {showLabel && a.label}
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

function IconButton({ icon: Icon, label, active, onClick }) {
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

    if (next.length < 10) {
      setError('Password must be at least 10 characters');
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
              <input type="password" value={next} onChange={e => setNext(e.target.value)} required minLength={10}
                placeholder="At least 10 characters"
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
function TaskCard({ task, compact = false, onClick, draggable = true, showAssignee = true }) {
  const { setDraggedId, updateTask, projects, resolveAssignee, exitingIds, creatorLabel } = useApp();
  const priority = PRIORITIES[task.priority];
  const assignee = resolveAssignee(task.assigneeId);
  const exiting = exitingIds.has(task.id);
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
        exiting && 'animate-[fadeSlideOut_.18s_ease_forwards] pointer-events-none',
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
            {done && <Check className="w-2.5 h-2.5" style={{ color: '#0a0b11' }} strokeWidth={3} />}
          </button>
          <PriorityDot priority={task.priority} />
          {isPrivate && <span title="Private: visible only to the creator and assignee"><Lock className="w-3 h-3 text-white/40 shrink-0" /></span>}
          {isRecurring(task.recurring) && <RefreshCw className="w-3 h-3 text-white/30 shrink-0" />}
          {task.blocked && <PauseCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
        </div>
        {showAssignee && <AssigneeChip assigneeId={task.assigneeId} showLabel={!compact} size="sm" />}
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
            <div className="h-full rounded-full transition-all" style={{ width: `${(doneCount/totalSub)*100}%`, background: `linear-gradient(90deg, ${priority.hex}, ${assignee.hex})` }} />
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
        {!compact && task.createdBy && <span className="text-[10px] text-white/30">· by {creatorLabel(task.createdBy)}</span>}
      </div>
    </div>
  );
}

/** Render text with @mentions shown as styled pills. Matches the FULL display name of any workspace
 *  member (longest-first) so "@Ahmed Magdy" highlights as one pill, not just "@Ahmed". Cosmetic — the
 *  mention payload is the uuid[]. */
function MentionText({ text, mentions }) {
  const { members } = useApp();
  const s = String(text || '');
  // Pill ONLY names that were actually mentioned (the row's mentions uuid[]) — not any @Name that happens
  // to match a member. So free-typed "@Ahmed" (which fires no notification) and DM bodies (no mentions
  // array / no picker) don't render a misleading pill.
  if (!s.includes('@') || !Array.isArray(mentions) || !mentions.length) return s;
  const mentionSet = new Set(mentions);
  const names = (members || []).filter(m => mentionSet.has(m.userId)).map(m => m.displayName || m.email).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return s;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(@(?:' + names.map(esc).join('|') + '))', 'g');
  const known = new Set(names.map(n => '@' + n));
  return s.split(re).map((p, i) => known.has(p)
    ? <span key={i} className="rounded px-1 -mx-0.5 bg-violet-500/20 text-violet-200 font-medium">{p}</span>
    : p);
}

/** A textarea with an inline @-mention picker. Type `@` (at the start or after a space) and a dropdown
 *  of workspace members opens — pick one and `@Display Name ` is inserted and the user id is recorded.
 *  The dropdown is PORTALED to <body> and anchored above the field, so it's never clipped by a modal /
 *  chat container's overflow. onMentionsChange reports the ids whose `@name` is still in the text. The
 *  server trigger is the real gate — it only notifies a mentioned user who can actually see the surface. */
function MentionTextarea({ value, onChange, onMentionsChange, members, meId, onEnter, onTyping, onBlur, rows = 2, placeholder, className, autoFocus, textareaRef, maxLength = 10000 }) {
  const innerRef = useRef(null);
  const taRef = textareaRef || innerRef;
  const pickedRef = useRef(new Map());   // userId -> displayName for everyone picked from the dropdown
  const [menu, setMenu] = useState(null); // { q, at } while an @token is active before the cursor
  const [pos, setPos] = useState(null);   // fixed-position anchor for the portaled dropdown
  const [active, setActive] = useState(0); // highlighted option index for keyboard navigation
  const candidates = (members || []).filter(m => m.userId !== meId);

  const report = (text) => {
    if (!onMentionsChange) return;
    const ids = [];
    for (const [uid, name] of pickedRef.current.entries()) if (name && text.includes('@' + name)) ids.push(uid);
    onMentionsChange(ids);
  };
  const openMenuFor = (text, caret) => {
    const m = text.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    if (m && candidates.length) {
      const r = taRef.current?.getBoundingClientRect();
      if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), bottom: window.innerHeight - r.top + 6, width: Math.max(200, Math.min(r.width, 280)) });
      setMenu({ q: m[1].toLowerCase(), at: caret - m[1].length - 1 });
      setActive(0);   // keep the first (most relevant) item highlighted as the list filters
    } else { setMenu(null); }
  };
  const handleChange = (e) => {
    const text = e.target.value;
    onChange(text); onTyping?.();
    openMenuFor(text, e.target.selectionStart ?? text.length);
    report(text);
  };
  const filtered = menu ? candidates.filter(m => (m.displayName || m.email || '').toLowerCase().includes(menu.q)).slice(0, 8) : [];
  const pick = (mem) => {
    const name = mem.displayName || mem.email; const ta = taRef.current; const caret = ta?.selectionStart ?? value.length;
    const next = value.slice(0, menu.at) + '@' + name + ' ' + value.slice(caret);
    pickedRef.current.set(mem.userId, name); onChange(next); setMenu(null); report(next);
    requestAnimationFrame(() => { const c = menu.at + name.length + 2; if (ta) { ta.focus(); ta.setSelectionRange(c, c); } });
  };
  const onKeyDown = (e) => {
    // While the picker is open, the arrow keys move the highlighted option (NOT the text caret),
    // Enter/Tab selects it, Esc closes it.
    if (menu && filtered.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % filtered.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => (a - 1 + filtered.length) % filtered.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(filtered[Math.min(active, filtered.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && onEnter) { e.preventDefault(); onEnter(); }
  };
  return (
    <div className="relative flex-1 min-w-0">
      <textarea ref={taRef} value={value} onChange={handleChange} onKeyDown={onKeyDown} maxLength={maxLength}
        onClick={(e) => openMenuFor(e.target.value, e.target.selectionStart ?? 0)}
        onBlur={onBlur} rows={rows} placeholder={placeholder} autoFocus={autoFocus} className={cx(className, 'w-full')} />
      {menu && pos && filtered.length > 0 && createPortal(
        <div className="fixed z-[80] max-h-52 overflow-y-auto rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl py-1"
          style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}>
          <div className="px-3 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-widest text-white/40">Mention someone</div>
          {filtered.map((m, i) => (
            <button key={m.userId} type="button" onMouseDown={(ev) => { ev.preventDefault(); pick(m); }} onMouseEnter={() => setActive(i)}
              className={cx('w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left', i === active ? 'bg-violet-500/25 text-white' : 'text-white/85')}>
              <Avatar name={m.displayName || m.email} userId={m.userId} photoUrl={m.avatarUrl} size={20} />
              <span className="truncate">{m.displayName || m.email}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

/* =================================================================================
   TASK MODAL
================================================================================= */
function TaskComments({ taskId }) {
  const { session, currentWorkspaceId, members } = useApp();
  const userId = session?.user?.id;
  const [items, setItems] = useState([]);
  const [people, setPeople] = useState({});
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState('');
  const scrollRef = useRef(null);

  // Resolve author names from members (members are readable by any authenticated user).
  useEffect(() => {
    let mounted = true;
    membersApi.list()
      .then(list => { if (mounted) setPeople(Object.fromEntries((list || []).map(m => [m.id, m]))); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Load this task's comments + subscribe to live changes while the modal is open.
  useEffect(() => {
    if (!taskId) return;
    let mounted = true;
    setLoading(true);
    commentsApi.list(taskId)
      .then(list => { if (mounted) setItems(list); })
      .catch(err => console.error('Failed to load comments:', err))
      .finally(() => { if (mounted) setLoading(false); });

    const unsub = commentsApi.subscribe(taskId, ({ type, comment }) => {
      if (!comment || !mounted) return;
      setItems(prev => {
        if (type === 'DELETE') return prev.filter(c => c.id !== comment.id);
        if (type === 'UPDATE') return prev.map(c => c.id === comment.id ? comment : c);
        return prev.some(c => c.id === comment.id) ? prev : [...prev, comment];
      });
    });
    return () => { mounted = false; unsub(); };
  }, [taskId]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [items.length]);

  const nameOf = (id) => people[id]?.display_name || people[id]?.email || 'Someone';

  // A17: in-flight guard — a fast double-Enter fires two keydown handlers closing over the same render's
  // `text` (state hasn't re-rendered yet), so both would post the same comment (and double its notification).
  // Matches the chat Composer / QuickAdd pattern.
  const sendingRef = useRef(false);
  const send = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    const mns = mentions;
    setText(''); setMentions([]);
    try {
      const created = await commentsApi.add(taskId, body, currentWorkspaceId, mns);
      setItems(prev => prev.some(c => c.id === created.id) ? prev : [...prev, created]);
    } catch (err) {
      console.error('Failed to add comment:', err);
      setText(body); // restore on failure
    } finally {
      sendingRef.current = false;
    }
  };

  const saveEdit = async (id) => {
    const body = editText.trim();
    if (!body) { setEditId(null); return; }
    setEditId(null);
    try {
      const updated = await commentsApi.update(id, body);
      setItems(prev => prev.map(c => c.id === id ? updated : c));
    } catch (err) { console.error('Failed to edit comment:', err); }
  };

  const remove = async (id) => {
    setItems(prev => prev.filter(c => c.id !== id));
    try { await commentsApi.remove(id); }
    catch (err) { console.error('Failed to delete comment:', err); commentsApi.list(taskId).then(setItems).catch(() => {}); }
  };

  return (
    <div className="pt-5 border-t border-white/5">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-white/50" />
        <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">Discussion</div>
        {items.length > 0 && <div className="text-[10px] text-white/30">{items.length}</div>}
      </div>

      <div ref={scrollRef} className="max-h-72 overflow-y-auto no-scrollbar space-y-3 pr-1">
        {loading ? (
          <div className="py-4 text-center text-[11px] text-white/40">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-white/40">No comments yet. Start the discussion.</div>
        ) : items.map(c => {
          const mine = c.authorId === userId;
          const edited = c.updatedAt && c.createdAt && c.updatedAt !== c.createdAt;
          return (
            <div key={c.id} className="group">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-white/80">{mine ? 'You' : nameOf(c.authorId)}</span>
                <span className="text-[10px] text-white/35">{timeAgo(c.createdAt)}{edited ? ' · edited' : ''}</span>
                {mine && editId !== c.id && (
                  <span className="ml-auto flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                    <button onClick={() => { setEditId(c.id); setEditText(c.body); }} className="text-[10px] text-white/40 hover:text-white/80">Edit</button>
                    <button onClick={() => remove(c.id)} className="text-[10px] text-white/40 hover:text-rose-300">Delete</button>
                  </span>
                )}
              </div>
              {editId === c.id ? (
                <div className="space-y-1.5">
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(c.id); } else if (e.key === 'Escape') setEditId(null); }}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/90 outline-none focus:border-violet-400/50 resize-none" />
                  <div className="flex items-center gap-3">
                    <button onClick={() => saveEdit(c.id)} className="text-[10px] font-semibold text-violet-300 hover:text-violet-200">Save</button>
                    <button onClick={() => setEditId(null)} className="text-[10px] text-white/40 hover:text-white/70">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-white/70 leading-relaxed whitespace-pre-wrap break-words rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2"><MentionText text={c.body} mentions={c.mentions} /></div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-end gap-2 mt-3">
        <MentionTextarea value={text} onChange={setText} onMentionsChange={setMentions} members={members} meId={userId} onEnter={send} rows={2}
          placeholder="Write a comment…  (@ to mention, Enter to send)"
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/90 placeholder-white/30 outline-none focus:border-violet-400/50 resize-none" />
        <button onClick={send} disabled={!text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-xs font-semibold bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity shrink-0">
          <Send className="w-3.5 h-3.5" />Send
        </button>
      </div>
    </div>
  );
}

// ---- Task attachments ----
const attachHumanSize = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const isImageMime = (m) => typeof m === 'string' && m.startsWith('image/');

// Image rows show a thumbnail via a short-lived signed URL (fetched per-mount, like VoiceNote);
// everything else shows a file-type icon.
function AttachmentThumb({ attachment }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const isImg = isImageMime(attachment.mimeType);
  useEffect(() => {
    if (!isImg) return;
    let on = true;
    attachmentsApi.signedUrl(attachment.storagePath, 3600).then(u => { if (on) setUrl(u); }).catch(() => { if (on) setFailed(true); });
    return () => { on = false; };
  }, [attachment.storagePath, isImg]);
  if (isImg && url && !failed) {
    return <img src={url} alt="" className="w-10 h-10 rounded-md object-cover border border-white/10 shrink-0" />;
  }
  const Icon = isImg ? FileImage : FileText;
  return (
    <div className="w-10 h-10 rounded-md border border-white/10 bg-white/5 flex items-center justify-center shrink-0">
      <Icon className="w-4 h-4 text-white/50" />
    </div>
  );
}

// Attachments section for the TaskModal. Read-only (list + download) when the user can't edit the task
// — the same canEditTask gate as the checklist; the server RLS is the real authority.
function Attachments({ taskId, canEdit }) {
  const { meId, currentWorkspaceId, isOwner, isAdmin, creatorLabel } = useApp();
  const [items, setItems] = useState(null);        // null = loading
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(() => {
    attachmentsApi.list(taskId).then(setItems).catch(() => setItems([]));
  }, [taskId]);
  // Guarded mount load — don't setState after unmount / after the taskId changed.
  useEffect(() => {
    let on = true;
    attachmentsApi.list(taskId).then(l => { if (on) setItems(l); }).catch(() => { if (on) setItems([]); });
    return () => { on = false; };
  }, [taskId]);

  const canDelete = (a) => a.uploadedBy === meId || isOwner || isAdmin;

  const runUpload = async (fileList) => {
    if (!canEdit) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (items === null) { setError('Still loading attachments — try again in a moment.'); return; }   // count unknown until loaded
    setError('');
    let count = items.length;
    setUploading(true);
    // finally guarantees the "Uploading…" state clears even if an unexpected error escapes the
    // per-file try below — the dropzone can never wedge on a stuck spinner. (A truly HUNG upload on a
    // half-open socket still needs an AbortController timeout in api.js; that's flagged separately so
    // the timeout can be tuned against a real slow 25 MB upload rather than guessed here.)
    try {
      for (const file of files) {
        // Client-side pre-checks for friendly messages; the server RLS + bucket config are authoritative.
        if (!attachmentsApi.ALLOWED_MIME.has(file.type)) { setError(`"${file.name}" — that file type isn't allowed. Images, PDF, text, CSV, ZIP, and Office documents only.`); continue; }
        if (file.size > attachmentsApi.MAX_BYTES) { setError(`"${file.name}" is too large — files must be under 25 MB.`); continue; }
        if (count >= attachmentsApi.MAX_PER_TASK) { setError(`A task can have at most ${attachmentsApi.MAX_PER_TASK} attachments.`); break; }
        try {
          const created = await attachmentsApi.upload(taskId, file, currentWorkspaceId);
          setItems(prev => [...(prev || []), created]);
          count += 1;
        } catch {
          setError(`Couldn't upload "${file.name}". You may have hit the 25 MB file, ${attachmentsApi.MAX_PER_TASK}-per-task, or workspace storage limit — or you don't have permission.`);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const onPick = (e) => { if (e.target.files?.length) runUpload(e.target.files); e.target.value = ''; };
  const onDrop = (e) => { e.preventDefault(); setDragActive(false); if (canEdit) runUpload(e.dataTransfer.files); };

  const download = async (a) => {
    setError('');
    try { const url = await attachmentsApi.signedUrl(a.storagePath, 3600); window.open(url, '_blank', 'noopener'); }
    catch { setError('Could not open that file. Try again.'); }
  };

  const doDelete = async (a) => {
    setConfirmDel(null);
    setItems(prev => (prev || []).filter(x => x.id !== a.id));   // optimistic
    try { await attachmentsApi.remove(a); }
    catch { setError('Could not delete that attachment.'); load(); }
  };

  const count = items?.length ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 flex items-center gap-1.5"><Paperclip className="w-3 h-3" />Attachments</div>
        {count > 0 && <div className="text-[10px] text-white/40 font-medium tabular-nums">{count}/{attachmentsApi.MAX_PER_TASK}</div>}
      </div>

      {canEdit && (
        <div
          role="button" tabIndex={0}
          aria-label="Upload attachment — images, PDF, or documents up to 25 MB"
          onClick={() => fileRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          onDragOver={e => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={cx('mb-2 rounded-lg border border-dashed px-3 py-3 text-center cursor-pointer transition-colors outline-none focus-visible:border-violet-400/60 focus-visible:bg-violet-400/5',
            dragActive ? 'border-violet-400/60 bg-violet-400/5' : 'border-white/15 bg-white/[0.02] hover:bg-white/[0.04]')}
        >
          <div className="flex items-center justify-center gap-2 text-xs text-white/50">
            {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</> : <><Upload className="w-3.5 h-3.5" />Drop files or click to upload</>}
          </div>
          <div className="mt-0.5 text-[10px] text-white/30">Images, PDF, docs · up to 25 MB each</div>
          <input ref={fileRef} type="file" multiple className="hidden"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            onChange={onPick} />
        </div>
      )}

      {error && (
        <div className="mb-2 flex items-start gap-1.5 text-[11px] text-rose-300/90">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /><span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss" className="text-white/40 hover:text-white/70 shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {items === null ? (
        <div className="inline-flex items-center gap-2 text-[11px] text-white/40"><Loader2 className="w-3 h-3 animate-spin" />Loading…</div>
      ) : count === 0 ? (
        !canEdit && <div className="text-xs text-white/30 italic">No attachments.</div>
      ) : (
        <div className="space-y-1.5">
          {items.map(a => (
            <div key={a.id} className="group flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5">
              <AttachmentThumb attachment={a} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/90 truncate">{a.filename}</div>
                <div className="text-[10px] text-white/35 truncate">
                  {a.sizeBytes != null && `${attachHumanSize(a.sizeBytes)} · `}{creatorLabel(a.uploadedBy)} · {new Date(a.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button onClick={() => download(a)} aria-label={`Download ${a.filename}`}
                className="shrink-0 text-white/40 hover:text-white/80 transition-colors p-1"><Download className="w-4 h-4" /></button>
              {canDelete(a) && (
                <button onClick={() => setConfirmDel(a)} aria-label={`Delete ${a.filename}`}
                  className="shrink-0 text-white/30 hover:text-rose-300 focus:text-rose-300 transition-all p-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"><Trash2 className="w-4 h-4" /></button>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal open={!!confirmDel} title="Delete attachment"
        message={confirmDel ? `"${confirmDel.filename}" will be permanently removed. This can't be undone.` : ''}
        onConfirm={() => confirmDel && doDelete(confirmDel)}
        onClose={() => setConfirmDel(null)} />
    </div>
  );
}

function TaskModal() {
  const { editingTask, setEditingTask, updateTask, deleteTask, duplicateTask, projects, toggleSubtask, addSubtask, removeSubtask, moveSubtask, members, meId, isOwner, isAdmin, resolveAssignee, closeEditing, creatorLabel, requestUpgrade } = useApp();
  const entitlements = useEntitlements();
  const t = editingTask;
  const [newSub, setNewSub] = useState('');
  const [recurrenceOpen, setRecurrenceOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => { setNewSub(''); setRecurrenceOpen(false); }, [editingTask?.id]);

  if (!t) return null;
  const set = (patch) => { updateTask(t.id, patch); setEditingTask({ ...t, ...patch }); };
  // Checklist editing follows the TASK edit rule: admin/owner can edit any task; member/guest only their
  // own/assigned. On a task you can see but can't edit, the checklist renders read-only. (RLS is the real
  // gate — this just keeps the UI honest.) The mutations themselves go through the provider's fresh-read-
  // merge helpers (addSubtask/toggleSubtask/removeSubtask/moveSubtask) so concurrent edits don't clobber.
  const canEditTask = isOwner || isAdmin || t.createdBy === meId || t.assigneeId === meId;
  const submitSub = () => { const v = newSub.trim(); if (!v) return; addSubtask(t.id, v); setNewSub(''); };

  const priority = PRIORITIES[t.priority];
  const assignee = resolveAssignee(t.assigneeId);
  const doneSub = t.subtasks.filter(s => s.done).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-6 animate-[fadeIn_.15s_ease]" onClick={closeEditing}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Edit task" className="w-full sm:max-w-2xl max-h-screen sm:max-h-[85vh] overflow-hidden rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl flex flex-col">
        <div className="px-6 pt-5 pb-3 border-b border-white/5" style={{ background: `linear-gradient(180deg, ${priority.bg}, transparent)` }}>
          <div className="flex items-center gap-2 mb-3">
            <AssigneeChip assigneeId={t.assigneeId} />
            {t.privacy === 'private' && <Badge icon={Lock}>Private</Badge>}
            {isRecurring(t.recurring) && <Badge icon={RefreshCw}>{formatRecurrence(t.recurring) || 'Repeats'}</Badge>}
            {!canEditTask && <Badge icon={Info}>Read-only</Badge>}
            <div className="flex-1" />
            <IconButton icon={Copy} label="Duplicate" onClick={() => { duplicateTask(t.id); setEditingTask(null); }} />
            {canEditTask && <IconButton icon={Trash2} label="Delete" onClick={() => setConfirmOpen(true)} />}
            <IconButton icon={X} label="Close" onClick={closeEditing} />
          </div>
          <input
            value={t.title}
            onChange={e => set({ title: e.target.value })}
            readOnly={!canEditTask}
            maxLength={500}
            className="w-full bg-transparent text-xl sm:text-2xl font-semibold text-white placeholder-white/30 outline-none font-display read-only:cursor-default break-words"
            placeholder="Task title"
          />
          {t.createdBy && <div className="mt-1.5 text-[11px] text-white/35">Added by {creatorLabel(t.createdBy)}</div>}
        </div>

        <ConfirmModal open={confirmOpen} title="Delete task"
          message={`"${(t.title || '').trim() || 'Untitled task'}" will be permanently deleted. This can't be undone.`}
          onConfirm={() => { setConfirmOpen(false); deleteTask(t.id); setEditingTask(null); }}
          onClose={() => setConfirmOpen(false)} />

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="flex flex-wrap gap-2">
            <SelectPill label="Status" value={t.status} options={Object.values(STATUSES).map(s => [s.id, s.label])} onChange={v => set({ status: v })} disabled={!canEditTask} />
            <SelectPill label="Priority" value={t.priority} options={Object.values(PRIORITIES).map(p => [p.id, p.label])} onChange={v => set({ priority: v })} color={priority.hex} disabled={!canEditTask} />
            <AssigneeSelect label="Assignee" value={t.assigneeId || ''} disabled={!canEditTask}
              options={[['', 'Unassigned'], ...(meId ? [[meId, 'Me']] : []), ...(t.assigneeId && t.assigneeId !== meId && !members.some(m => m.userId === t.assigneeId) ? [[t.assigneeId, resolveAssignee(t.assigneeId).label]] : []), ...members.filter(m => m.userId !== meId).map(m => [m.userId, m.displayName || m.email])]}
              onChange={v => set({ assigneeId: v || null })} />
            <SelectPill label="Visibility" value={t.privacy} options={[['workspace', 'Shared'], ['private', 'Private']]} onChange={v => set({ privacy: v })} disabled={!canEditTask} />
            <SelectPill label="Project" value={t.project} options={projects.map(p => [p.id, p.name])} onChange={v => set({ project: v })} disabled={!canEditTask} />
            <SelectPill label="Effort" value={t.effort} options={Object.values(EFFORTS).map(e => [e.id, `${e.label} (${e.mins}m)`])} onChange={v => set({ effort: v, estimatedMinutes: EFFORTS[v].mins })} disabled={!canEditTask} />
          </div>

          <div className="flex flex-wrap gap-2">
            <ToggleChip active={t.urgent} onClick={() => set({ urgent: !t.urgent })} icon={Zap} label="Urgent" color="#fb923c" disabled={!canEditTask} />
            <ToggleChip active={t.important} onClick={() => set({ important: !t.important })} icon={Flag} label="Important" color="#a78bfa" disabled={!canEditTask} />
            <ToggleChip active={t.blocked} onClick={() => set({ blocked: !t.blocked })} icon={PauseCircle} label="Blocked" color="#f43f5e" disabled={!canEditTask} />
            <button onClick={() => entitlements.can('recurringTasks') ? setRecurrenceOpen(true) : requestUpgrade('recurringTasks')} type="button" disabled={!canEditTask}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-default',
                isRecurring(t.recurring) ? 'text-white' : cx('text-white/50 border-white/10 bg-white/5', canEditTask && 'hover:bg-white/10'))}
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
                disabled={!canEditTask}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-white/25 disabled:opacity-60 disabled:cursor-default" />
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5">Scheduled for</div>
              <input type="date" value={t.scheduledDate ? t.scheduledDate.slice(0,10) : ''} onChange={e => set({ scheduledDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
                disabled={!canEditTask}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-white/25 disabled:opacity-60 disabled:cursor-default" />
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5">Notes</div>
            <textarea value={t.description} onChange={e => set({ description: e.target.value })} rows={4}
              readOnly={!canEditTask}
              maxLength={20000}
              placeholder="Context, acceptance criteria, links…"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white/90 outline-none focus:border-white/25 resize-y read-only:cursor-default read-only:opacity-80" />
          </div>

          {t.blocked && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-widest text-rose-300/70 mb-1.5">Blocked because</div>
              <input value={t.blockedReason} onChange={e => set({ blockedReason: e.target.value })} placeholder="Waiting on…"
                readOnly={!canEditTask}
                maxLength={1000}
                className="w-full bg-rose-500/5 border border-rose-500/20 rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-rose-500/40 read-only:cursor-default" />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">Checklist</div>
              {t.subtasks.length > 0 && <div className="text-[10px] text-white/40 font-medium tabular-nums">{doneSub}/{t.subtasks.length} done</div>}
            </div>
            {t.subtasks.length > 0 && (
              <div className="h-1 bg-white/5 rounded-full overflow-hidden mb-2.5">
                <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(doneSub / t.subtasks.length) * 100}%`, background: `linear-gradient(90deg, ${priority.hex}, ${assignee.hex})` }} />
              </div>
            )}
            <div className="space-y-1.5">
              {t.subtasks.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 group">
                  <button onClick={() => canEditTask && toggleSubtask(t.id, s.id)} disabled={!canEditTask} aria-pressed={s.done}
                    className={cx('shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-all', !canEditTask && 'cursor-default')}
                    style={{ borderColor: s.done ? priority.hex : 'rgba(255,255,255,0.2)', background: s.done ? priority.hex : 'transparent' }}>
                    {s.done && <Check className="w-2.5 h-2.5" style={{ color: '#0a0b11' }} strokeWidth={3} />}
                  </button>
                  <div className={cx('flex-1 text-sm', s.done ? 'text-white/40 line-through' : 'text-white/85')}>{s.title}</div>
                  {canEditTask && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button onClick={() => moveSubtask(t.id, s.id, -1)} disabled={i === 0} aria-label="Move item up"
                        className="text-white/30 hover:text-white/70 disabled:opacity-20 disabled:cursor-default transition-colors"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button onClick={() => moveSubtask(t.id, s.id, 1)} disabled={i === t.subtasks.length - 1} aria-label="Move item down"
                        className="text-white/30 hover:text-white/70 disabled:opacity-20 disabled:cursor-default transition-colors"><ChevronDown className="w-3.5 h-3.5" /></button>
                      <button onClick={() => removeSubtask(t.id, s.id)} aria-label="Delete item"
                        className="ml-0.5 text-white/30 hover:text-rose-400 transition-colors"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </div>
              ))}
              {canEditTask ? (
                <div className="flex gap-2 pt-1">
                  <input value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitSub()}
                    placeholder="Add checklist item…" maxLength={500}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/90 outline-none focus:border-violet-400/50" />
                  <button onClick={submitSub} className="px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 text-sm">Add</button>
                </div>
              ) : t.subtasks.length === 0 && (
                <div className="text-xs text-white/30 italic">No checklist items.</div>
              )}
            </div>
          </div>

          <Attachments taskId={t.id} canEdit={canEditTask} />

          <div className="pt-4 border-t border-white/5 text-[11px] text-white/30 flex flex-wrap gap-x-4 gap-y-1">
            <span>Created {new Date(t.createdAt).toLocaleDateString()}</span>
            <span>Updated {new Date(t.updatedAt).toLocaleDateString()}</span>
            {t.completedAt && <span>Completed {new Date(t.completedAt).toLocaleDateString()}</span>}
          </div>

          <TaskComments key={t.id} taskId={t.id} />
        </div>
      </div>
    </div>
  );
}

function SelectPill({ label, value, options, onChange, color, disabled = false }) {
  const current = options.find(([v]) => v === value);
  const currentLabel = current ? current[1] : value;
  return (
    <div className={cx('relative inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 h-8 text-xs text-white/85 transition-colors',
      disabled ? 'opacity-60' : 'hover:bg-white/10 cursor-pointer')}>
      {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      <span className="text-white/40">{label}:</span>
      <span className="text-white/95 font-medium">{currentLabel}</span>
      {!disabled && <ChevronDown className="w-3 h-3 text-white/40" />}
      <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
        aria-label={label}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default">
        {options.map(([v,l]) => <option key={v} value={v} className="bg-[#0f1017] text-white">{l}</option>)}
      </select>
    </div>
  );
}

/** A scalable assignee combobox: a trigger pill showing the current selection, and a PORTALED,
 *  type-to-filter, keyboard-navigable dropdown of people — clean whether the workspace has 3 or 30
 *  members. `options` is [[value, label], …] (same shape as SelectPill/FilterPill); value/onChange use
 *  those values. SINGLE-SELECT — the data model is one assignee per task. (A future multi-select is NOT
 *  localized here: it would need the assignee_id data model, all three callers, matchesAssignee and
 *  resolveAssignee to move to arrays — a separate, DB-touching decision.) Avatars are derived from the
 *  value (a user id) where possible; 'all' shows a group icon, '' / 'unassigned' a neutral dot. */
function AssigneeSelect({ label, value, options, onChange, variant = 'field', disabled = false }) {
  const { meId, theme } = useApp();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);   // drives the gentle enter/exit transition
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);

  const avatarFor = (v, lbl) => {
    if (v === 'all') return { all: true };
    if (v === '' || v === 'unassigned' || v == null) return { hex: UNASSIGNED_STYLE.hex, soft: UNASSIGNED_STYLE.soft, initials: '·' };
    const c = assigneeColor(v === 'me' ? meId : v);
    return { hex: c.hex, soft: c.soft, initials: initialsOf(lbl) };
  };
  const current = options.find(([v]) => v === value);
  const curAv = current ? avatarFor(current[0], current[1]) : null;
  const filtered = query ? options.filter(([, l]) => (l || '').toLowerCase().includes(query.toLowerCase())) : options;

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect(); if (!r) return;
    const width = Math.max(r.width, 224);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom;
    const up = below < 300 && r.top > below;
    setPos(up ? { left, width, up: true, bottom: window.innerHeight - r.top + 6 } : { left, width, up: false, top: r.bottom + 6 });
  }, []);
  const openMenu = () => { place(); setQuery(''); setActive(Math.max(0, options.findIndex(([v]) => v === value))); setOpen(true); requestAnimationFrame(() => setShown(true)); };
  const close = () => { setShown(false); setTimeout(() => setOpen(false), 160); };
  const choose = (o) => { onChange(o[0]); close(); };
  const onSearchKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (!filtered.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % filtered.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + filtered.length) % filtered.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(filtered[Math.min(active, filtered.length - 1)]); }
  };
  useEffect(() => { if (open && listRef.current) listRef.current.children[active]?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  useEffect(() => {   // keep the fixed-position menu anchored to its trigger while open (scroll/resize)
    if (!open) return undefined;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);

  const triggerCls = variant === 'filter'
    ? 'relative inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-2.5 h-9 text-xs cursor-pointer transition-colors shrink-0'
    : 'relative inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 px-3 h-8 text-xs cursor-pointer transition-colors';

  return (
    <>
      <button type="button" ref={btnRef} disabled={disabled} onClick={() => (open ? close() : openMenu())} aria-haspopup="listbox" aria-expanded={open} className={cx(triggerCls, disabled && 'opacity-60 !cursor-default')}>
        {variant === 'filter' && <Filter className="w-3 h-3 text-white/40 shrink-0" />}
        {curAv && !curAv.all && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: curAv.hex }} />}
        <span className="text-white/40 shrink-0">{label}:</span>
        <span className="text-white/95 font-medium truncate max-w-[140px]">{current ? current[1] : (value || '')}</span>
        <ChevronDown className={cx('w-3 h-3 text-white/40 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={close} />
          <div role="listbox" aria-label={label}
            className={cx('fixed z-[71] rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl overflow-hidden flex flex-col transition-all duration-150 ease-out',
              shown ? 'opacity-100 translate-y-0' : cx('opacity-0', pos.up ? 'translate-y-1' : '-translate-y-1'))}
            style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: pos.bottom } : { top: pos.top }) }}>
            <div className="p-1.5 border-b border-white/5">
              <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey}
                placeholder="Search people…"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 h-8 text-xs text-white/90 placeholder-white/40 outline-none focus:border-violet-400/50" />
            </div>
            <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-center text-[11px] text-white/40">No one found</div>
              ) : filtered.map((o, i) => {
                const av = avatarFor(o[0], o[1]);
                const isSel = o[0] === value;
                return (
                  <button key={String(o[0]) || 'unassigned'} type="button" role="option" aria-selected={isSel}
                    onMouseEnter={() => setActive(i)} onClick={() => choose(o)}
                    className={cx('w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors',
                      i === active ? 'bg-violet-500/25 text-white' : 'text-white/85 hover:bg-white/5')}>
                    {av.all ? (
                      <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-white/10 text-white/60"><Users className="w-3 h-3" /></span>
                    ) : (
                      <span className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold shrink-0"
                        style={theme === 'light' ? { background: av.hex, color: '#0b0b12' } : { background: av.soft, color: av.hex }}>{av.initials}</span>
                    )}
                    <span className="flex-1 truncate">{o[1]}</span>
                    {isSel && <Check className="w-3.5 h-3.5 text-violet-300 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function ToggleChip({ active, onClick, icon: Icon, label, color, disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-default',
        active ? 'text-white' : cx('text-white/50 border-white/10 bg-white/5', !disabled && 'hover:bg-white/10'))}
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
  const { quickAddOpen, setQuickAddOpen, addTask, projects, view, members, meId } = useApp();
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState(null);
  const [privacy, setPrivacy] = useState('workspace');
  const [priority, setPriority] = useState('medium');
  const [project, setProject] = useState('other');
  const inputRef = useRef(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (quickAddOpen) {
      submittingRef.current = false;
      setTimeout(() => inputRef.current?.focus(), 50);
      // New-task defaults reset EVERY open (consistent): assigned to me, Shared, medium priority.
      // Private view -> Private + personal project.
      setAssigneeId(meId ?? null);
      setPriority('medium');
      if (view === 'private') { setPrivacy('private'); setProject('personal'); }
      else { setPrivacy('workspace'); setProject('other'); }
    } else {
      setTitle('');
    }
  }, [quickAddOpen, view, meId]);

  if (!quickAddOpen) return null;

  const submit = () => {
    if (!title.trim() || submittingRef.current) return;   // guard a fast double-Enter from creating two tasks
    submittingRef.current = true;
    addTask({ title: title.trim(), assigneeId, privacy, priority, project, status: 'inbox' });
    setQuickAddOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 px-4 animate-[fadeIn_.15s_ease]" onClick={() => setQuickAddOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="What needs to get done?" maxLength={500}
            className="flex-1 bg-transparent text-lg text-white outline-none placeholder-white/30 font-display" />
          <kbd className="text-[10px] text-white/30 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Enter</kbd>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <AssigneeSelect label="Assignee" value={assigneeId ?? ''}
              options={[['', 'Unassigned'], ...(meId ? [[meId, 'Me']] : []), ...members.filter(m => m.userId !== meId).map(m => [m.userId, m.displayName || m.email])]}
              onChange={v => setAssigneeId(v || null)} />
            <div className="w-px h-6 bg-white/10 self-center mx-1" />
            <span className="self-center text-[11px] font-medium text-white/40">Visibility</span>
            <button onClick={() => setPrivacy(privacy === 'private' ? 'workspace' : 'private')}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
                privacy === 'private' ? 'text-white' : 'text-white/50 border-white/10 bg-white/5')}
              style={privacy === 'private' ? { background: 'rgba(167,139,250,0.14)', borderColor: '#a78bfa55', color: '#a78bfa' } : {}}>
              <Lock className="w-3 h-3" />{privacy === 'private' ? 'Private' : 'Shared'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
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
            <select value={project} onChange={e => setProject(e.target.value)} aria-label="Project"
              className="bg-white/5 border border-white/10 rounded-full px-3 h-8 text-xs text-white/80 outline-none cursor-pointer">
              {projects.map(p => <option key={p.id} value={p.id} className="bg-[#0f1017]">{p.icon} {p.name}</option>)}
            </select>
            <div className="flex-1" />
            <button onClick={submit} disabled={!title.trim()}
              className="inline-flex items-center gap-1.5 rounded-full px-4 h-8 text-xs font-semibold bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity">
              <Plus className="w-3.5 h-3.5" />Add task
            </button>
          </div>
          <div className="text-[11px] text-white/50">Tip: press <kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded text-white/70">{shortcutLabel('N')}</kbd> or <kbd className="px-1 py-0.5 bg-white/5 border border-white/10 rounded text-white/70">N</kbd> anywhere to capture.</div>
        </div>
      </div>
    </div>
  );
}

/* =================================================================================
   COMMAND PALETTE
================================================================================= */
function CommandPalette() {
  const { paletteOpen, setPaletteOpen, tasks, setEditingTask, setView, setQuickAddOpen, setTheme, theme, exportJSON,
          currentWorkspaceId, setDmActiveConv, resolveAssignee, isGuest } = useApp();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const [idx, setIdx] = useState(0);
  // 5d: team-chat search now runs server-side via the search_messages RPC (full history + RLS-safe: a guest
  // still gets 0 team-chat hits, enforced by messages_select_member — not a client role check). We only load
  // DM bodies here for the client-side DM grep (a DM search RPC is a separate follow-up); DMs stay
  // participant-scoped by RLS. This also drops the old 200-row chat prefetch on every palette open.
  const [msgIndex, setMsgIndex] = useState([]);          // DM bodies only
  const [serverChatMsgs, setServerChatMsgs] = useState([]);   // team-chat matches from the RPC

  useEffect(() => { if (paletteOpen) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 50); } }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return;
    let on = true;
    const load = currentWorkspaceId
      ? directMessagesApi.listRecentMessages(currentWorkspaceId, 500).catch(() => [])
      : Promise.resolve([]);   // no workspace → empty index (set async so this effect never setState-s synchronously)
    load.then(dm => {
      if (!on) return;
      setMsgIndex(dm.filter(m => m.body && !m.deletedAt).map(m => ({ kind: 'dm', id: m.id, body: m.body, senderId: m.senderId, conversationId: m.conversationId })));
    });
    return () => { on = false; };
  }, [paletteOpen, currentWorkspaceId]);

  // Debounced server search over team chat (RLS-respecting). Guest -> 0 hits, by construction.
  useEffect(() => {
    const term = q.trim();
    let on = true;
    const t = setTimeout(() => {
      if (!on) return;
      if (!paletteOpen || !term || !currentWorkspaceId) { setServerChatMsgs([]); return; }
      messagesApi.search(term, currentWorkspaceId, 6)
        .then(rows => { if (on) setServerChatMsgs(rows.filter(m => m.body && !m.deletedAt).map(m => ({ kind: 'chat', id: m.id, body: m.body, senderId: m.senderId }))); })
        .catch(() => { if (on) setServerChatMsgs([]); });
    }, 200);
    return () => { on = false; clearTimeout(t); };
  }, [q, paletteOpen, currentWorkspaceId]);

  // No per-message URL anchor exists (see recon) — deep-link to the channel / conversation, like notifications do.
  const openMessage = (m) => {
    setPaletteOpen(false);
    if (m.kind === 'dm' && m.conversationId) { setDmActiveConv(m.conversationId); setView('dms'); }
    else setView('chat');
  };

  const commands = useMemo(() => { const all = [
    { id: 'new-task', label: 'New task', icon: Plus, run: () => { setPaletteOpen(false); setQuickAddOpen(true); } },
    { id: 'v-dash', label: 'Go to Dashboard', icon: LayoutDashboard, run: () => { setView('dashboard'); setPaletteOpen(false); } },
    { id: 'v-kan', label: 'Go to Kanban', icon: KanbanSquare, run: () => { setView('kanban'); setPaletteOpen(false); } },
    { id: 'v-mat', label: 'Go to Priority Matrix', icon: Grid3x3, run: () => { setView('matrix'); setPaletteOpen(false); } },
    { id: 'v-proj', label: 'Go to Projects', icon: FolderKanban, run: () => { setView('projects'); setPaletteOpen(false); } },
    { id: 'v-sched', label: 'Go to Schedule', icon: CalendarDays, run: () => { setView('schedule'); setPaletteOpen(false); } },
    { id: 'v-priv', label: 'Go to Private tasks', icon: Lock, run: () => { setView('private'); setPaletteOpen(false); } },
    { id: 'v-mine', label: 'Go to My Tasks', icon: UserCog, run: () => { setView('mine'); setPaletteOpen(false); } },
    { id: 'v-chat', label: 'Go to Chat', icon: MessageSquare, run: () => { setView('chat'); setPaletteOpen(false); } },
    { id: 'v-dms', label: 'Go to Direct messages', icon: MessagesSquare, run: () => { setView('dms'); setPaletteOpen(false); } },
    { id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`, icon: theme === 'dark' ? Sun : Moon, run: () => { setTheme(theme === 'dark' ? 'light' : 'dark'); setPaletteOpen(false); } },
    { id: 'export', label: 'Export JSON backup', icon: Download, run: () => { exportJSON(); setPaletteOpen(false); } },
  ];
  // Guests are bounced off every view except My Tasks + Direct messages, so don't offer nav commands
  // that just redirect (matches the Sidebar/MobileTabs guest restriction).
  return isGuest ? all.filter(c => ['new-task', 'v-mine', 'v-dms', 'theme', 'export'].includes(c.id)) : all;
  }, [theme, isGuest]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return { cmds: commands.slice(0, 8), tasks: [], msgs: [] };
    const cmds = commands.filter(c => c.label.toLowerCase().includes(term));
    const tList = tasks.filter(t => {
      const title = (t.title || '').toLowerCase();
      const desc  = (t.description || '').toLowerCase();
      return title.includes(term) || desc.includes(term);
    }).slice(0, 6);
    // team-chat matches from the server RPC (full history, guest-safe) + DM matches from the loaded window
    const dmMsgs = msgIndex.filter(m => m.body.toLowerCase().includes(term)).slice(0, 6);
    const msgs = [...serverChatMsgs, ...dmMsgs].slice(0, 6);
    return { cmds, tasks: tList, msgs };
  }, [q, tasks, commands, msgIndex, serverChatMsgs]);

  const flat = [
    ...results.cmds.map(c => ({ type: 'cmd', item: c })),
    ...results.tasks.map(t => ({ type: 'task', item: t })),
    ...results.msgs.map(m => ({ type: 'msg', item: m })),
  ];

  useEffect(() => { setIdx(0); }, [q]);

  const handleKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = flat[idx];
      if (!sel) return;
      if (sel.type === 'cmd') sel.item.run();
      else if (sel.type === 'task') { setEditingTask(sel.item); setPaletteOpen(false); }
      else openMessage(sel.item);
    }
  };

  if (!paletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 px-4 animate-[fadeIn_.15s_ease]" onClick={() => setPaletteOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center gap-3">
          <Command className="w-4 h-4 text-white/40" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={handleKey}
            placeholder="Search tasks, messages, or run a command…"
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
                    <AssigneeChip assigneeId={t.assigneeId} showLabel={false} />
                  </button>
                );
              })}
            </div>
          )}
          {results.msgs.length > 0 && (
            <div className="px-2 pt-2">
              <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-white/30">Messages</div>
              {results.msgs.map((m, i) => {
                const ii = results.cmds.length + results.tasks.length + i;
                const active = ii === idx;
                const Icon = m.kind === 'dm' ? MessagesSquare : MessageSquare;
                const who = resolveAssignee(m.senderId).label;
                return (
                  <button key={`${m.kind}-${m.id}`} onClick={() => openMessage(m)} onMouseEnter={() => setIdx(ii)}
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                      active ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5')}>
                    <Icon className="w-4 h-4 shrink-0 text-white/40" />
                    <span className="flex-1 min-w-0 truncate">{m.body}</span>
                    <span className="text-[10px] text-white/30 shrink-0">{who} · {m.kind === 'dm' ? 'DM' : 'Team'}</span>
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
  const { view, setView, tasks, meId, chatUnread, dmUnread, canManageMembers, isGuest } = useApp();

  const counts = useMemo(() => {
    const open = tasks.filter(t => t.status !== 'done');
    return {
      all: open.length,
      mine: open.filter(t => t.assigneeId === meId).length,
      private: open.filter(t => t.privacy === 'private').length,
      overdue: open.filter(isOverdue).length,
    };
  }, [tasks, meId]);

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
            <div className="text-[15px] font-semibold text-white font-display tracking-tight">Command Center</div>
            <div className="text-[10px] text-white/40 uppercase tracking-widest">Visual task management</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {isGuest ? (
          // Guests are scoped to their own/assigned tasks + DMs (they're excluded from team chat,
          // projects, the board, etc.), so show only those two relevant destinations — no empty views.
          <>
            {item('mine', UserCog, 'My Tasks', counts.mine)}
            {item('dms', MessagesSquare, 'Direct messages', dmUnread)}
          </>
        ) : (
          <>
            <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-widest text-white/30">Team</div>
            {item('dashboard', LayoutDashboard, 'Dashboard')}
            {item('kanban', KanbanSquare, 'Kanban', counts.all)}
            {item('matrix', Grid3x3, 'Priority Matrix')}
            {item('projects', FolderKanban, 'Projects')}
            {item('schedule', CalendarDays, 'Schedule')}
            {item('chat', MessageSquare, 'Chat', chatUnread)}
            {item('dms', MessagesSquare, 'Direct messages', dmUnread)}
            {canManageMembers && item('members', Users, 'Members')}

            <div className="px-3 pt-5 pb-2 text-[10px] font-medium uppercase tracking-widest text-white/30">My views</div>
            {item('mine', UserCog, 'My Tasks', counts.mine)}
            {item('private', Lock, 'Private tasks', counts.private)}
          </>
        )}
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
  const { view, setView, chatUnread, dmUnread, canManageMembers, isGuest } = useApp();
  const [moreOpen, setMoreOpen] = useState(false);

  // 5 thumb-friendly slots: the four most-used destinations + a "More" sheet for the rest. Every
  // destination is reachable (no horizontal scrolling), and Members is included (owner-gated).
  // Guests are scoped to My Tasks + DMs only, so they get a clean 2-tab bar and no "More".
  const primary = isGuest
    ? [
        { id: 'mine', icon: UserCog,        label: 'My Tasks' },
        { id: 'dms',  icon: MessagesSquare, label: 'Direct messages', badge: dmUnread },
      ]
    : [
        { id: 'dashboard', icon: LayoutDashboard, label: 'Home' },
        { id: 'kanban',    icon: KanbanSquare,    label: 'Board' },
        { id: 'mine',      icon: UserCog,         label: 'Tasks' },
        { id: 'chat',      icon: MessageSquare,   label: 'Chat', badge: chatUnread },
      ];
  const more = isGuest ? [] : [
    { id: 'matrix',   icon: Grid3x3,        label: 'Priority Matrix' },
    { id: 'projects', icon: FolderKanban,   label: 'Projects' },
    { id: 'schedule', icon: CalendarDays,   label: 'Schedule' },
    { id: 'private',  icon: Lock,           label: 'Private tasks' },
    { id: 'dms',      icon: MessagesSquare, label: 'Direct messages', badge: dmUnread },
    ...(canManageMembers ? [{ id: 'members', icon: Users, label: 'Members' }] : []),
  ];
  const moreActive = more.some(m => m.id === view);
  const moreBadge = more.reduce((n, m) => n + (m.badge || 0), 0);   // dot on "More" when a hidden item has unread
  const go = (id) => { setView(id); setMoreOpen(false); };

  return (
    <>
      {moreOpen && createPortal(
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="More destinations">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMoreOpen(false)} />
          <div className="absolute bottom-0 left-0 right-0 rounded-t-2xl border-t border-white/10 bg-[#0f1017] pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl" style={{ animation: 'slideUp .18s ease' }}>
            <div className="mx-auto mb-1 h-1 w-9 rounded-full bg-white/15" />
            <div className="px-4 py-2 text-[10px] font-medium uppercase tracking-widest text-white/35">More</div>
            <div className="px-2 pb-1">
              {more.map(it => (
                <button key={it.id} onClick={() => go(it.id)}
                  className={cx('w-full flex items-center gap-3 px-3 h-12 rounded-xl text-left transition-colors',
                    view === it.id ? 'bg-white/[0.08] text-white' : 'text-white/70 hover:bg-white/[0.04]')}>
                  <it.icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-sm font-medium">{it.label}</span>
                  {it.badge > 0 && (
                    <span className="min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-rose-50 text-[9px] font-bold leading-none flex items-center justify-center">{it.badge > 9 ? '9+' : it.badge}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-white/5 bg-[#0a0b11]/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {primary.map(it => (
            <button key={it.id} onClick={() => go(it.id)}
              className={cx('relative flex-1 min-w-0 py-2.5 flex flex-col items-center justify-center gap-0.5 transition-colors',
                view === it.id ? 'text-white' : 'text-white/40')}>
              <it.icon className="w-5 h-5" />
              {it.badge > 0 && (
                <span className="absolute top-1.5 left-1/2 translate-x-2 min-w-[14px] h-3.5 px-1 rounded-full bg-rose-500 text-rose-50 text-[8px] font-bold leading-none flex items-center justify-center">{it.badge > 9 ? '9+' : it.badge}</span>
              )}
              <span className="text-[9px] font-medium tracking-wide">{it.label}</span>
            </button>
          ))}
          {more.length > 0 && (
            <button onClick={() => setMoreOpen(o => !o)} aria-label="More destinations" aria-expanded={moreOpen}
              className={cx('relative flex-1 min-w-0 py-2.5 flex flex-col items-center justify-center gap-0.5 transition-colors',
                moreActive || moreOpen ? 'text-white' : 'text-white/40')}>
              <MoreHorizontal className="w-5 h-5" />
              {moreBadge > 0 && <span className="absolute top-1.5 left-1/2 translate-x-2 w-2 h-2 rounded-full bg-rose-500" />}
              <span className="text-[9px] font-medium tracking-wide">More</span>
            </button>
          )}
        </div>
      </nav>
    </>
  );
}

/* =================================================================================
   TOP BAR
================================================================================= */
/* A single in-app notification toast. Self-dismisses after 5s. Rendered through a
   portal to <body> by NotificationBell so the sticky header's backdrop-filter
   (which establishes a containing block for fixed descendants) cannot clip it. */
// Per-type visual for a notification (icon + accent). Due reminders get their own glanceable icons
// (clock = due soon, alert = overdue); other types keep the generic bell. The hex reads on both dark and
// light (a saturated icon on a subtle, same-hue chip). Deep-linking is unchanged — due_soon/overdue carry
// a task_id, so handleOpen already routes them to openTask.
function notifVisual(type, light) {
  if (type === 'overdue')  return { Icon: AlertCircle, hex: '#f43f5e' };
  if (type === 'due_soon') return { Icon: Clock,       hex: '#fb923c' };
  return { Icon: Bell, hex: light ? '#6d28d9' : '#c4b5fd' };
}

function NotificationToast({ n, light, onOpen, onDismiss }) {
  const { id } = n;
  const tv = notifVisual(n.type, light);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (prefersReducedMotion()) { onDismiss(id); return; }
      setLeaving(true);
      setTimeout(() => onDismiss(id), 180);   // remove after the fade/slide-out
    }, 5000);
    return () => clearTimeout(t);
  }, [id, onDismiss]);
  return (
    <button onClick={() => onOpen(n)}
      className={cx('pointer-events-auto flex items-start gap-2.5 w-full text-left px-3.5 py-3 rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl hover:border-white/20 transition-colors',
        leaving ? 'animate-[fadeSlideOut_.18s_ease_forwards]' : 'animate-[slideUp_.2s_ease]')}>
      <span className="mt-0.5 w-7 h-7 rounded-lg border flex items-center justify-center shrink-0"
        style={{ background: tv.hex + '1f', borderColor: tv.hex + '55' }}>
        <tv.Icon className="w-3.5 h-3.5" style={{ color: tv.hex }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-white/90">{n.title || 'New notification'}</span>
        <span className="block text-xs text-white/60 leading-snug">{n.message}</span>
      </span>
    </button>
  );
}

function NotificationBell() {
  const { session, tasks, setEditingTask, theme, currentWorkspaceId, setView, setDmActiveConv, view, dmActiveConv } = useApp();
  const userId = session?.user?.id;
  const light = theme === 'light';
  // Refs so the realtime subscribe callback (set up once) sees which DM is currently open.
  const viewRef = useRef(view);
  const activeConvRef = useRef(dmActiveConv);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { activeConvRef.current = dmActiveConv; }, [dmActiveConv]);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState([]);
  const [exitingNotifIds, setExitingNotifIds] = useState(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [serverUnread, setServerUnread] = useState(null);   // 5b: accurate unread from the RPC (past the 50-row window)
  const removeToast = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  const localUnread = items.reduce((n, x) => n + (x.read ? 0 : 1), 0);
  // Prefer the server count (correct even when unread > the 50 rows the bell loads); fall back to local.
  const unreadCount = serverUnread != null ? serverUnread : localUnread;

  // Initial load of the current user's notifications (RLS scopes to recipient).
  useEffect(() => {
    if (!userId || !currentWorkspaceId) { setItems([]); setLoading(false); return; }
    let mounted = true;
    // A11: clear the PREVIOUS workspace's notifications on switch — like tasks/projects/members/DMs already
    // do — so they can't survive as merge "extras" and inflate the new workspace's unread badge.
    setItems([]);
    setLoading(true);
    notificationsApi.list(50, currentWorkspaceId)
      .then(list => {
        if (!mounted) return;
        // Merge with any realtime items that arrived during THIS fetch (dedupe by id, newest-first) so a
        // notification streamed in mid-load isn't clobbered — but ONLY current-workspace items, never a
        // stale cross-workspace carryover.
        setItems(prev => {
          if (prev.length === 0) return list;
          const seen = new Set(list.map(x => x.id));
          const extras = prev.filter(x => !seen.has(x.id) && x.workspaceId === currentWorkspaceId);
          return [...extras, ...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        });
      })
      .catch(err => console.error('Failed to load notifications:', err))
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [userId, currentWorkspaceId]);

  // 5b: keep the accurate server unread count fresh — on load, on switch, and after any bell change
  // (new notification, mark-read, clear), debounced so a burst collapses into one count query.
  useEffect(() => {
    if (!userId || !currentWorkspaceId) return undefined;
    const t = setTimeout(() => { notificationsApi.unreadCount(currentWorkspaceId).then(setServerUnread).catch(() => {}); }, 300);
    return () => clearTimeout(t);
  }, [userId, currentWorkspaceId, items]);

  // Realtime: a new notification for this recipient bumps the badge + raises an in-app toast.
  useEffect(() => {
    if (!userId || !currentWorkspaceId) return;
    let mounted = true;
    const unsub = notificationsApi.subscribe(userId, ({ type, notification: n }) => {
      if (!n || !mounted) return;
      if (type === 'DELETE') {   // cleared / deleted on another device -> drop it here too
        setItems(prev => prev.filter(x => x.id !== n.id));
        setToasts(prev => prev.filter(t => t.id !== n.id));
        return;
      }
      if (type === 'UPDATE') {   // marked read / updated elsewhere -> sync (the unread badge recomputes from items)
        setItems(prev => prev.map(x => x.id === n.id ? n : x));
        return;
      }
      // INSERT: suppress the toast for the DM conversation being actively viewed (record it read); else raise it.
      const viewingThisDm = n.type === 'dm_received' && n.refId && n.refId === activeConvRef.current && viewRef.current === 'dms';
      if (viewingThisDm) {
        setItems(prev => prev.some(x => x.id === n.id) ? prev : [{ ...n, read: true }, ...prev]);
        notificationsApi.markRead(n.id).catch(() => {});
        return;
      }
      setItems(prev => prev.some(x => x.id === n.id) ? prev : [n, ...prev]);
      // Newest toast on top; cap the stack so it never runs off-screen. Each toast self-dismisses.
      setToasts(prev => prev.some(t => t.id === n.id) ? prev : [n, ...prev].slice(0, 3));
    }, currentWorkspaceId);
    return () => { mounted = false; unsub(); };
  }, [userId, currentWorkspaceId]);

  // While a DM conversation is the active view, clear any of ITS already-unread notifications so the
  // bell never shows a stale count for the chat the user is reading. Deferred via a timeout so it is
  // not a synchronous setState in the effect body (keeps the update non-cascading).
  useEffect(() => {
    if (view !== 'dms' || !dmActiveConv) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      const stale = items.filter(n => n.type === 'dm_received' && n.refId === dmActiveConv && !n.read);
      if (stale.length === 0) return;
      setItems(prev => prev.map(n => (n.type === 'dm_received' && n.refId === dmActiveConv && !n.read) ? { ...n, read: true } : n));
      setToasts(prev => prev.filter(x => !(x.type === 'dm_received' && x.refId === dmActiveConv)));
      stale.forEach(n => notificationsApi.markRead(n.id).catch(() => {}));
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [view, dmActiveConv, items]);

  // Open the task referenced by a notification — from local state if present,
  // otherwise fetch the single row and map it via fromDbTask (in tasksApi.getById).
  const openTask = useCallback(async (taskId) => {
    if (!taskId) return;
    const local = tasks.find(t => t.id === taskId);
    if (local) { setEditingTask(local); return; }
    try {
      const fetched = await tasksApi.getById(taskId);
      if (fetched) setEditingTask(fetched);
    } catch (err) {
      console.error('Failed to open task from notification:', err);
    }
  }, [tasks, setEditingTask]);

  const handleOpen = (n) => {
    setOpen(false);
    removeToast(n.id);
    if (!n.read) {
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
      notificationsApi.markRead(n.id).catch(err => {
        console.error('markRead failed:', err);
        notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(() => {}); // reconcile with server on failure
      });
    }
    // Deep-link by type: a DM notification opens its thread; everything else (task_assigned /
    // comment_added / task_completed) keeps the existing behavior of opening the referenced task.
    if (n.type === 'dm_received' && n.refId) {
      setDmActiveConv(n.refId);
      setView('dms');
      return;
    }
    if (n.type === 'mention' && !n.taskId) {   // a team-chat mention has no task -> open the channel
      setView('chat');
      return;
    }
    openTask(n.taskId);
  };

  const markAll = async () => {
    if (unreadCount === 0) return;
    setItems(prev => prev.map(x => x.read ? x : { ...x, read: true }));
    try {
      await notificationsApi.markAllRead(currentWorkspaceId);
    } catch (err) {
      console.error('markAllRead failed:', err);
      notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(() => {}); // reconcile with server on failure
    }
  };

  // Two-phase delete: fade/slide the row out (~180ms), then remove + persist. Reduced-motion -> immediate.
  const deleteNotif = (id) => {
    const finish = () => {
      setItems(p => p.filter(x => x.id !== id));
      setExitingNotifIds(p => { const n = new Set(p); n.delete(id); return n; });
      notificationsApi.delete(id).catch(err => {
        console.error('Delete notification failed:', err);
        notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(() => {}); // reconcile with server on failure
      });
    };
    if (prefersReducedMotion()) { finish(); return; }
    setExitingNotifIds(p => new Set(p).add(id));
    setTimeout(finish, 180);
  };

  // Clear all: fade every currently-shown row out together (~180ms), then delete exactly those ids.
  // Scoping to the captured snapshot (not a match-all) means a notification that arrives DURING the fade
  // survives on screen and server — no race that silently destroys an unseen notification.
  const clearAll = () => {
    setConfirmClear(false);
    if (items.length === 0) return;
    const ids = items.map(x => x.id);
    const idSet = new Set(ids);
    const finish = () => {
      setItems(prev => prev.filter(x => !idSet.has(x.id)));   // remove only the snapshot; keep anything that streamed in
      setExitingNotifIds(new Set());
      notificationsApi.clearIds(ids, currentWorkspaceId).catch(err => {
        console.error('Clear all notifications failed:', err);
        notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(() => {}); // reconcile with server on failure
      });
    };
    if (prefersReducedMotion()) { finish(); return; }
    setExitingNotifIds(new Set(ids));
    setTimeout(finish, 180);
  };

  return (
    <>
      <div className="relative">
        <IconButton icon={Bell} label="Notifications" active={open} onClick={() => setOpen(o => !o)} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-rose-50 text-[9px] font-bold leading-none flex items-center justify-center pointer-events-none shadow-[0_0_8px_rgba(244,63,94,0.5)]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-11 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
                <div className="text-xs font-semibold text-white/90">
                  Notifications
                  {unreadCount > 0 && <span className="ml-1.5 text-[10px] font-medium text-white/40">{unreadCount} new</span>}
                </div>
                <div className="flex items-center gap-3">
                  {unreadCount > 0 && (
                    <button onClick={markAll}
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-white/50 hover:text-white/90 transition-colors">
                      <Check className="w-3 h-3" />Mark all read
                    </button>
                  )}
                  {items.length > 0 && (
                    <button onClick={() => setConfirmClear(true)}
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-white/40 hover:text-rose-300 transition-colors">
                      <Trash2 className="w-3 h-3" />Clear all
                    </button>
                  )}
                </div>
              </div>
              <div className="max-h-[70vh] overflow-y-auto no-scrollbar">
                {loading ? (
                  <div className="px-3 py-6 text-center text-[11px] text-white/40">Loading…</div>
                ) : items.length === 0 ? (
                  <div className="px-3 py-8 text-center">
                    <Bell className="w-5 h-5 text-white/20 mx-auto mb-2" />
                    <div className="text-[11px] text-white/40">You're all caught up</div>
                  </div>
                ) : (
                  items.map(n => (
                    <div key={n.id}
                      className={cx('group relative flex items-stretch border-b border-white/5 last:border-b-0 transition-colors hover:bg-white/5',
                        !n.read && 'bg-white/[0.03]',
                        exitingNotifIds.has(n.id) && 'animate-[fadeSlideOut_.18s_ease_forwards]')}>
                      <button onClick={() => handleOpen(n)}
                        className="min-w-0 flex-1 text-left flex items-start gap-2.5 pl-3 pr-1 py-2.5">
                        {(() => { const tv = notifVisual(n.type, light); return (
                          <span className="relative mt-0.5 shrink-0">
                            <tv.Icon className="w-4 h-4" style={{ color: tv.hex }} />
                            {!n.read && <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full" style={{ background: light ? '#7c3aed' : '#a78bfa', boxShadow: `0 0 6px ${light ? 'rgba(124,58,237,0.45)' : 'rgba(167,139,250,0.7)'}` }} />}
                          </span>
                        ); })()}
                        <span className="min-w-0 flex-1">
                          <span className={cx('block text-xs leading-snug', n.read ? 'text-white/55' : 'text-white/90')}>{n.message}</span>
                          <span className="block mt-0.5 text-[10px] text-white/35">{timeAgo(n.createdAt)}</span>
                        </span>
                      </button>
                      <button onClick={() => deleteNotif(n.id)} aria-label="Delete notification"
                        className="shrink-0 px-2.5 flex items-center text-white/30 hover:text-rose-300 focus:text-rose-300 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {toasts.length > 0 && createPortal(
        <div
          className="fixed right-4 z-[100] flex flex-col gap-2 w-72 max-w-[calc(100vw-2rem)] pointer-events-none"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 4.5rem)' }}
        >
          {toasts.map(n => (
            <NotificationToast key={n.id} n={n} light={light} onOpen={handleOpen} onDismiss={removeToast} />
          ))}
        </div>,
        document.body
      )}

      <ConfirmModal
        open={confirmClear}
        title="Clear all notifications?"
        message="This permanently removes all your notifications in this workspace. This can't be undone."
        confirmLabel="Clear all"
        onConfirm={clearAll}
        onClose={() => setConfirmClear(false)}
      />
    </>
  );
}

/** Shared "name your workspace" form. Calls the sanctioned RPC via AppProvider.createWorkspace,
 *  which (on success) re-fetches workspaces + memberships and switches into the new workspace as
 *  its owner. Validates non-empty client-side; surfaces server-side errors (auth / >80 chars). */
function CreateWorkspaceForm({ onCreated, submitLabel = 'Create workspace', autoFocus = true }) {
  const { createWorkspace } = useApp();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const trimmed = name.trim();
  const submit = async (e) => {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true); setError(null);
    try {
      const ws = await createWorkspace(trimmed);
      onCreated?.(ws);
      // On success the workspace switches and this form unmounts; leave busy=true to avoid a flash.
    } catch (err) {
      setError(err?.message || 'Could not create the workspace. Please try again.');
      setBusy(false);
    }
  };
  // The .au-in stage classes only exist while AuthShell's style block is mounted (onboarding);
  // inside CreateWorkspaceModal they match nothing and the form renders statically — same layout.
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="au-in" style={{ animationDelay: '.2s' }}>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus={autoFocus}
          placeholder="e.g. Acme Marketing"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/60 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20 transition-colors" />
      </div>
      {error && <AuthBanner tone="error">{error}</AuthBanner>}
      <div className="au-in" style={{ animationDelay: '.26s' }}>
        <AuthCTA busy={busy} busyLabel="Creating workspace…" disabled={!trimmed || busy}>
          <Plus className="w-4 h-4" />{submitLabel}
        </AuthCTA>
      </div>
    </form>
  );
}

/** Reusable app-styled confirmation modal for destructive actions (same style family as
 *  CreateWorkspaceModal). Renders above other modals (z-[60]); Delete is auto-focused + destructive;
 *  Cancel / backdrop / Esc cancel. Esc is stopped from bubbling so it doesn't also close an underlying modal. */
function ConfirmModal({ open, title, message, confirmLabel = 'Delete', confirmDisabled = false, onConfirm, onClose, icon: Icon = Trash2, tone = 'danger' }) {
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  // Focus the confirm button normally; when it's disabled (e.g. blocked project delete), focus the panel
  // instead so the Esc handler below still receives the key.
  useEffect(() => { if (open) setTimeout(() => (confirmDisabled ? panelRef.current : btnRef.current)?.focus(), 30); }, [open, confirmDisabled]);
  if (!open) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
          className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-5 outline-none"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
          <h2 className="text-base font-semibold text-white mb-1">{title}</h2>
          {message && <p className="text-xs text-white/55 mb-4 break-words">{message}</p>}
          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose}
              className="h-9 px-4 rounded-xl border border-white/10 bg-white/5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors">Cancel</button>
            <button ref={btnRef} onClick={onConfirm} disabled={confirmDisabled}
              className={cx('h-9 px-4 rounded-xl text-white text-xs font-semibold transition-colors inline-flex items-center gap-1.5',
                confirmDisabled ? 'bg-rose-500/40 text-white/60 cursor-not-allowed'
                  : tone === 'danger' ? 'bg-rose-500 hover:bg-rose-400' : 'bg-violet-500 hover:bg-violet-400')}>
              <Icon className="w-3.5 h-3.5" />{confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

/**
 * Project delete modal. Owner+admin only (the trigger button is already gated). When the project has
 * tasks, the caller chooses: "Keep the tasks" (unassign -> re-file to another project) or, OWNER ONLY,
 * "Delete the tasks too" (cascade), which requires typing the project name to confirm (matches the
 * "No bulk-delete without a typed-confirmation modal" landmine). Both routes go through the
 * delete_project RPC, which enforces the rank + workspace + caller-visibility rules server-side.
 * taskCount: null = checking, -1 = error, >=0 = reliable count (from the project_task_count RPC).
 */
function ProjectDeleteModal({ open, project, taskCount, isOwner, onCancel, onConfirm }) {
  const [mode, setMode] = useState('unassign');   // 'unassign' | 'cascade'
  const [confirmText, setConfirmText] = useState('');
  const panelRef = useRef(null);
  useEffect(() => { if (open) setTimeout(() => panelRef.current?.focus(), 30); }, [open]);
  if (!open || !project) return null;

  const checking = taskCount === null;
  const errored = taskCount === -1;
  const count = typeof taskCount === 'number' && taskCount > 0 ? taskCount : 0;
  const reassignTo = project.id === 'other' ? 'personal' : 'other';   // where kept tasks land
  const cascadeReady = mode !== 'cascade' || confirmText.trim() === (project.name || '').trim();
  const canConfirm = !checking && !errored && cascadeReady;
  // reset in the close handlers (not an effect) so a reopened modal starts fresh — cascade must always
  // require re-typing the project name — while staying clear of the react-hooks/set-state-in-effect rule.
  const reset = () => { setMode('unassign'); setConfirmText(''); };
  const handleCancel = () => { reset(); onCancel(); };
  const doConfirm = () => { if (!canConfirm) return; const m = mode, r = reassignTo; reset(); onConfirm(m, r); };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" onClick={handleCancel} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Delete ${project.name}`}
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-5 outline-none"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); handleCancel(); } }}>
          <h2 className="text-base font-semibold text-white mb-1 break-words">Delete “{project.name}”?</h2>

          {checking && <p className="text-xs text-white/55 mb-4">Checking for tasks…</p>}
          {errored && <p className="text-xs text-rose-300 mb-4">Couldn't check this project's tasks. Please try again.</p>}
          {!checking && !errored && count === 0 && (
            <p className="text-xs text-white/55 mb-4">This project has no tasks. It will be permanently deleted.</p>
          )}

          {!checking && !errored && count > 0 && (
            <div className="space-y-2 mb-4">
              <p className="text-xs text-white/55">“{project.name}” has {count} task{count === 1 ? '' : 's'}. Choose what happens to them:</p>
              <label className={cx('flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors',
                mode === 'unassign' ? 'border-violet-400/50 bg-violet-500/10' : 'border-white/10 hover:bg-white/5')}>
                <input type="radio" name="pdmode" checked={mode === 'unassign'} onChange={() => setMode('unassign')} className="mt-0.5" />
                <span className="text-xs text-white/80"><span className="font-medium text-white">Keep the tasks</span> — move them to “{reassignTo}”, then delete the project.</span>
              </label>
              {isOwner && (
                <label className={cx('flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors',
                  mode === 'cascade' ? 'border-rose-400/50 bg-rose-500/10' : 'border-white/10 hover:bg-white/5')}>
                  <input type="radio" name="pdmode" checked={mode === 'cascade'} onChange={() => setMode('cascade')} className="mt-0.5" />
                  <span className="text-xs text-white/80"><span className="font-medium text-rose-200">Delete the tasks too</span> — permanently removes the project and its {count} task{count === 1 ? '' : 's'}. Can't be undone.</span>
                </label>
              )}
              {mode === 'cascade' && (
                <div className="pt-1">
                  <p className="text-[11px] text-white/50 mb-1.5">Type <span className="text-white/80 font-medium">{project.name}</span> to confirm:</p>
                  <input autoFocus value={confirmText} onChange={e => setConfirmText(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white outline-none focus:border-rose-400/50"
                    placeholder={project.name} aria-label="Type the project name to confirm deletion" />
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button onClick={handleCancel}
              className="h-9 px-4 rounded-xl border border-white/10 bg-white/5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors">Cancel</button>
            <button onClick={doConfirm} disabled={!canConfirm}
              className={cx('h-9 px-4 rounded-xl text-white text-xs font-semibold transition-colors inline-flex items-center gap-1.5',
                !canConfirm ? 'bg-white/10 text-white/40 cursor-not-allowed'
                  : mode === 'cascade' ? 'bg-rose-500 hover:bg-rose-400' : 'bg-violet-500 hover:bg-violet-400')}>
              <Trash2 className="w-3.5 h-3.5" />
              {count > 0 && mode === 'cascade' ? `Delete project + ${count} task${count === 1 ? '' : 's'}` : 'Delete project'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

/** In-app "upgrade to unlock X" modal. Opened by AppProvider.requestUpgrade(featureKey); reads the
 *  feature/limit copy from lib/plans.js (FEATURE_META) and routes to /pricing or /checkout. Graceful
 *  by design — every gated action opens this, never a dead end or a silent failure. */
function UpgradeModal() {
  const { upgradeFeature, dismissUpgrade } = useApp();
  const navigate = useNavigate();
  if (!upgradeFeature) return null;
  const meta = FEATURE_META[upgradeFeature] || { label: 'this feature', blurb: '', tier: 'pro' };
  const tier = PLANS[meta.tier] || PLANS.pro;
  const go = (path) => { dismissUpgrade(); navigate(path); };
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" onClick={dismissUpgrade} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-5"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); dismissUpgrade(); } }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shrink-0 shadow-lg shadow-fuchsia-500/25">
              <Sparkles className="w-4 h-4 text-white" />
            </span>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/80">{tier.name} feature</div>
            <button onClick={dismissUpgrade} aria-label="Close" className="ml-auto text-white/40 hover:text-white/80 transition-colors"><X className="w-4 h-4" /></button>
          </div>
          <h2 className="text-base font-semibold text-white mb-1">{meta.isLimit ? meta.label : `Unlock ${meta.label}`}</h2>
          {meta.blurb && <p className="text-xs text-white/55 mb-4 leading-relaxed">{meta.blurb}</p>}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 mb-4 text-[12px] text-white/60">
            Included on <span className="font-semibold text-white/85">{tier.name}</span> and up.
          </div>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => go('/pricing')}
              className="h-9 px-4 rounded-xl border border-white/10 bg-white/5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors">See all plans</button>
            <button onClick={() => go(`/checkout?plan=${tier.id}`)}
              className="h-9 px-4 rounded-xl text-white text-xs font-semibold bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-fuchsia-500/30 transition-all inline-flex items-center gap-1.5">
              Upgrade to {tier.name}<ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

/** Visible, dismissible banner shown only while a ?plan= preview is active (see lib/entitlements.js).
 *  Guarantees a real user can never get silently stuck on a downgraded preview — one click exits. */
function PlanPreviewBanner() {
  const { entitlements } = useApp();
  if (!entitlements.isPreview) return null;
  const exit = () => {
    clearPreviewPlan();
    try { const u = new URL(window.location.href); u.searchParams.delete('plan'); window.location.assign(u.pathname + u.search); }
    catch { window.location.reload(); }
  };
  return (
    <div className="fixed bottom-20 lg:bottom-3 inset-x-0 lg:inset-x-auto lg:right-3 z-[55] flex justify-center lg:justify-end px-3 pointer-events-none">
      <div className="pointer-events-auto inline-flex items-center gap-2 px-3 h-9 rounded-full border border-amber-400/30 bg-amber-500/15 backdrop-blur text-[11px] text-amber-100 shadow-lg">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        Previewing the <span className="font-semibold">{entitlements.plan.name}</span> plan
        <button onClick={exit} className="ml-1 font-semibold text-amber-200 hover:text-white underline underline-offset-2 transition-colors">Exit</button>
      </div>
    </div>
  );
}

/** Create or edit (rename / recolor / re-icon) a project. Create + edit are member-allowed
 *  (projects_insert_member / projects_update_member); persisted via the AppProvider handlers. */
function ProjectModal({ open, onClose, project }) {
  const { createProject, renameProject } = useApp();
  const editing = !!project;
  const [name, setName] = useState('');
  const [color, setColor] = useState(PROJECT_PALETTE[0]);
  const [icon, setIcon] = useState('◇');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(project?.name || '');
    setColor(project?.color || PROJECT_PALETTE[0]);
    setIcon(project?.icon || '◇');
    setErr('');
    setBusy(false);
  }, [open, project]);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setErr('Name is required.'); return; }
    if (trimmed.length > 80) { setErr('Name must be 80 characters or fewer.'); return; }
    setBusy(true); setErr('');
    try {
      if (editing) {
        // Send ONLY the fields that actually changed (not the whole {name,color,icon} object), so a
        // concurrent edit to a field this user didn't touch isn't clobbered by a last-write-wins
        // full-object rewrite — the same minimal-patch discipline the task-field edits already use.
        const iconVal = icon || '◇';
        const patch = {};
        if (trimmed !== (project.name || '')) patch.name = trimmed;
        if (color !== (project.color || PROJECT_PALETTE[0])) patch.color = color;
        if (iconVal !== (project.icon || '◇')) patch.icon = iconVal;
        if (Object.keys(patch).length) await renameProject(project.id, patch);
      }
      else await createProject({ name: trimmed, color, icon: icon || '◇' });
      onClose();
    } catch (e2) {
      setErr(e2?.message || 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <form onSubmit={submit}
          className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-5"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-white">{editing ? 'Edit project' : 'New project'}</h2>
            <button type="button" onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors"><X className="w-4 h-4" /></button>
          </div>

          <label className="block text-[11px] font-medium text-white/50 mb-1">Name</label>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="e.g. Marketing"
            className="w-full h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white/90 outline-none focus:border-white/25 transition-colors mb-4" />

          <div className="flex items-start gap-3 mb-3">
            <div className="flex-1">
              <label className="block text-[11px] font-medium text-white/50 mb-1.5">Color</label>
              <div className="flex flex-wrap gap-1.5">
                {PROJECT_PALETTE.map(c => (
                  <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Use color ${c}`}
                    className={cx('w-6 h-6 rounded-lg transition-transform', color === c ? 'ring-2 ring-white/70 scale-110' : 'hover:scale-105')}
                    style={{ background: c }} />
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-white/50 mb-1.5">Preview</label>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold"
                style={{ background: color + '22', color, border: `1px solid ${color}44` }}>{icon || '◇'}</div>
            </div>
          </div>

          <label className="block text-[11px] font-medium text-white/50 mb-1.5">Icon</label>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {PROJECT_ICONS.map(ic => (
              <button key={ic} type="button" onClick={() => setIcon(ic)}
                className={cx('w-7 h-7 rounded-lg text-sm flex items-center justify-center transition-colors',
                  icon === ic ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10')}>{ic}</button>
            ))}
          </div>

          {err && <p className="text-[11px] text-rose-300 mb-3">{err}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose}
              className="h-9 px-4 rounded-xl border border-white/10 bg-white/5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors">Cancel</button>
            <button type="submit" disabled={busy}
              className={cx('h-9 px-4 rounded-xl text-xs font-semibold text-white transition-colors', busy ? 'bg-violet-500/40 cursor-not-allowed' : 'bg-violet-500 hover:bg-violet-400')}>
              {editing ? 'Save changes' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

/** Modal launched from the WorkspaceSwitcher's "+ Create workspace". */
function CreateWorkspaceModal({ open, onClose }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-5"
          style={{ animation: 'slideUp .2s ease' }} onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-semibold text-white">Create workspace</h2>
            <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors"><X className="w-4 h-4" /></button>
          </div>
          <p className="text-xs text-white/45 mb-4">A fresh space for a team's tasks, projects, and chat. You'll be its owner.</p>
          <CreateWorkspaceForm submitLabel="Create workspace" onCreated={onClose} />
        </div>
      </div>
    </>
  );
}

/** Current-workspace label + switcher. Always offers "+ Create workspace"; becomes a real
 *  dropdown of workspaces once the user belongs to more than one. */
function WorkspaceSwitcher() {
  const { workspaces, currentWorkspaceId, switchWorkspace, pendingInvites, acceptInvitation, requestUpgrade } = useApp();
  const entitlements = useEntitlements();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const current = workspaces.find(w => w.id === currentWorkspaceId);
  if (!current) return null;
  const badgeCls = 'w-4 h-4 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-[8px] font-bold text-white shrink-0';
  const initial = (name) => (name || 'W').slice(0, 1).toUpperCase();
  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen(o => !o)} title="Switch or create workspace"
        className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl border border-white/10 bg-white/[0.03] text-xs hover:bg-white/[0.06] cursor-pointer transition-colors">
        <span className={badgeCls}>{initial(current.name)}</span>
        <span className="font-medium text-white/90 max-w-[90px] sm:max-w-[140px] truncate">{current.name}</span>
        <ChevronDown className="w-3 h-3 text-white/40 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-11 z-40 w-56 rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl py-1.5">
            <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-white/35">Workspaces</div>
            {workspaces.map(w => (
              <button key={w.id} onClick={() => { switchWorkspace(w.id); setOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors">
                <span className={badgeCls}>{initial(w.name)}</span>
                <span className="flex-1 truncate text-left">{w.name}</span>
                {w.id === currentWorkspaceId && <Check className="w-3.5 h-3.5 text-violet-400 shrink-0" />}
              </button>
            ))}
            {pendingInvites.length > 0 && (
              <>
                <div className="my-1 h-px bg-white/10" />
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-white/35">Invitations</div>
                {pendingInvites.map(inv => (
                  <button key={inv.id} onClick={() => { setOpen(false); acceptInvitation(inv.token).catch(err => console.error('accept invite failed:', err)); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors">
                    <span className="w-4 h-4 rounded-md bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center shrink-0"><UserPlus className="w-2.5 h-2.5 text-emerald-300" /></span>
                    <span className="flex-1 text-left truncate">Join {inv.workspaceName}</span>
                  </button>
                ))}
              </>
            )}
            <div className="my-1 h-px bg-white/10" />
            <button onClick={() => { setOpen(false); if (entitlements.atWorkspaceLimit) requestUpgrade('workspaces'); else setCreateOpen(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors">
              <span className="w-4 h-4 rounded-md border border-dashed border-white/30 flex items-center justify-center shrink-0"><Plus className="w-2.5 h-2.5" /></span>
              <span className="flex-1 text-left">Create workspace</span>
            </button>
          </div>
        </>
      )}
      <CreateWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function TopBar() {
  const { theme, setTheme, setPaletteOpen, setQuickAddOpen, filters, setFilters, view, compact, setCompact, exportJSON, importJSON, projects, syncStatus, currentMember, myRole, onSignOut, members, meId, isGuest, membershipsLoaded } = useApp();
  const entitlements = useEntitlements();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
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

        <WorkspaceSwitcher />

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
            <AssigneeSelect variant="filter" label="Assignee" value={filters.assignee} options={[['all','All'], ...(meId ? [['me','Me']] : []), ...members.filter(m => m.userId !== meId).map(m => [m.userId, m.displayName || m.email]), ['unassigned','Unassigned']]} onChange={v => setFilters(f => ({ ...f, assignee: v }))} />
            <FilterPill label="Visibility" value={filters.privacy} options={[['all','All'],['workspace','Shared'],['private','Private']]} onChange={v => setFilters(f => ({ ...f, privacy: v }))} />
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
          <IconButton icon={Command} label={`Command palette (${shortcutLabel('K')})`} onClick={() => setPaletteOpen(true)} />
          <button onClick={() => setQuickAddOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-white text-black text-xs font-semibold hover:bg-white/90 transition-colors">
            <Plus className="w-3.5 h-3.5" />New<kbd className="hidden sm:inline text-[9px] text-black/50 bg-black/10 rounded px-1 py-0.5">N</kbd>
          </button>
          <NotificationBell />
          <div className="relative">
            <IconButton icon={Settings} label="Settings" onClick={() => setMenuOpen(o => !o)} />
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl py-1.5">
                  {currentMember && (
                    <div className="px-3 py-2.5 border-b border-white/5">
                      <div className="text-xs font-medium text-white/90 truncate">{currentMember.email}</div>
                      <div className="text-[10px] text-white/40 mt-0.5 capitalize">{myRole || currentMember.role} · <span className="text-violet-300/80 normal-case">{entitlements.plan.name}</span></div>
                    </div>
                  )}
                  <MenuItem icon={theme === 'dark' ? Sun : Moon} onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); setMenuOpen(false); }}>Switch to {theme === 'dark' ? 'light' : 'dark'}</MenuItem>
                  <MenuItem icon={Download} onClick={() => { exportJSON(); setMenuOpen(false); }}>Export JSON</MenuItem>
                  {/* Import is free on every plan (plans.js FEATURE_TABLE: type 'always'), so the old
                      entitlements.can('bulkImport') gate here was DEAD CODE — every plan sets it true, so
                      the requestUpgrade branch was unreachable. Replaced with the gate that is actually
                      real: guests must not bulk-import. Guests are bounced to /my-tasks, but TopBar renders
                      on that route too, so GUEST_VIEWS did not cover this. The DB is the authority
                      (tasks_insert_role + enforce_guest_task_pin, migration 20260715…); this is the UI half. */}
                  {membershipsLoaded && !isGuest && (
                    <MenuItem icon={Upload} onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>Import JSON</MenuItem>
                  )}
                  <div className="h-px bg-white/5 my-1" />
                  <MenuItem icon={Sparkles} onClick={() => { setMenuOpen(false); navigate('/pricing'); }}>Plans &amp; pricing</MenuItem>
                  <MenuItem icon={FileText} onClick={() => { setMenuOpen(false); navigate('/terms'); }}>Terms of Service</MenuItem>
                  <MenuItem icon={Shield} onClick={() => { setMenuOpen(false); navigate('/privacy'); }}>Privacy Policy</MenuItem>
                  <MenuItem icon={User} onClick={() => { setProfileOpen(true); setMenuOpen(false); }}>Edit profile</MenuItem>
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
    {profileOpen && <ProfileModal onClose={() => setProfileOpen(false)} />}
    </>
  );
}

/**
 * Self-profile editor: display name, status (emoji + text), bio, and avatar upload. Conditionally mounted
 * (so useState initializers prefill from the freshly-loaded currentMember — no set-state-in-effect). Writes
 * via membersApi.updateProfile; the server validates (role-title impersonation, length, storage-hosted
 * avatar) so a rejection surfaces inline. Avatar uploads to the caller's own folder in the public avatars
 * bucket and stores the resulting public URL. refreshCurrentMember() re-syncs the top bar after saving.
 */
/** Status emojis offered by the profile picker. Every entry is verified against the server's emoji-only
 *  rule (members_validate_profile: no letters/digits, no letter-like symbols — checked live, 32/32 accept),
 *  and the picker is the ONLY way to set status_emoji, so the client can never submit a value the DB rejects. */
const STATUS_EMOJIS = ['🟢','🟡','🔴','🔵','⚪','🔥','☕','🎯','✅','🚀','💡','📌','🛠️','💻','📞','🎧',
  '🧠','⏳','🌴','🏖️','🤒','🚗','🍕','🌙','⚡','✨','🎉','👀','💬','📚','🏃','😴'];

function ProfileModal({ onClose }) {
  const { currentMember, refreshCurrentMember } = useApp();
  const [displayName, setDisplayName] = useState(() => currentMember?.display_name || '');
  const [statusText, setStatusText] = useState(() => currentMember?.status_text || '');
  const [statusEmoji, setStatusEmoji] = useState(() => currentMember?.status_emoji || '');
  const [bio, setBio] = useState(() => currentMember?.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(() => currentMember?.avatar_url || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => { setTimeout(() => panelRef.current?.focus(), 30); }, []);

  const pickAvatar = async (file) => {
    if (!file) return;
    setErr(''); setBusy(true);
    try { setAvatarUrl(await membersApi.uploadAvatar(file)); }
    catch (e) { setErr(e?.message || 'Avatar upload failed.'); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await membersApi.updateProfile({ displayName, statusText, statusEmoji, bio, avatarUrl });
      await refreshCurrentMember?.();
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not save your profile.');
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Edit profile"
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1017] shadow-2xl p-5 outline-none max-h-[85vh] overflow-y-auto"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
          <h2 className="text-base font-semibold text-white mb-4">Edit profile</h2>

          <div className="flex items-center gap-3 mb-4">
            <Avatar name={displayName || currentMember?.email} userId={currentMember?.id} photoUrl={avatarUrl} size={56} />
            <div className="flex flex-col gap-1.5">
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="h-8 px-3 rounded-lg bg-white/5 border border-white/10 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors disabled:opacity-50">
                {busy ? 'Working…' : 'Upload photo'}
              </button>
              {avatarUrl && <button onClick={() => setAvatarUrl(null)} className="text-[11px] text-white/40 hover:text-rose-300 text-left">Remove photo</button>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; pickAvatar(f); }} />
            </div>
          </div>

          <label className="block text-[11px] text-white/50 mb-1">Display name</label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={60}
            className="w-full h-9 px-3 mb-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white outline-none focus:border-violet-400/50" />

          <label className="block text-[11px] text-white/50 mb-1">Status</label>
          <div className="flex gap-2 mb-2">
            <button type="button" onClick={() => setEmojiOpen(o => !o)} aria-expanded={emojiOpen} aria-label="Pick a status emoji"
              className={cx('w-14 h-9 rounded-xl border flex items-center justify-center text-base transition-colors',
                emojiOpen ? 'border-violet-400/50 bg-violet-500/10' : 'border-white/10 bg-white/5 hover:bg-white/10')}>
              {statusEmoji || <Plus className="w-3.5 h-3.5 text-white/40" />}
            </button>
            <input value={statusText} onChange={e => setStatusText(e.target.value)} maxLength={80} placeholder="What are you up to?" aria-label="Status text"
              className="flex-1 h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white outline-none focus:border-violet-400/50" />
          </div>
          {/* An INLINE grid, not a floating popover: the modal panel is overflow-y-auto, which would clip an
              absolutely-positioned one. Picking is the only input path — the server accepts emoji only, so a
              free-text field was never a valid way to set this. */}
          {emojiOpen && (
            <div className="mb-3 p-2 rounded-xl border border-white/10 bg-black/30">
              <div className="grid grid-cols-8 gap-1">
                {STATUS_EMOJIS.map(em => (
                  <button key={em} type="button" onClick={() => { setStatusEmoji(em); setEmojiOpen(false); }} aria-label={`Status emoji ${em}`}
                    className={cx('h-8 rounded-lg text-base hover:bg-white/10 transition-colors',
                      statusEmoji === em && 'bg-violet-500/20 ring-1 ring-violet-400/50')}>{em}</button>
                ))}
              </div>
              {statusEmoji && (
                <button type="button" onClick={() => { setStatusEmoji(''); setEmojiOpen(false); }}
                  className="mt-1.5 w-full h-7 rounded-lg text-[11px] text-white/50 hover:text-rose-300 hover:bg-white/5 transition-colors">Clear emoji</button>
              )}
            </div>
          )}

          <label className="block text-[11px] text-white/50 mb-1">Bio</label>
          <textarea value={bio} onChange={e => setBio(e.target.value)} maxLength={280} rows={3}
            className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white outline-none focus:border-violet-400/50 resize-none" />
          <div className="text-[10px] text-white/30 text-right mb-3">{bio.length}/280</div>

          {err && <p className="text-xs text-rose-300 mb-3 break-words">{err}</p>}

          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose}
              className="h-9 px-4 rounded-xl border border-white/10 bg-white/5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors">Cancel</button>
            <button onClick={save} disabled={busy}
              className="h-9 px-4 rounded-xl bg-violet-500 hover:bg-violet-400 text-white text-xs font-semibold transition-colors disabled:opacity-50">Save</button>
          </div>
        </div>
      </div>
    </>,
    document.body
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
  const { tasks, setEditingTask, setView, meId, workspaceStats } = useApp();

  // First run: an empty workspace gets a welcome + a clear "create your first task" path, not a wall
  // of empty cards. (The witty empty states below are kept for steady-state — a bucket clear because
  // you're on top of things, never genuinely-new-and-empty.)
  if (tasks.length === 0) {
    return (
      <div className="space-y-6">
        <ViewHeader title="Dashboard" subtitle="Your team's command center — tasks, priorities, and messages in one place." accent={new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric'})} />
        <FirstRunPanel />
      </div>
    );
  }

  const open = tasks.filter(t => t.status !== 'done');
  const ranked = [...open].map(t => ({ t, s: getNextBestScore(t) })).sort((a,b) => b.s - a.s);
  const top3 = ranked.slice(0, 3);
  const myUpcoming = open.filter(t => t.assigneeId === meId && t.dueDate).sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate)).slice(0, 5);
  const othersUpcoming = open.filter(t => t.assigneeId && t.assigneeId !== meId && t.dueDate).sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate)).slice(0, 5);
  const unassignedPriority = open.filter(t => !t.assigneeId).sort((a,b) => PRIORITIES[b.priority].rank - PRIORITIES[a.priority].rank).slice(0, 4);
  const overdue = open.filter(isOverdue).sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));
  const stuck = open.filter(t => t.blocked || t.status === 'waiting').slice(0, 5);
  const recent = [...tasks].sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5);

  const counts = {
    mine: open.filter(t => t.assigneeId === meId).length,
    others: open.filter(t => t.assigneeId && t.assigneeId !== meId).length,
    unassigned: open.filter(t => !t.assigneeId).length,
    critical: open.filter(t => t.priority === 'critical').length,
    high: open.filter(t => t.priority === 'high').length,
    medium: open.filter(t => t.priority === 'medium').length,
    low: open.filter(t => t.priority === 'low').length,
    doneToday: tasks.filter(t => t.status === 'done' && t.completedAt && daysBetween(new Date(), t.completedAt) === 0).length,
    doneWeek: tasks.filter(t => t.status === 'done' && t.completedAt && daysBetween(new Date(), t.completedAt) >= -6).length,
  };

  // 5b: overall completion from the server aggregate (correct even once the task list is paginated);
  // fall back to the in-memory array while the stats are still loading.
  const progress = (workspaceStats && workspaceStats.total)
    ? Math.round((workspaceStats.done / workspaceStats.total) * 100)
    : (tasks.length ? Math.round((tasks.filter(t => t.status === 'done').length / tasks.length) * 100) : 0);

  return (
    <div className="space-y-6">
      <ViewHeader title="Dashboard" subtitle="Today's ranked priorities, flagged blockers, and where your energy should go." accent={new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric'})} />

      <Card title="Top 3 priorities right now" subtitle="Auto-ranked by priority, due date, urgency, and blockers." accent="#a78bfa">
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
        <StatCard label="My tasks" value={counts.mine} color="#a78bfa" icon={<span className="w-2 h-2 rounded-full" style={{background:'#a78bfa'}} />} onClick={() => setView('mine')} />
        <StatCard label="Assigned to others" value={counts.others} color="#34d399" icon={<span className="w-2 h-2 rounded-full" style={{background:'#34d399'}} />} onClick={() => setView('kanban')} />
        <StatCard label="Unassigned" value={counts.unassigned} color={UNASSIGNED_STYLE.hex} icon={<span className="w-2 h-2 rounded-full" style={{background:UNASSIGNED_STYLE.hex}} />} onClick={() => setView('kanban')} />
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
        <Card title="My upcoming" subtitle="Tasks assigned to you, by due date" accent="#a78bfa" action={<button onClick={() => setView('mine')} className="text-[11px] text-white/40 hover:text-white/80 inline-flex items-center gap-0.5">See all <ChevronRight className="w-3 h-3" /></button>}>
          {myUpcoming.length === 0 ? <EmptyState icon={Calendar} text="No upcoming tasks. Nothing on your plate." /> :
            <div className="space-y-2">{myUpcoming.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
        <Card title="Assigned to others" subtitle="What your teammates are working on" accent="#34d399" action={<button onClick={() => setView('kanban')} className="text-[11px] text-white/40 hover:text-white/80 inline-flex items-center gap-0.5">See all <ChevronRight className="w-3 h-3" /></button>}>
          {othersUpcoming.length === 0 ? <EmptyState icon={UserCog} text="Nothing assigned to others." /> :
            <div className="space-y-2">{othersUpcoming.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Unassigned tasks" subtitle="Pick these up or assign them out" accent={UNASSIGNED_STYLE.hex}>
          {unassignedPriority.length === 0 ? <EmptyState icon={Sparkles} text="Nothing unassigned. Everything's assigned." /> :
            <div className="space-y-2">{unassignedPriority.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
        <Card title="Overdue" subtitle={overdue.length ? "Needs attention" : "All clear"} accent="#f43f5e">
          {overdue.length === 0 ? <EmptyState icon={CheckCircle2} text="Nothing overdue. Keep it up." /> :
            <div className="space-y-2">{overdue.slice(0, 5).map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Stuck tasks" subtitle="Blocked or waiting" accent="#fb923c">
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
      <AssigneeChip assigneeId={task.assigneeId} showLabel={false} />
    </button>
  );
}
function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center mb-2">
        <Icon className="w-4 h-4 text-white/40" />
      </div>
      {title && <div className="text-sm font-medium text-white/80 mb-0.5">{title}</div>}
      <div className="text-xs text-white/40">{text}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* First-run welcome — shown on the Dashboard and the Board when the workspace has zero tasks, so a
   brand-new user gets one obvious action (create a task) instead of a wall of empty cards. The
   starter hints are lightweight + dismissible (persisted), never a blocking wizard. */
function FirstRunPanel() {
  const { setQuickAddOpen, setView, canManageMembers } = useApp();
  const [hintsOff, setHintsOff] = useState(() => themeStore.get(FIRST_RUN_HINTS_KEY) === '1');
  const dismissHints = () => { themeStore.set(FIRST_RUN_HINTS_KEY, '1'); setHintsOff(true); };
  const hints = [
    canManageMembers && { icon: Users, label: 'Invite a teammate', desc: 'Share this workspace with your team.', cta: 'Open Members', go: () => setView('members') },
    { icon: KanbanSquare, label: 'Explore your views', desc: 'Board, Priority Matrix, and Schedule.', cta: 'Open the board', go: () => setView('kanban') },
    { icon: MessageSquare, label: 'Start a conversation', desc: 'Team chat and direct messages.', cta: 'Open chat', go: () => setView('chat') },
  ].filter(Boolean);
  return (
    <div className="relative rounded-3xl border border-white/[0.07] bg-gradient-to-br from-violet-500/[0.10] via-fuchsia-500/[0.05] to-transparent p-6 sm:p-8 overflow-hidden">
      <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" />
      <div className="relative max-w-xl">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-lg shadow-fuchsia-500/25 mb-4">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <h2 className="text-2xl font-semibold text-white font-display tracking-tight">Welcome to Command Center</h2>
        <p className="mt-2 text-sm text-white/60 leading-relaxed">
          One shared place for who’s doing what — tasks, a board, and your schedule, plus team chat and
          direct messages. Start by adding your first task.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={() => setQuickAddOpen(true)}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 transition-colors">
            <Plus className="w-4 h-4" />Create your first task
          </button>
          <span className="text-[11px] text-white/35">or press <kbd className="px-1.5 py-0.5 rounded bg-white/10 border border-white/10 font-medium text-white/55">N</kbd></span>
        </div>

        {!hintsOff && (
          <div className="mt-7">
            <div className="flex items-center justify-between mb-2.5">
              <div className="text-[10px] font-medium uppercase tracking-widest text-white/35">A few things to try</div>
              <button onClick={dismissHints} className="text-[11px] text-white/35 hover:text-white/70 transition-colors">Dismiss</button>
            </div>
            <div className="grid sm:grid-cols-3 gap-2.5">
              {hints.map(h => (
                <button key={h.label} onClick={h.go}
                  className="text-left rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3.5 hover:bg-white/[0.05] hover:border-white/15 transition-colors group">
                  <h.icon className="w-4 h-4 text-violet-300 mb-2" />
                  <div className="text-[13px] font-medium text-white/85">{h.label}</div>
                  <div className="text-[11px] text-white/45 mt-0.5 leading-snug">{h.desc}</div>
                  <div className="mt-2 text-[11px] font-medium text-violet-300/80 inline-flex items-center gap-0.5 group-hover:text-violet-200">{h.cta}<ChevronRight className="w-3 h-3" /></div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* =================================================================================
   KANBAN
================================================================================= */
function KanbanView() {
  const { tasks, filters, meId } = useApp();

  const filtered = useMemo(() => {
    const term = (filters.search || '').toLowerCase();
    return tasks.filter(t => {
      if (!matchesAssignee(t, filters.assignee, meId)) return false;
      if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
      if (filters.project !== 'all' && t.project !== filters.project) return false;
      if (term) {
        const hay = ((t.title || '') + ' ' + (t.description || '')).toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [tasks, filters, meId]);

  const byStatus = useMemo(() => {
    const g = {};
    Object.keys(STATUSES).forEach(s => { g[s] = []; });
    filtered.forEach(t => { (g[t.status] = g[t.status] || []).push(t); });
    Object.keys(g).forEach(k => g[k].sort((a,b) => PRIORITIES[b.priority].rank - PRIORITIES[a.priority].rank));
    return g;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <ViewHeader title="Kanban board" subtitle="Drag between columns. Priority color on the left, assignee chip on the right." />
      {tasks.length === 0 ? (
        <FirstRunPanel />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4 -mx-4 lg:-mx-6 px-4 lg:px-6 snap-x">
          {Object.values(STATUSES).filter(col => col.id !== 'scheduled').map(col => (
            <KanbanColumn key={col.id} column={col} tasks={byStatus[col.id] || []} />
          ))}
        </div>
      )}
    </div>
  );
}

function ColumnQuickAdd({ status }) {
  const { startDraftTask, filters, meId } = useApp();
  // "+ Add task" creates a row (status pre-set to this column, defaults from the active filters) and opens
  // the full TaskModal on it; an abandoned empty draft is auto-removed on close (AppProvider.closeEditing).
  const add = () => startDraftTask({
    status,
    assigneeId: filters.assignee === 'me' ? meId : (filters.assignee === 'unassigned' ? null : (filters.assignee !== 'all' ? filters.assignee : meId)),
    project: filters.project !== 'all' ? filters.project : 'other',
    privacy: filters.privacy !== 'all' ? filters.privacy : 'workspace',
  });
  return (
    <button onClick={add} type="button"
      className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-white/40 hover:text-white/90 hover:bg-white/[0.04] border border-dashed border-white/10 hover:border-white/20 rounded-lg transition-colors">
      <Plus className="w-3 h-3" /> Add task
    </button>
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
      className={cx('flex-1 min-w-[220px] snap-start rounded-2xl border transition-all duration-200',
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
  const { tasks, setEditingTask, setQuickAddOpen } = useApp();
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
              <Lock className="w-3 h-3" />Private · you + assignee
            </div>
            <h1 className="text-3xl lg:text-4xl font-semibold text-white font-display tracking-tight" style={{letterSpacing:'-0.02em'}}>Private tasks</h1>
            <p className="text-sm text-white/50 mt-2 max-w-md">Private tasks are visible only to you and anyone they're assigned to, never the whole workspace.</p>
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
   MY TASKS
================================================================================= */
function MyTasksView() {
  const { tasks, setEditingTask, setQuickAddOpen, meId } = useApp();
  const myTasks = tasks.filter(t => t.assigneeId === meId);
  const byStatus = {
    active:   myTasks.filter(t => ['must','should','inbox'].includes(t.status)),
    waiting:  myTasks.filter(t => t.status === 'waiting' || t.blocked),
    scheduled: myTasks.filter(t => t.status === 'scheduled'),
    done:     myTasks.filter(t => t.status === 'done'),
  };
  const overdue = myTasks.filter(isOverdue);

  return (
    <div className="space-y-6">
      <div className="relative rounded-3xl border border-white/5 bg-gradient-to-br from-[#0d2a20] via-[#0c1a18] to-[#0a0b11] p-6 overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 h-6 text-[10px] font-medium uppercase tracking-widest text-emerald-300 mb-3">
              <UserCog className="w-3 h-3" />Assigned to me
            </div>
            <h1 className="text-3xl lg:text-4xl font-semibold text-white font-display tracking-tight">My Tasks</h1>
            <p className="text-sm text-white/50 mt-2">Everything assigned to you. Prioritize and get it done.</p>
          </div>
          <button onClick={() => setQuickAddOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-emerald-500 text-black text-xs font-semibold hover:bg-emerald-400">
            <Plus className="w-3.5 h-3.5" />Add task
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
        <Card title="Overdue" accent="#f43f5e">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {overdue.map(t => <TaskCard key={t.id} task={t} onClick={() => setEditingTask(t)} />)}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Active" subtitle={`${byStatus.active.length} in motion`} accent="#34d399">
          {byStatus.active.length === 0 ? <EmptyState icon={Inbox} text="No active tasks. Add one." /> :
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
  const { tasks, filters, meId } = useApp();

  const open = useMemo(() => tasks.filter(t => {
    if (t.status === 'done') return false;
    if (!matchesAssignee(t, filters.assignee, meId)) return false;
    if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
    if (filters.project !== 'all' && t.project !== filters.project) return false;
    return true;
  }), [tasks, filters, meId]);

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
          <MatrixQuad id="q4" title="Eliminate" subtitle="Consider dropping" tasks={quadrants.q4} accent="#64748b" />
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
  const { tasks, projects, setEditingTask, filters, meId, isOwner, isAdmin, isMember, membershipsLoaded, currentWorkspaceId, deleteProject, exitingProjectIds } = useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteCount, setDeleteCount] = useState(null); // null = checking, -1 = error, >=0 = count

  // On a delete request, fetch the reliable (owner/admin-gated, RLS-blind-spot-free) task count.
  // deleteCount is reset to null by the open/close handlers (not here), to avoid sync setState in an effect.
  useEffect(() => {
    if (!deleteTarget) return;
    let alive = true;
    projectsApi.taskCount(deleteTarget.id, currentWorkspaceId)
      .then(n => { if (alive) setDeleteCount(typeof n === 'number' ? n : 0); })
      .catch(err => { console.error('project taskCount failed:', err); if (alive) setDeleteCount(-1); });
    return () => { alive = false; };
  }, [deleteTarget, currentWorkspaceId]);

  const canManage = membershipsLoaded && (isOwner || isAdmin || isMember);   // RLS: create/rename = rank>=1 (member/admin/owner)

  const filtered = useMemo(() => tasks.filter(t => {
    if (!matchesAssignee(t, filters.assignee, meId)) return false;
    if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
    return true;
  }), [tasks, filters.assignee, filters.privacy, meId]);

  // Bucket the filtered tasks by project id ONCE (O(n)) instead of re-scanning the whole list inside
  // every project card (O(projects x tasks) — 150k comparisons/render at 30 projects x 5,000 tasks).
  const tasksByProject = useMemo(() => {
    const m = new Map();
    for (const t of filtered) { const a = m.get(t.project); if (a) a.push(t); else m.set(t.project, [t]); }
    return m;
  }, [filtered]);

  return (
    <div className="space-y-6">
      <ViewHeader title="Projects" subtitle="Work grouped by where it lives." />
      <div className="flex items-center justify-between -mt-2">
        <div className="text-[11px] text-white/40">{projects.length} project{projects.length === 1 ? '' : 's'}</div>
        {canManage && (
          <button onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-white/5 border border-white/10 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors">
            <Plus className="w-3.5 h-3.5" /> New project
          </button>
        )}
      </div>
      {projects.length === 0 && (
        <Card>
          <EmptyState icon={FolderKanban} title="No projects yet"
            text="Projects group your tasks by where they live — a client, an area, a workstream."
            action={canManage ? (
              <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-white text-black text-xs font-semibold hover:bg-white/90 transition-colors">
                <Plus className="w-3.5 h-3.5" />New project
              </button>
            ) : null} />
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.map(p => {
          const pTasks = tasksByProject.get(p.id) || [];
          const open = pTasks.filter(t => t.status !== 'done');
          const done = pTasks.filter(t => t.status === 'done');
          const pct = pTasks.length ? Math.round((done.length / pTasks.length) * 100) : 0;
          return (
            <section key={p.id} className={cx('group relative rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.03] to-transparent p-5 overflow-hidden',
              exitingProjectIds.has(p.id) && 'animate-[fadeSlideOut_.18s_ease_forwards]')}>
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
                  {canManage && (
                    <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button onClick={() => setEditTarget(p)} aria-label={`Edit ${p.name}`}
                        className="p-1.5 rounded-lg text-white/30 hover:text-white/80 hover:bg-white/5 transition-colors">
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      {(isOwner || isAdmin) && (
                        <button onClick={() => { setDeleteCount(null); setDeleteTarget(p); }} aria-label={`Delete ${p.name}`}
                          className="p-1.5 rounded-lg text-white/30 hover:text-rose-300 hover:bg-white/5 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
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

      <ProjectModal open={createOpen} onClose={() => setCreateOpen(false)} project={null} />
      <ProjectModal open={!!editTarget} onClose={() => setEditTarget(null)} project={editTarget} />
      <ProjectDeleteModal
        open={!!deleteTarget}
        project={deleteTarget}
        taskCount={deleteCount}
        isOwner={isOwner}
        onCancel={() => { setDeleteTarget(null); setDeleteCount(null); }}
        onConfirm={(mode, reassignTo) => { if (!deleteTarget) return; const id = deleteTarget.id; setDeleteTarget(null); setDeleteCount(null); deleteProject(id, mode, reassignTo); }}
      />
    </div>
  );
}

/* =================================================================================
   SCHEDULE
================================================================================= */
function ScheduleView() {
  const { tasks, setEditingTask, filters, meId } = useApp();

  const filtered = tasks.filter(t => {
    if (t.status === 'done') return false;
    if (!matchesAssignee(t, filters.assignee, meId)) return false;
    if (filters.privacy !== 'all' && t.privacy !== filters.privacy) return false;
    if (filters.project !== 'all' && t.project !== filters.project) return false;
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
                  <div className="h-full flex items-center text-[11px] text-white/25 italic">Nothing scheduled</div>
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
        <Card title="Undated" subtitle="No due or scheduled date. Consider planning these in">
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
export default function App({ session, currentMember, onSignOut, refreshCurrentMember }) {
  return (
    <AppProvider session={session} currentMember={currentMember} onSignOut={onSignOut} refreshCurrentMember={refreshCurrentMember}>
      <AppShell />
    </AppProvider>
  );
}

/* =================================================================================
   TEAM CHAT
================================================================================= */
const fmtDur = (s) => { s = Number(s); if (!isFinite(s) || s < 0) s = 0; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// Playback source for a voice note the CURRENT tab just recorded, keyed by its storage path. Lets the
// sender play their own note straight from the blob they still hold instead of re-downloading it
// (a signed-URL call + an audio fetch). Sender-only and tab-local; everyone else takes the signed URL.
const localAudioUrls = new Map();
const rememberLocalAudio = (path, url) => { if (path && url) localAudioUrls.set(path, url); };

const WAVEFORM_BARS = 32;
// Deterministic bar heights for the waveform. These are a VISUAL APPROXIMATION, not real amplitudes:
// real peaks would mean decoding every note (AudioContext) or a new peaks column, and at 32 bars the
// difference isn't perceivable. Seeding off the message id keeps a given note's shape stable across
// re-renders and identical for both participants, which is what makes it read as "the note's shape".
const waveformPeaks = (seed) => {
  let h = hashStr(String(seed || 'voice')) || 1;
  const out = [];
  for (let i = 0; i < WAVEFORM_BARS; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const r = (h % 1000) / 1000;
    // Taper the ends so it reads like speech rather than a noise block.
    const envelope = 0.62 + 0.38 * Math.sin((i / (WAVEFORM_BARS - 1)) * Math.PI);
    out.push(Math.max(0.16, Math.min(1, (0.3 + r * 0.7) * envelope)));
  }
  return out;
};

/** Build the subtle "X is typing… / recording…" line from presence state. */
const presenceLabel = (others) => {
  if (!others || !others.length) return '';
  const rec = others.filter(o => o.recording).map(o => o.name);
  const typ = others.filter(o => o.typing && !o.recording).map(o => o.name);
  const parts = [];
  if (rec.length) parts.push(`${rec.join(', ')} ${rec.length > 1 ? 'are' : 'is'} recording…`);
  if (typ.length) parts.push(`${typ.join(', ')} ${typ.length > 1 ? 'are' : 'is'} typing…`);
  return parts.join('   ·   ');
};

const pickAudioMime = () => {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const m of ['audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
};

// The <audio> element currently playing, so starting one note pauses any other (WhatsApp-style —
// without this, tapping play on a second note leaves both talking over each other).
let nowPlayingAudio = null;

// Custom, theme-aware voice-note player: play/pause, seekable waveform, elapsed / total.
// Colors are INLINE rather than Tailwind classes on purpose — light mode here is retrofitted via
// `[data-theme="light"]` rules that live inside per-view <style> blocks, so a class-based fill only
// gets themed while the view that declares the rule is mounted (which is why the old bar washed out
// in a cold-loaded DM). Inline styles read `theme` straight from context and are correct everywhere.
function AudioPlayer({ url, duration, seed, pending }) {
  const { theme } = useApp();
  const light = theme === 'light';
  const audioRef = useRef(null);
  const barRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(() => (isFinite(duration) && duration > 0 ? duration : 0));
  const [failed, setFailed] = useState(false);
  const peaks = useMemo(() => waveformPeaks(seed), [seed]);

  useEffect(() => () => { if (nowPlayingAudio === audioRef.current) nowPlayingAudio = null; }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      if (nowPlayingAudio && nowPlayingAudio !== a) nowPlayingAudio.pause();
      nowPlayingAudio = a;
      a.play().catch(() => setPlaying(false));  // onPlay/onPause keep state in sync
    } else a.pause();
  };
  const seekTo = (ratio) => {
    const a = audioRef.current;
    if (!a || !total) return;
    a.currentTime = Math.min(1, Math.max(0, ratio)) * total;
    setCurrent(a.currentTime);
  };
  const onBarClick = (e) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  };
  const onBarKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo((current - 5) / (total || 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo((current + 5) / (total || 1)); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(1); }
  };
  const ratio = total ? Math.min(1, current / total) : 0;

  if (failed) return <div className="mt-1 text-[11px] text-rose-300/70">Voice note unavailable</div>;

  const playedHex = light ? '#7c3aed' : '#a78bfa';
  const unplayedHex = light ? 'rgba(15,17,23,0.24)' : 'rgba(255,255,255,0.24)';

  return (
    // No nested border/background: the bubble already provides one, and boxing the player inside it
    // was the "ugly" part. The waveform sits directly on the bubble, like WhatsApp.
    <div className={cx('mt-1 flex items-center gap-2.5 w-[240px] max-w-full', pending && 'opacity-60')}>
      <audio ref={audioRef} src={url} preload="metadata"
        onLoadedMetadata={e => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setTotal(d); }}
        onTimeUpdate={e => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onError={() => setFailed(true)} />
      <button onClick={toggle} disabled={pending} aria-label={playing ? 'Pause' : 'Play'}
        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors disabled:cursor-default"
        style={{ background: light ? 'rgba(124,58,237,0.14)' : 'rgba(139,92,246,0.25)', border: `1px solid ${playedHex}4d`, color: playedHex }}>
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 translate-x-px" />}
      </button>
      <div ref={barRef} onClick={onBarClick} onKeyDown={onBarKey} role="slider" tabIndex={pending ? -1 : 0}
        aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(current)}
        className="flex-1 h-7 flex items-center gap-[2px] cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-violet-400/40">
        {peaks.map((p, i) => (
          <span key={i} aria-hidden="true"
            className="flex-1 rounded-full transition-colors duration-75"
            style={{ height: `${Math.round(p * 100)}%`, minWidth: 2, background: (i / WAVEFORM_BARS) < ratio ? playedHex : unplayedHex }} />
        ))}
      </div>
      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: light ? 'rgba(15,17,23,0.5)' : 'rgba(255,255,255,0.45)' }}>
        {fmtDur(playing || current ? current : total)}
      </span>
    </div>
  );
}

function VoiceNote({ path, localUrl, duration, pending }) {
  // A note this tab just recorded already has its audio in memory, so it plays with no network at
  // all. Everyone else (and this tab after a reload) falls back to a signed URL.
  const [url, setUrl] = useState(() => localUrl || localAudioUrls.get(path) || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (url || !path) return;
    let on = true;
    messagesApi.signedUrl(path).then(u => { if (on) setUrl(u); }).catch(() => { if (on) setFailed(true); });
    return () => { on = false; };
  }, [path, url]);
  if (failed) return <div className="mt-1 text-[11px] text-rose-300/70">Voice note unavailable</div>;
  if (!url) return (
    <div className="mt-1 inline-flex items-center gap-2 px-1 py-1.5 text-[11px] text-white/40">
      <Loader2 className="w-3 h-3 animate-spin" />Loading…
    </div>
  );
  return <AudioPlayer url={url} duration={duration} seed={path || 'pending'} pending={pending} />;
}

/* ── Messaging time helpers ─────────────────────────────────────────────────── */
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
/** Local wall-clock time, e.g. "3:04 PM". */
const clockTime = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
/** Full absolute datetime for hover titles, e.g. "Mon, Jun 1, 2026, 3:04 PM". */
const absoluteTime = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
/** Day-divider label: Today / Yesterday / weekday (<7d) / "Jun 1, 2026". */
const dayLabel = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Math.round((startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Shimmer placeholder block. */
function Skeleton({ className }) {
  return <div className={cx('animate-pulse rounded-md bg-white/[0.06]', className)} />;
}
/** Loading state for a message thread — a few ghost bubbles. */
function ChatSkeleton() {
  const rows = [{ mine: false, w: 'w-48' }, { mine: false, w: 'w-32' }, { mine: true, w: 'w-40' }, { mine: false, w: 'w-56' }, { mine: true, w: 'w-24' }];
  return (
    <div className="space-y-4 py-1">
      {rows.map((r, i) => (
        <div key={i} className={cx('flex items-end gap-2.5', r.mine && 'flex-row-reverse')}>
          {!r.mine && <Skeleton className="w-7 h-7 rounded-full shrink-0" />}
          <div className={cx('flex flex-col gap-1.5', r.mine ? 'items-end' : 'items-start')}>
            {!r.mine && <Skeleton className="h-2.5 w-20" />}
            <Skeleton className={cx('h-8 rounded-2xl', r.w)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Sticky centered day divider; theme-aware so it reads on both dark and light threads. */
function DayDivider({ label }) {
  const { theme } = useApp();
  const light = theme === 'light';
  return (
    <div className="sticky top-0 z-10 flex justify-center py-2 pointer-events-none">
      <span className="px-2.5 h-6 inline-flex items-center rounded-full text-[10px] font-medium uppercase tracking-wider backdrop-blur-sm border"
        style={{ background: light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)', color: light ? '#5a5d69' : 'rgba(255,255,255,0.5)', borderColor: light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)' }}>
        {label}
      </span>
    </div>
  );
}

/** The one avatar in the app. Photo if the user has one, else their initials, else a silhouette —
 *  never an empty circle. The deterministic per-user color still tints the fallback, so a person
 *  stays recognisable at a glance whether or not they've uploaded a photo.
 *  `photoUrl` is inert until the profile-photo work lands; every call site is already wired for it. */
function Avatar({ name, userId, photoUrl, size = 28, className }) {
  const c = assigneeColor(userId);
  const [broken, setBroken] = useState(false);
  const initials = initialsFor(name);
  const showPhoto = !!photoUrl && !broken;

  return (
    <span className={cx('rounded-full flex items-center justify-center font-semibold shrink-0 select-none overflow-hidden', className)}
      style={{
        width: size, height: size,
        background: showPhoto ? 'transparent' : c.soft,
        color: c.hex,
        border: `1px solid ${c.hex}33`,
        fontSize: Math.round(size * 0.36),
      }}>
      {showPhoto ? (
        // Fixed box + lazy/async decode: an avatar renders in every roster row and chat line, so it
        // must never drive layout off an image whose real dimensions we don't control.
        <img src={photoUrl} alt="" width={size} height={size} loading="lazy" decoding="async"
          onError={() => setBroken(true)}
          style={{ width: size, height: size, objectFit: 'cover', display: 'block' }} />
      ) : initials ? initials : (
        <User aria-hidden="true" style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} />
      )}
    </span>
  );
}

/** Round sender avatar for chat/DM bubbles. Thin alias kept so the messaging call sites read clearly. */
function MsgAvatar({ name, userId, photoUrl, size = 28 }) {
  return <Avatar name={name} userId={userId} photoUrl={photoUrl} size={size} />;
}

// Edit/delete are allowed for 10 minutes after sending — the SAME window the DB trigger enforces.
// This client gate is UX only (it hides the actions once stale); the server is authoritative and
// rejects a late edit/delete that slips through (P0001), after which the caller reconciles.
const MSG_EDIT_WINDOW_MS = 10 * 60 * 1000;

/** One message bubble: tombstone / body (+ "(edited)") / voice note, an inline editor, and a
 *  hover-and-touch "…" actions menu (Edit own · Copy · Delete own). Shared by team chat + DMs. */
function MsgBubble({ m, mine, onDelete, onEdit }) {
  const [menu, setMenu] = useState(false);
  const [pos, setPos] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [actable, setActable] = useState(false);   // within the 10-min window — evaluated on menu open
  const btnRef = useRef(null);

  const deleted = !!m.deletedAt;
  const edited = !!m.editedAt;
  const hasBody = !!m.body;
  const canCopy = hasBody && !deleted;
  // Trigger visibility (pure): the precise 10-min window is computed in openMenu, not at render
  // (Date.now() is impure for render), and gates Edit/Delete inside the menu via `actable`.
  // A pending bubble has no server row yet, so there is nothing to edit, copy or delete on it.
  const menuBtn = !deleted && !m.pending && (canCopy || mine);
  const MENU_W = 144;
  // Anchor the menu to the trigger's viewport rect, then render it via a PORTAL to document.body so
  // it escapes the scroll/overflow clipping of the message list (the old absolute menu was clipped
  // and spilled off the edge). Clamp horizontally so it never runs off-screen on mobile.
  const openMenu = () => {
    const within = Date.now() - new Date(m.createdAt).getTime() < MSG_EDIT_WINDOW_MS;
    if (!canCopy && !(mine && within)) return;   // nothing to show (e.g. an own voice note past the window)
    setActable(within);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      let left = mine ? r.right - MENU_W : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - MENU_W - 8));
      setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 96), left });
    }
    setMenu(true);
  };
  const copy = () => { try { navigator.clipboard?.writeText(m.body || ''); } catch { /* ignore */ } setMenu(false); };
  const startEdit = () => { setDraft(m.body || ''); setEditing(true); setMenu(false); };
  const saveEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== (m.body || '')) onEdit?.(m, next);   // no-op if unchanged/empty
  };

  // Tombstone — content was stripped server-side; render a muted placeholder in place, no actions.
  if (deleted) {
    return (
      <div className={cx('max-w-full rounded-2xl px-3 py-2 border text-[13px] italic text-white/40',
        mine ? 'bg-white/[0.03] border-white/10 rounded-tr-sm' : 'bg-white/[0.03] border-white/10 rounded-tl-sm')}>
        This message was deleted
      </div>
    );
  }

  // Inline editor for an own text message within the window.
  if (editing) {
    return (
      <div className={cx('max-w-full rounded-2xl px-3 py-2 border',
        mine ? 'bg-violet-500/20 border-violet-500/25 rounded-tr-sm' : 'bg-white/[0.05] border-white/10 rounded-tl-sm')}>
        <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          rows={Math.min(6, Math.max(1, (draft.match(/\n/g)?.length || 0) + 1))}
          className="w-full bg-transparent text-sm text-white/90 leading-relaxed outline-none resize-none" />
        <div className="mt-1 flex items-center justify-end gap-3 text-[11px]">
          <button onClick={() => setEditing(false)} className="text-white/45 hover:text-white/70">Cancel</button>
          <button onClick={saveEdit} className="font-medium text-violet-300 hover:text-violet-200">Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className={cx('group/bubble relative max-w-full rounded-2xl px-3 py-2 border',
      mine ? 'bg-violet-500/20 border-violet-500/25 rounded-tr-sm' : 'bg-white/[0.05] border-white/10 rounded-tl-sm')}>
      {m.body && (
        <div className="text-sm text-white/85 leading-relaxed whitespace-pre-wrap break-words" title={absoluteTime(m.createdAt)}>
          <MentionText text={m.body} mentions={m.mentions} />
          {edited && <span className="ml-1.5 text-[10px] text-white/35 not-italic">(edited)</span>}
        </div>
      )}
      {(m.audioPath || m.localUrl) && (
        <VoiceNote path={m.audioPath} localUrl={m.localUrl} duration={m.audioDuration} pending={m.pending} />
      )}
      {menuBtn && (
        <button ref={btnRef} onClick={() => (menu ? setMenu(false) : openMenu())} aria-label="Message actions"
          className={cx('absolute -top-2 w-6 h-6 rounded-full bg-[#0f1017] border border-white/10 flex items-center justify-center text-white/45 hover:text-white/80 transition-opacity',
            'opacity-100 sm:opacity-0 sm:group-hover/bubble:opacity-100', mine ? '-left-2' : '-right-2')}>
          <MoreHorizontal className="w-3 h-3" />
        </button>
      )}
      {menu && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setMenu(false)} />
          <div className="fixed z-[71] w-36 rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl py-1"
            style={{ top: pos.top, left: pos.left, animation: 'slideUp .12s ease' }}>
            {mine && hasBody && actable && (
              <button onClick={startEdit} className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-white/80 hover:bg-white/5">
                <Edit3 className="w-3.5 h-3.5" />Edit
              </button>
            )}
            {canCopy && (
              <button onClick={copy} className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-white/80 hover:bg-white/5">
                <Copy className="w-3.5 h-3.5" />Copy
              </button>
            )}
            {mine && actable && (
              <button onClick={() => { setMenu(false); onDelete?.(m); }} className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-rose-300 hover:bg-rose-500/10">
                <Trash2 className="w-3.5 h-3.5" />Delete
              </button>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/** The scrollable message timeline — sticky day dividers, sender grouping, avatars (both
 *  surfaces), per-message receipts (DM), skeleton loading, empty state, sticky-bottom
 *  autoscroll, and a jump-to-latest button. Shared by the team channel and DM threads. */
function MessageList({ items, userId, nameOf, loading, empty, onDelete, onEdit, receiptFor, hasMore, onLoadOlder, loadingOlder }) {
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const prependAnchorRef = useRef(null);   // 5c: distance-from-bottom captured before an older page prepends
  const [showJump, setShowJump] = useState(false);
  const jump = () => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };
  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near; setShowJump(!near);
  };
  // 5c: capture the scroll anchor synchronously (before the fetch resolves + items grow) so the viewport
  // can be restored to the same message after older history is prepended above.
  const handleLoadOlder = () => {
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = el.scrollHeight - el.scrollTop;   // invariant under a top-prepend
    onLoadOlder?.();
  };
  useLayoutEffect(() => {
    const el = scrollRef.current; if (!el) return;
    // Just prepended older history -> keep the same message in view (don't jump), and don't bottom-stick.
    if (prependAnchorRef.current != null) {
      el.scrollTop = el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = null;
      return;
    }
    // Otherwise stick to the bottom on new messages only when already near it (or it's my own send),
    // so reading older history isn't yanked away.
    const last = items[items.length - 1];
    if (atBottomRef.current || last?.senderId === userId) { el.scrollTop = el.scrollHeight; setShowJump(false); }
  }, [items, userId]);

  // Group messages by calendar day so each day's divider is a sticky SECTION header. With the divider
  // sticky INSIDE its own <section>, only the current day's header is pinned at a time: as a section
  // scrolls past the top its header leaves with it and the next day's header takes over (standard
  // WhatsApp/iMessage behavior, never two stacked). Also stamps each message's firstOfGroup.
  const days = useMemo(() => {
    const groups = [];
    items.forEach((m, i) => {
      const prev = items[i - 1];
      const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
      const firstOfGroup = newDay || prev.senderId !== m.senderId || (new Date(m.createdAt) - new Date(prev.createdAt) > 5 * 60 * 1000);
      if (newDay) groups.push({ key: m.id, label: dayLabel(m.createdAt), rows: [] });
      groups[groups.length - 1].rows.push({ m, firstOfGroup });
    });
    return groups;
  }, [items]);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto px-4 py-4">
        {loading ? <ChatSkeleton /> : items.length === 0 ? empty : (<>
        {hasMore && (
          <div className="flex justify-center pb-2">
            <button onClick={handleLoadOlder} disabled={loadingOlder}
              className="text-[11px] px-3 h-7 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 text-white/60 disabled:opacity-50 transition-colors">
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {days.map(day => (
          <section key={day.key}>
            <DayDivider label={day.label} />
            {day.rows.map(({ m, firstOfGroup }) => {
              const mine = m.senderId === userId;
              return (
                <div key={m.id} className={cx('flex gap-2.5', mine && 'flex-row-reverse', firstOfGroup ? 'mt-3' : 'mt-0.5')}>
                  {!mine && (firstOfGroup ? <MsgAvatar name={nameOf(m.senderId)} userId={m.senderId} /> : <span className="w-7 shrink-0" aria-hidden="true" />)}
                  <div className={cx('flex flex-col min-w-0 max-w-[78%]', mine ? 'items-end' : 'items-start')}>
                    {firstOfGroup && (
                      <div className={cx('flex items-baseline gap-2 mb-1 px-0.5', mine && 'flex-row-reverse')}>
                        {!mine && <span className="text-[12px] font-semibold text-white/80">{nameOf(m.senderId)}</span>}
                        <span className="text-[10px] text-white/35 tabular-nums">{clockTime(m.createdAt)}</span>
                      </div>
                    )}
                    <MsgBubble m={m} mine={mine} onDelete={onDelete} onEdit={onEdit} />
                    {mine && receiptFor && receiptFor(m)}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        </>)}
      </div>
      {showJump && (
        <button onClick={jump} aria-label="Jump to latest"
          className="absolute bottom-3 right-3 z-10 w-9 h-9 rounded-full bg-[#0f1017] border border-white/15 shadow-xl flex items-center justify-center text-white/70 hover:text-white hover:border-white/25">
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/** Typing / recording presence over an ephemeral Realtime channel (no DB). Returns the
 *  "others" list + helpers to broadcast my own state. channelKey === null → disabled. */
function usePresence(channelKey, userId, name) {
  const [others, setOthers] = useState([]);
  const ref = useRef(null);
  const typingTimer = useRef(null);
  useEffect(() => {
    if (!channelKey || !userId) return undefined;
    const handle = messagesApi.presence({ userId, name }, setOthers, channelKey);
    ref.current = handle;
    return () => { clearTimeout(typingTimer.current); handle.unsubscribe(); ref.current = null; setOthers([]); };
  }, [channelKey, userId, name]);
  const signalTyping = useCallback(() => {
    ref.current?.update({ typing: true });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => ref.current?.update({ typing: false }), 2500);
  }, []);
  const stopTyping = useCallback(() => { clearTimeout(typingTimer.current); ref.current?.update({ typing: false }); }, []);
  const signalRecording = useCallback((on) => ref.current?.update(on ? { recording: true, typing: false } : { recording: false }), []);
  const signalRead = useCallback((iso) => ref.current?.update({ readAt: iso }), []);
  return { others, signalTyping, stopTyping, signalRecording, signalRead };
}

/** Subtle "X is typing… / recording…" strip with animated dots. */
function TypingStrip({ label }) {
  if (!label) return null;
  return (
    <div className="px-4 py-1.5 text-[11px] text-white/45 border-t border-white/5 shrink-0 flex items-center gap-1.5">
      <span className="flex gap-0.5">
        <span className="w-1 h-1 rounded-full bg-violet-400/70 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1 h-1 rounded-full bg-violet-400/70 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1 h-1 rounded-full bg-violet-400/70 animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      {label}
    </div>
  );
}

/** Shared composer: autosizing textarea (1 → ~6 rows), voice button, primary Send, a
 *  recording bar, and a visible send-failure + Retry affordance. Presentational — the view
 *  owns recording + send state and passes handlers down. */
function Composer({ onSubmitText, onTyping, onStopTyping, recording, seconds, onStartRecording, onStopRecording, micError, canVoice, onUpgradeVoice, placeholder, mentionMembers, meId }) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState([]);
  const [sending, setSending] = useState(false);
  const [failedBody, setFailedBody] = useState('');
  const [failedMentions, setFailedMentions] = useState([]);   // retry must resend the same @mentions, not none
  const taRef = useRef(null);
  const autosize = useCallback(() => { const el = taRef.current; if (!el) return; el.style.height = '0px'; const h = Math.min(el.scrollHeight, 140); el.style.height = h + 'px'; el.style.overflowY = el.scrollHeight > 140 ? 'auto' : 'hidden'; }, []);
  useEffect(() => { autosize(); }, [text, autosize]);

  const doSend = async (body, mns) => {
    if (!body || sending) return;
    setSending(true);
    try { await onSubmitText(body, mns); setFailedBody(''); setFailedMentions([]); }
    catch (e) { console.error('Message send failed:', e); setFailedBody(body); setFailedMentions(mns || []); }
    finally { setSending(false); }
  };
  const submit = () => { const body = text.trim(); if (!body) return; const mns = mentions; setText(''); setMentions([]); onStopTyping?.(); doSend(body, mns); };
  const retry = () => { const body = failedBody, mns = failedMentions; setFailedBody(''); setFailedMentions([]); doSend(body, mns); };

  return (
    <div className="border-t border-white/10 shrink-0">
      {failedBody && (
        <div className="px-4 py-1.5 flex items-center gap-2 text-[11px] text-rose-300/90 border-b border-white/5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 truncate">Couldn’t send “{failedBody}”.</span>
          <button onClick={retry} className="font-semibold underline underline-offset-2 hover:text-rose-200">Retry</button>
          <button onClick={() => setFailedBody('')} aria-label="Dismiss" className="text-white/40 hover:text-white/70"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      <div className="p-3">
        {recording ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs text-rose-300">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" /> Recording {fmtDur(seconds)}
            </span>
            <span className="flex items-end gap-0.5 h-4" aria-hidden="true">
              {[0, 1, 2, 3, 4].map(i => <span key={i} className="w-0.5 rounded-full bg-rose-400/70 animate-pulse" style={{ height: `${6 + ((i * 7 + seconds * 5) % 10)}px`, animationDelay: `${i * 120}ms` }} />)}
            </span>
            <div className="flex-1" />
            <button onClick={() => onStopRecording(true)} className="text-xs text-white/50 hover:text-white/80">Cancel</button>
            <button onClick={() => onStopRecording(false)} className="inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-xs font-semibold bg-white text-black hover:bg-white/90">
              <Square className="w-3 h-3" />Stop &amp; send
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <MentionTextarea textareaRef={taRef} value={text} onChange={setText} onMentionsChange={setMentions}
              members={mentionMembers} meId={meId} onEnter={submit} onTyping={onTyping} onBlur={() => onStopTyping?.()} rows={1}
              placeholder={placeholder}
              className="max-h-[140px] bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/90 placeholder-white/30 outline-none focus:border-violet-400/50 resize-none overflow-y-hidden leading-relaxed" />
            <button onClick={() => canVoice ? onStartRecording() : onUpgradeVoice?.()} disabled={sending}
              aria-label={canVoice ? 'Record a voice note' : 'Upgrade to unlock voice notes'}
              title={canVoice ? 'Record a voice note' : 'Upgrade to unlock voice notes'}
              className="inline-flex items-center justify-center w-9 h-9 rounded-xl border border-white/10 bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-40 shrink-0">
              {canVoice ? <Mic className="w-4 h-4" /> : <Lock className="w-3.5 h-3.5" />}
            </button>
            <button onClick={submit} disabled={!text.trim() || sending}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 h-9 text-xs font-semibold bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
              <Send className="w-3.5 h-3.5" />Send
            </button>
          </div>
        )}
        {micError && <div className="mt-1.5 text-[11px] text-rose-300/80">{micError}</div>}
      </div>
    </div>
  );
}

function ChatView() {
  const { session, markChatRead, currentMember, currentWorkspaceId, requestUpgrade, members, meId } = useApp();
  const entitlements = useEntitlements();
  const userId = session?.user?.id;
  const myName = currentMember?.display_name || currentMember?.email || 'You';
  const [items, setItems] = useState([]);
  const [people, setPeople] = useState({});
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);          // 5c: an older page may exist
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micError, setMicError] = useState('');
  const mrRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startRef = useRef(0);
  const cancelRef = useRef(false);

  // (#7) Typing/recording presence on a WORKSPACE-SCOPED channel (was a single global
  // 'chat-presence' shared across every tenant — a cross-workspace leak). Keyed per workspace.
  const presenceKey = currentWorkspaceId ? `chat-presence-${currentWorkspaceId}` : null;
  const { others, signalTyping, stopTyping, signalRecording } = usePresence(presenceKey, userId, myName);

  // Peer typing indicator with the same safety net as the DM thread: it auto-expires 5s after the last
  // presence update (so a missed "stopped typing" broadcast can't leave it stuck) and is cleared the
  // moment a message arrives (see the subscription below). Deferred set so it isn't a synchronous
  // setState in the effect body.
  const [shownTyping, setShownTyping] = useState('');
  const typingExpiryRef = useRef(null);
  useEffect(() => {
    const label = presenceLabel(others);
    const t = setTimeout(() => {
      setShownTyping(label);
      clearTimeout(typingExpiryRef.current);
      if (label) typingExpiryRef.current = setTimeout(() => setShownTyping(''), 5000);
    }, 0);
    return () => clearTimeout(t);
  }, [others]);
  useEffect(() => () => clearTimeout(typingExpiryRef.current), []);

  // Sender names from members.
  useEffect(() => {
    let on = true;
    membersApi.list().then(list => { if (on) setPeople(Object.fromEntries((list || []).map(m => [m.id, m]))); }).catch(() => {});
    return () => { on = false; };
  }, []);

  // Load + subscribe; mark read while open. Scoped to the current workspace (re-runs on switch).
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let on = true;
    messagesApi.list(200, currentWorkspaceId).then(list => { if (on) { setItems(list); setHasMore(list.length >= 200); } }).catch(e => console.error('Failed to load messages:', e)).finally(() => { if (on) setLoading(false); });
    markChatRead();
    const unsub = messagesApi.subscribe(({ type, message }) => {
      if (!message || !on) return;
      setItems(prev => {
        if (type === 'DELETE') return prev.filter(m => m.id !== message.id);
        if (type === 'UPDATE') return prev.map(m => m.id === message.id ? message : m);
        return prev.some(m => m.id === message.id) ? prev : [...prev, message];
      });
      // Clear the typing indicator immediately on someone else's message (don't wait for "stopped typing").
      if (type === 'INSERT' && message.senderId !== userId) setShownTyping('');
      markChatRead();
    }, 'messages-thread', currentWorkspaceId);
    return () => { on = false; unsub(); };
  }, [markChatRead, currentWorkspaceId, userId]);

  // 5c: fetch the previous page of history and prepend it (dedupe by id). Guarded against concurrent runs.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const oldest = items[0];
    if (!oldest) return;
    loadingOlderRef.current = true; setLoadingOlder(true);
    try {
      const page = await messagesApi.listBefore(oldest.createdAt, 200, currentWorkspaceId);
      if (page.length) setItems(prev => { const seen = new Set(prev.map(m => m.id)); return [...page.filter(m => !seen.has(m.id)), ...prev]; });
      setHasMore(page.length >= 200);
    } catch (e) { console.error('Load older messages failed:', e); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [items, currentWorkspaceId]);

  // Stop any in-flight recording on unmount.
  useEffect(() => () => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const nameOf = (id) => (id === userId ? 'You' : (people[id]?.display_name || people[id]?.email || 'Someone'));

  const sendText = async (body, mentions) => {
    const created = await messagesApi.sendText(body, currentWorkspaceId, mentions);
    setItems(prev => prev.some(m => m.id === created.id) ? prev : [...prev, created]);
  };

  const startRecording = async () => {
    setMicError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMicError('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickAudioMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelRef.current = false;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        clearInterval(timerRef.current);
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        const dur = (Date.now() - startRef.current) / 1000;
        const ct = (mr.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunksRef.current, { type: ct });
        chunksRef.current = [];
        if (cancelRef.current || blob.size === 0) return;
        if (dur < 0.4) { setMicError('Too short. Hold to record a little longer.'); return; }
        // Paint the bubble NOW from the local blob. sendVoice is three serial round-trips
        // (getSession -> upload the whole blob -> insert), and until this it rendered nothing at all
        // for that entire window.
        const tempId = `pending-${uid()}`;
        const localUrl = URL.createObjectURL(blob);
        setItems(prev => [...prev, {
          id: tempId, senderId: userId, body: null, audioPath: null, audioDuration: dur,
          createdAt: nowISO(), pending: true, localUrl,
        }]);
        try {
          const created = await messagesApi.sendVoice(blob, dur, ct, currentWorkspaceId);
          // Keep the blob as this note's playback source so the sender never re-downloads what they
          // just uploaded; it outlives the placeholder, so don't revoke it here.
          rememberLocalAudio(created.audioPath, localUrl);
          // Swap the placeholder for the server row. Insert-if-absent because the realtime echo can
          // land the same row while the upload is still in flight.
          setItems(prev => {
            const rest = prev.filter(m => m.id !== tempId);
            return rest.some(m => m.id === created.id) ? rest : [...rest, created];
          });
        } catch (e) {
          console.error('Voice send failed:', e);
          URL.revokeObjectURL(localUrl);
          setItems(prev => prev.filter(m => m.id !== tempId));
          setMicError('Failed to send voice note.');
        }
      };
      mrRef.current = mr;
      startRef.current = Date.now();
      mr.start();
      setRecording(true);
      setSeconds(0);
      signalRecording(true);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch (e) {
      console.error('Mic error:', e);
      setMicError('Microphone access was denied or unavailable.');
    }
  };

  const stopRecording = (cancelled) => {
    cancelRef.current = cancelled;
    setRecording(false);
    clearInterval(timerRef.current);
    signalRecording(false);
    const mr = mrRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  };

  // Soft-delete: tombstone the message IN PLACE (don't drop it) — the server strips its content and
  // the row stays so the thread shows "This message was deleted". Reconcile from the server on failure.
  const remove = async (m) => {
    setItems(prev => prev.map(x => x.id === m.id ? { ...x, body: null, audioPath: null, deletedAt: nowISO() } : x));
    try { await messagesApi.softDelete(m); }
    catch (e) { console.error('Delete failed:', e); messagesApi.list(200, currentWorkspaceId).then(setItems).catch(() => {}); }
  };

  // Edit own text in place; the DB trigger enforces the 10-minute window + stamps edited_at.
  const edit = async (m, body) => {
    setItems(prev => prev.map(x => x.id === m.id ? { ...x, body, editedAt: nowISO() } : x));
    try { await messagesApi.update(m.id, body); }
    catch (e) { console.error('Edit failed:', e); messagesApi.list(200, currentWorkspaceId).then(setItems).catch(() => {}); }
  };

  return (
    <div className="cc-chat flex flex-col h-[calc(100dvh-9rem)] rounded-2xl border border-white/10 bg-[#0a0b11] overflow-hidden">
      <style>{`
        [data-theme="light"] .cc-chat .bg-violet-500\\/20 { background: #ede9fe !important; }
        [data-theme="light"] .cc-chat .border-violet-500\\/25 { border-color: #c4b5fd !important; }
        [data-theme="light"] .cc-chat .bg-violet-500\\/25 { background: rgba(124,58,237,0.16) !important; }
        [data-theme="light"] .cc-chat .border-violet-400\\/30 { border-color: rgba(124,58,237,0.4) !important; }
        [data-theme="light"] .cc-chat .bg-violet-500\\/10 { background: #f3e8ff !important; }
        [data-theme="light"] .cc-chat .border-violet-500\\/20 { border-color: #e9d5ff !important; }
        [data-theme="light"] .cc-chat .text-violet-300\\/70 { color: #7c3aed !important; }
        [data-theme="light"] .cc-chat .bg-violet-400 { background: #7c3aed !important; }
        [data-theme="light"] .cc-chat .bg-violet-400\\/70 { background: #7c3aed !important; }
        [data-theme="light"] .cc-chat .bg-white\\/\\[0\\.05\\] { background: rgba(0,0,0,0.06) !important; }
      `}</style>
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2.5 shrink-0">
        <span className="w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/25 flex items-center justify-center text-violet-300 text-sm font-semibold shrink-0">#</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90 leading-tight">Team chat</div>
          <div className="text-[10px] text-white/35 leading-tight">Everyone in this workspace</div>
        </div>
      </div>

      <MessageList
        items={items}
        userId={userId}
        nameOf={nameOf}
        loading={loading}
        hasMore={hasMore}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onDelete={remove}
        onEdit={edit}
        empty={(
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-10">
            <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-violet-300/70" />
            </div>
            <div className="text-sm font-medium text-white/70">No messages yet</div>
            <div className="text-[12px] text-white/40">Start the conversation with your team 👋</div>
          </div>
        )}
      />

      <TypingStrip label={shownTyping} />

      <Composer
        placeholder="Message the workspace…  (@ to mention, Enter to send)"
        onSubmitText={sendText}
        mentionMembers={members.filter(m => m.role !== 'guest')}
        meId={meId}
        onTyping={signalTyping}
        onStopTyping={stopTyping}
        recording={recording}
        seconds={seconds}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
        micError={micError}
        canVoice={entitlements.can('voiceNotes')}
        onUpgradeVoice={() => requestUpgrade('voiceNotes')}
      />
    </div>
  );
}

/* =================================================================================
   DIRECT MESSAGES — private 1:1 threads. Conversation list (left) + thread (right);
   reuses the chat thread patterns (autoscroll, optimistic send, voice notes) and the
   shared voice-notes bucket. Read state is server-side (dm_reads) -> unread + receipts.
================================================================================= */
function DirectMessagesView() {
  const { meId, members, resolveAssignee, dmConversations, dmActiveConv, setDmActiveConv, startDm } = useApp();
  const [picking, setPicking] = useState(false);
  const [startErr, setStartErr] = useState('');
  const peers = members.filter(m => m.userId !== meId);
  const active = dmConversations.find(c => c.id === dmActiveConv) || null;

  const preview = (m) => {
    if (!m) return 'No messages yet';
    if (m.deletedAt) return 'Message deleted';
    if (m.body) return m.body;
    if (m.audioPath) return '🎤 Voice note';
    return '…';
  };

  const onPick = async (peerId) => {
    setPicking(false); setStartErr('');
    try { await startDm(peerId); } catch (e) { setStartErr(e?.message || 'Could not start the conversation.'); }
  };

  const ConversationList = (
    <div className="flex flex-col h-full">
      <div className="px-3 py-3 border-b border-white/5 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <MessagesSquare className="w-4 h-4 text-white/50" />
          <div className="text-sm font-semibold text-white/90">Direct messages</div>
        </div>
        <div className="relative">
          <button onClick={() => setPicking(p => !p)} disabled={peers.length === 0}
            className="inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Plus className="w-3 h-3" />New
          </button>
          {picking && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPicking(false)} />
              <div className="absolute right-0 top-9 z-40 w-56 rounded-xl border border-white/10 bg-[#0f1017] shadow-2xl py-1.5" style={{ animation: 'slideUp .15s ease' }}>
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-white/35">Message someone</div>
                {peers.map(m => {
                  const a = resolveAssignee(m.userId);
                  return (
                    <button key={m.userId} onClick={() => onPick(m.userId)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: a.hex }} />
                      <span className="truncate">{m.displayName || m.email}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
      {startErr && <div className="px-3 py-1.5 text-[11px] text-rose-300/80 border-b border-white/5 shrink-0">{startErr}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {dmConversations.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-white/40">
            {peers.length === 0 ? 'No one else is in this workspace yet.' : 'No conversations yet. Start one with “New”.'}
          </div>
        ) : dmConversations.map(c => {
          const a = resolveAssignee(c.peerId);
          const selected = c.id === dmActiveConv;
          return (
            <button key={c.id} onClick={() => setDmActiveConv(c.id)}
              className={cx('w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')}>
              <Avatar name={a.label === 'Me' ? 'You' : a.label} userId={c.peerId} photoUrl={a.avatarUrl} size={32} />
              <span className="flex-1 min-w-0">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white/85 truncate">{a.label === 'Me' ? 'You' : a.label}</span>
                  <span className="text-[10px] text-white/35 shrink-0">{c.preview ? timeAgo(c.lastAt) : ''}</span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className={cx('text-[12px] truncate', c.unread > 0 ? 'text-white/70' : 'text-white/40')}>{preview(c.preview)}</span>
                  {c.unread > 0 && (
                    <span className="shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-rose-50 text-[9px] font-bold leading-none flex items-center justify-center">{c.unread > 9 ? '9+' : c.unread}</span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="cc-chat h-[calc(100dvh-9rem)] rounded-2xl border border-white/10 bg-[#0a0b11] overflow-hidden flex">
      <style>{`
        [data-theme="light"] .cc-chat .bg-violet-500\\/20 { background: #ede9fe !important; }
        [data-theme="light"] .cc-chat .border-violet-500\\/25 { border-color: #c4b5fd !important; }
        [data-theme="light"] .cc-chat .bg-violet-500\\/25 { background: rgba(124,58,237,0.16) !important; }
        [data-theme="light"] .cc-chat .border-violet-400\\/30 { border-color: rgba(124,58,237,0.4) !important; }
        [data-theme="light"] .cc-chat .bg-white\\/\\[0\\.05\\] { background: rgba(0,0,0,0.06) !important; }
      `}</style>
      {/* List: always shown on lg; on small screens shown only when no thread is open */}
      <aside className={cx('w-full lg:w-80 lg:shrink-0 lg:border-r border-white/5 h-full', active ? 'hidden lg:flex lg:flex-col' : 'flex flex-col')}>
        {ConversationList}
      </aside>
      <section className={cx('flex-1 min-w-0 h-full', active ? 'flex flex-col' : 'hidden lg:flex lg:flex-col')}>
        {active ? (
          <DmThread key={active.id} conversationId={active.id} peerId={active.peerId} onBack={() => setDmActiveConv(null)} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-6">
            <div className="w-12 h-12 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
              <MessagesSquare className="w-5 h-5 text-violet-300/70" />
            </div>
            <div className="text-sm font-medium text-white/70">Your conversations</div>
            <div className="text-[12px] text-white/40">Pick a conversation, or start a new one.</div>
          </div>
        )}
      </section>
    </div>
  );
}

/** One open 1:1 thread. Keyed by conversationId so it remounts (fresh state) per conversation. */
function DmThread({ conversationId, peerId, onBack }) {
  const { session, currentMember, resolveAssignee, markDmRead, requestUpgrade } = useApp();
  const entitlements = useEntitlements();
  const userId = session?.user?.id;
  const peer = resolveAssignee(peerId);
  const isSelf = peerId === userId;
  const peerName = peer.label === 'Me' ? 'You' : peer.label;
  const myName = currentMember?.display_name || currentMember?.email || 'You';
  const [items, setItems] = useState([]);
  const [peerReadAt, setPeerReadAt] = useState(null);
  const [shownTyping, setShownTyping] = useState('');   // peer typing label (safety expiry + clear-on-message)
  const typingExpiryRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);          // 5c: an older page may exist
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micError, setMicError] = useState('');
  const mrRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startRef = useRef(0);
  const cancelRef = useRef(false);

  // DM typing/recording presence (NEW — makes presence symmetric with team chat). Per-conversation
  // ephemeral channel (no DB); disabled for the notes-to-self thread.
  const presenceKey = (!isSelf && conversationId) ? `dm-presence-${conversationId}` : null;
  const { others, signalTyping, stopTyping, signalRecording, signalRead } = usePresence(presenceKey, userId, myName);

  // Peer typing indicator with a safety net so it can't get stuck: it auto-expires 5s after the last
  // presence update (a missed "stopped typing" broadcast can't make it linger), and it's cleared the
  // moment a message from the peer arrives (see the thread subscription). Deferred set so it isn't a
  // synchronous setState in the effect body.
  useEffect(() => {
    const label = presenceLabel(others);
    const t = setTimeout(() => {
      setShownTyping(label);
      clearTimeout(typingExpiryRef.current);
      if (label) typingExpiryRef.current = setTimeout(() => setShownTyping(''), 5000);
    }, 0);
    return () => clearTimeout(t);
  }, [others]);
  useEffect(() => () => clearTimeout(typingExpiryRef.current), []);

  const refreshReads = useCallback(() => {
    directMessagesApi.reads(conversationId)
      .then(rs => { const p = rs.find(r => r.userId === peerId); setPeerReadAt(p?.lastReadAt || null); })
      .catch(() => {});
  }, [conversationId, peerId]);

  // Load + subscribe to this thread. (My read cursor is advanced by the latest-message effect below,
  // which runs on open AND on every new message, incoming or outgoing.) Remounts per conversation.
  useEffect(() => {
    let on = true;
    directMessagesApi.listMessages(conversationId, 200)
      .then(list => { if (on) { setItems(list); setHasMore(list.length >= 200); } })
      .catch(e => console.error('Failed to load DM thread:', e))
      .finally(() => { if (on) setLoading(false); });
    refreshReads();
    const unsub = directMessagesApi.subscribeThread(({ type, message }) => {
      if (!message || !on) return;
      setItems(prev => {
        if (type === 'DELETE') return prev.filter(m => m.id !== message.id);
        if (type === 'UPDATE') return prev.map(m => m.id === message.id ? message : m);
        return prev.some(m => m.id === message.id) ? prev : [...prev, message];
      });
      // Clear the typing indicator immediately on a peer message (don't wait for "stopped typing").
      if (type === 'INSERT' && message.senderId !== userId) setShownTyping('');
      refreshReads();   // peer may have advanced their cursor around new activity
    }, conversationId);
    return () => { on = false; unsub(); };
  }, [conversationId, userId, refreshReads]);

  // Keep MY read cursor at the latest message WHILE the conversation is open. THIS is the fix for the
  // already-open case: it re-runs whenever the LATEST message changes (incoming OR outgoing), so the
  // cursor advances on EVERY new message, not only on open. It writes a cover-time = the message's
  // SERVER timestamp, so the cursor covers a just-arrived message regardless of client clock skew. No
  // stale closure: it's a deps-driven effect (recreated each render), not a once-subscribed handler.
  const latestMsg = items.length ? items[items.length - 1] : null;
  const latestMsgId = latestMsg ? latestMsg.id : null;
  const latestMsgAt = latestMsg ? latestMsg.createdAt : null;
  useEffect(() => {
    if (isSelf || !conversationId || !latestMsgId) return;
    markDmRead(conversationId, latestMsgAt);
    signalRead(latestMsgAt || nowISO());
  }, [conversationId, latestMsgId, latestMsgAt, isSelf, markDmRead, signalRead]);

  // Re-READ the peer's cursor on a 4s interval AND on focus, so MY tick flips to Seen even when the
  // peer reads without sending a reply. (Writing MY cursor is the latest-message effect's job above.)
  // The persisted dm_reads cursor is the source of truth; the presence broadcast is a faster path.
  useEffect(() => {
    if (isSelf) return undefined;
    const id = setInterval(refreshReads, 4000);
    const onFocus = () => refreshReads();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [isSelf, refreshReads]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const nameOf = (id) => (id === userId ? 'You' : peerName);

  // Receipt on the LAST own message only: ✓ Sent / ✓✓ Seen (peer's read cursor). None on self-notes.
  const lastOwnId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) { if (items[i].senderId === userId) return items[i].id; }
    return null;
  }, [items, userId]);
  // Peer's read cursor = persisted dm_reads (cold load) OR the live presence value (whichever is
  // newer). The live value is what flips the sender's tick to Seen with no refresh/reopen.
  const peerLiveReadAt = useMemo(() => (others.find(o => o.userId === peerId)?.readAt) || null, [others, peerId]);
  // Most-recent of the persisted cursor and the live presence cursor, compared NUMERICALLY via
  // getTime() to avoid any string-vs-Date / timezone parsing pitfalls. The persisted cursor (polled
  // on focus + interval above) is the reliable source; the presence value is just a faster path.
  const effectiveReadAt = useMemo(() => {
    const a = peerReadAt ? new Date(peerReadAt).getTime() : 0;
    const b = peerLiveReadAt ? new Date(peerLiveReadAt).getTime() : 0;
    if (!a && !b) return null;
    return b > a ? peerLiveReadAt : peerReadAt;
  }, [peerReadAt, peerLiveReadAt]);
  const isSeen = (createdAt) => {
    if (!effectiveReadAt || !createdAt) return false;
    const readMs = new Date(effectiveReadAt).getTime();
    const msgMs = new Date(createdAt).getTime();
    return Number.isFinite(readMs) && Number.isFinite(msgMs) && readMs >= msgMs;
  };
  const receiptFor = isSelf ? undefined : (m) => {
    if (m.id !== lastOwnId) return null;
    const seen = isSeen(m.createdAt);
    return (
      <div className="mt-0.5 px-1 flex items-center gap-1 text-[10px]" title={seen ? 'Seen' : 'Sent'}>
        {seen
          ? <><CheckCheck className="w-3.5 h-3.5 text-violet-400" /><span className="text-violet-400/80">Seen</span></>
          : <><Check className="w-3 h-3 text-white/35" /><span className="text-white/35">Sent</span></>}
      </div>
    );
  };
  const sendText = async (body) => {
    const created = await directMessagesApi.sendText(conversationId, body);
    setItems(prev => prev.some(m => m.id === created.id) ? prev : [...prev, created]);
  };

  const startRecording = async () => {
    setMicError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMicError('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickAudioMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelRef.current = false;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        clearInterval(timerRef.current);
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        const dur = (Date.now() - startRef.current) / 1000;
        const ct = (mr.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunksRef.current, { type: ct });
        chunksRef.current = [];
        if (cancelRef.current || blob.size === 0) return;
        if (dur < 0.4) { setMicError('Too short. Hold to record a little longer.'); return; }
        // Same instant-render path as team chat — see the comment there.
        const tempId = `pending-${uid()}`;
        const localUrl = URL.createObjectURL(blob);
        setItems(prev => [...prev, {
          id: tempId, senderId: userId, body: null, audioPath: null, audioDuration: dur,
          createdAt: nowISO(), pending: true, localUrl,
        }]);
        try {
          const created = await directMessagesApi.sendVoice(conversationId, blob, dur, ct);
          rememberLocalAudio(created.audioPath, localUrl);
          setItems(prev => {
            const rest = prev.filter(m => m.id !== tempId);
            return rest.some(m => m.id === created.id) ? rest : [...rest, created];
          });
        } catch (e) {
          console.error('DM voice send failed:', e);
          URL.revokeObjectURL(localUrl);
          setItems(prev => prev.filter(m => m.id !== tempId));
          setMicError('Failed to send voice note.');
        }
      };
      mrRef.current = mr;
      startRef.current = Date.now();
      mr.start();
      setRecording(true);
      setSeconds(0);
      signalRecording(true);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch (e) {
      console.error('Mic error:', e);
      setMicError('Microphone access was denied or unavailable.');
    }
  };

  const stopRecording = (cancelled) => {
    cancelRef.current = cancelled;
    setRecording(false);
    clearInterval(timerRef.current);
    signalRecording(false);
    const mr = mrRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  };

  // Soft-delete in place (tombstone), mirroring the team chat — the row survives as
  // "This message was deleted". Reconcile from the server on failure.
  const remove = async (m) => {
    setItems(prev => prev.map(x => x.id === m.id ? { ...x, body: null, audioPath: null, deletedAt: nowISO() } : x));
    try { await directMessagesApi.softDelete(m); }
    catch (e) { console.error('DM delete failed:', e); directMessagesApi.listMessages(conversationId, 200).then(setItems).catch(() => {}); }
  };

  // Edit own DM text in place; the DB trigger enforces the 10-minute window + stamps edited_at.
  const edit = async (m, body) => {
    setItems(prev => prev.map(x => x.id === m.id ? { ...x, body, editedAt: nowISO() } : x));
    try { await directMessagesApi.update(m.id, body); }
    catch (e) { console.error('DM edit failed:', e); directMessagesApi.listMessages(conversationId, 200).then(setItems).catch(() => {}); }
  };

  // 5c: fetch the previous page of this thread and prepend it (dedupe by id). Guarded against concurrent runs.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const oldest = items[0];
    if (!oldest) return;
    loadingOlderRef.current = true; setLoadingOlder(true);
    try {
      const page = await directMessagesApi.listMessagesBefore(conversationId, oldest.createdAt, 200);
      if (page.length) setItems(prev => { const seen = new Set(prev.map(m => m.id)); return [...page.filter(m => !seen.has(m.id)), ...prev]; });
      setHasMore(page.length >= 200);
    } catch (e) { console.error('Load older DMs failed:', e); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [items, conversationId]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2.5 shrink-0">
        <button onClick={onBack} className="lg:hidden text-white/50 hover:text-white/80 -ml-1"><ChevronRight className="w-4 h-4 rotate-180" /></button>
        <MsgAvatar name={peerName} userId={peerId} size={32} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90 leading-tight truncate">{isSelf ? 'You' : peerName}</div>
          <div className="text-[10px] text-white/35 leading-tight">{isSelf ? 'Notes to self' : 'Direct message'}</div>
        </div>
      </div>

      <MessageList
        items={items}
        userId={userId}
        nameOf={nameOf}
        loading={loading}
        hasMore={hasMore}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onDelete={remove}
        onEdit={edit}
        receiptFor={receiptFor}
        empty={(
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-10">
            <MsgAvatar name={peerName} userId={peerId} size={48} />
            <div className="text-sm font-medium text-white/70">{isSelf ? 'Notes to self' : peerName}</div>
            <div className="text-[12px] text-white/40">{isSelf ? 'Jot down anything you want to remember.' : 'Say hello 👋'}</div>
          </div>
        )}
      />

      {!isSelf && <TypingStrip label={shownTyping} />}

      <Composer
        placeholder={isSelf ? 'Write a note to yourself…' : `Message ${peerName}…  (Enter to send)`}
        onSubmitText={sendText}
        onTyping={isSelf ? undefined : signalTyping}
        onStopTyping={isSelf ? undefined : stopTyping}
        recording={recording}
        seconds={seconds}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
        micError={micError}
        canVoice={entitlements.can('voiceNotes')}
        onUpgradeVoice={() => requestUpgrade('voiceNotes')}
      />
    </div>
  );
}

/** Shown to an authenticated user who belongs to no workspace yet: create your first one.
 *  Creation is the path today; joining by invitation comes in a later phase. */
function OnboardingScreen({ onSignOut }) {
  const { pendingInvites, acceptInvitation } = useApp();
  // Deliberately dark-only on AuthShell, like the rest of the pre-app funnel: this route renders
  // with no app chrome, so it carries no data-theme — the app's light-mode overrides can't reach
  // it, and it stays coherent whichever theme the app is in.
  return (
    <AuthShell
      icon={FolderKanban}
      heading="Create your workspace"
      tagline="A workspace is where your team's tasks, projects, and chat live. Name it to get started. You'll be its owner."
      footnote={null}
      beforeCard={pendingInvites.length > 0 ? (
        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/[0.06] p-5 shadow-2xl mb-4">
          <div className="text-[11px] font-medium uppercase tracking-widest text-emerald-300/70 mb-2">You've been invited</div>
          <div className="space-y-2">
            {pendingInvites.map(inv => (
              <div key={inv.id} className="flex items-center justify-between gap-2">
                <div className="text-sm text-white/90 truncate">Join <span className="font-semibold">{inv.workspaceName}</span></div>
                <button onClick={() => acceptInvitation(inv.token).catch(err => console.error('accept invite failed:', err))}
                  className="shrink-0 h-8 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-semibold active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">Accept</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      footer={
        <button onClick={() => onSignOut?.()}
          className="mx-auto block text-[11px] text-white/35 hover:text-white/60 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          Sign out
        </button>
      }
    >
      {pendingInvites.length > 0 && <div className="text-[11px] text-white/40 mb-3 text-center">Or create your own workspace</div>}
      <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Workspace name</label>
      <CreateWorkspaceForm submitLabel="Create workspace & continue" />
    </AuthShell>
  );
}

/* =================================================================================
   MEMBERS VIEW (owner-only) — roster + invite-by-email (copy-link) + pending invites
================================================================================= */
function MembersView() {
  const { currentWorkspaceId, myRole, canManageMembers, membershipsLoaded, members, meId, startDm, requestUpgrade, refreshMembers } = useApp();
  const entitlements = useEntitlements();
  const [invites, setInvites] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');   // invite-time role: member | guest (owner/admin assigned after join, via set_member_role)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [lastLink, setLastLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const [roleErr, setRoleErr] = useState('');         // surfaced server-side guardrail message
  const [removeTarget, setRemoveTarget] = useState(null);

  // Load the workspace's invitations (owner+admin RLS). Only async setState -> no sync-in-effect.
  useEffect(() => {
    if (!currentWorkspaceId || !canManageMembers) return;
    let alive = true;
    invitationsApi.listForWorkspace(currentWorkspaceId)
      .then(d => { if (alive) setInvites(d); })
      .catch(e => console.error('load invites failed:', e));
    return () => { alive = false; };
  }, [currentWorkspaceId, canManageMembers, reloadKey]);

  if (!membershipsLoaded) return null;
  if (!canManageMembers) {
    return (
      <div className="space-y-6">
        <ViewHeader title="Members" subtitle="People in this workspace." />
        <div className="text-sm text-white/50">Only an owner or admin can manage members and invitations.</div>
      </div>
    );
  }

  const reload = () => setReloadKey(k => k + 1);
  const inviteUrl = (token) => `${window.location.origin}/invite/${token}`;
  const copy = async (url) => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* ignore */ } };

  const submit = async (e) => {
    e.preventDefault();
    const v = email.trim();
    if (!v || busy) return;
    if (entitlements.atSeatLimit) { requestUpgrade('seats'); return; }
    setBusy(true); setErr(''); setCopied(false);
    try {
      const inv = await invitationsApi.create(currentWorkspaceId, v, inviteRole);
      const url = inviteUrl(inv.token);
      setLastLink({ email: inv.email, url, role: inv.role });
      setEmail('');
      await copy(url);
      reload();
    } catch (e2) {
      setErr(e2?.message || 'Could not create the invitation.');
    } finally { setBusy(false); }
  };

  const revoke = async (id) => {
    try { await invitationsApi.revoke(id); reload(); }
    catch (e) { console.error('revoke failed:', e); }
  };

  const pending = invites.filter(i => i.status === 'pending');

  // ── Role management (guardrails mirror the server-side RPC; the RPC is the real gate) ──
  const ROLE_RANK = { owner: 3, admin: 2, member: 1, guest: 0 };
  const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
  const myRank = ROLE_RANK[myRole] ?? -1;
  const ownerCount = members.filter(m => m.role === 'owner').length;
  // Roles this caller may assign: an owner can grant any role (incl. owner); an admin can set member/guest only.
  const settableRoles = myRank >= 3 ? ['owner', 'admin', 'member', 'guest'] : (myRank >= 2 ? ['member', 'guest'] : []);

  const changeRole = async (userId, role) => {
    setRoleErr('');
    try { await workspaceMembersApi.setRole(currentWorkspaceId, userId, role); await refreshMembers(); }
    catch (e) { setRoleErr(e?.message || 'Could not change the role.'); }
  };
  const doRemove = async () => {
    const t = removeTarget; setRemoveTarget(null); if (!t) return;
    setRoleErr('');
    try { await workspaceMembersApi.remove(currentWorkspaceId, t.userId); await refreshMembers(); }
    catch (e) { setRoleErr(e?.message || 'Could not remove the member.'); }
  };

  return (
    <div className="space-y-6">
      <ViewHeader title="Members" subtitle="People in this workspace, and pending invitations." />
      <ConfirmModal
        open={!!removeTarget}
        title="Remove member?"
        message={`Remove ${removeTarget?.displayName || removeTarget?.email || 'this person'} from the workspace? They lose access immediately; their tasks and messages stay. This can't be undone.`}
        confirmLabel="Remove"
        onConfirm={doRemove}
        onClose={() => setRemoveTarget(null)} />

      <Card title="Invite a teammate" subtitle="Pick whether they join as a full member or a limited guest. No email is sent automatically — copy the invite link below and share it with them.">
        {entitlements.atSeatLimit && (
          <button type="button" onClick={() => requestUpgrade('seats')}
            className="w-full mb-3 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-violet-400/30 bg-violet-500/10 text-left hover:bg-violet-500/15 transition-colors">
            <Lock className="w-3.5 h-3.5 text-violet-300 shrink-0" />
            <span className="text-[12px] text-violet-100/90 flex-1">You've reached your plan's member limit ({entitlements.limits.seats}). Upgrade to add more.</span>
            <span className="text-[11px] font-semibold text-violet-200 shrink-0">See plans</span>
          </button>
        )}
        <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@example.com"
            className="flex-1 h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-sm text-white/90 outline-none focus:border-violet-400/50 transition-colors" />
          <div className="inline-flex shrink-0 rounded-xl border border-white/10 bg-white/5 p-0.5" role="radiogroup" aria-label="Invite as role">
            {['member', 'guest'].map(r => (
              <button key={r} type="button" role="radio" aria-checked={inviteRole === r} onClick={() => setInviteRole(r)}
                className={cx('px-3 h-8 rounded-lg text-xs font-medium capitalize transition-colors',
                  inviteRole === r ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80')}>
                {r}
              </button>
            ))}
          </div>
          <button type="submit" disabled={busy || !email.trim()}
            className={cx('h-9 px-4 rounded-xl text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors', (busy || !email.trim()) ? 'bg-violet-500/40 cursor-not-allowed' : 'bg-violet-500 hover:bg-violet-400')}>
            <Mail className="w-3.5 h-3.5" />Create invite link
          </button>
        </form>
        <p className="text-[11px] text-white/40 mt-2">
          {inviteRole === 'guest'
            ? 'Guests only see tasks assigned to them + direct messages — good for clients or freelancers. You can change their role later.'
            : 'Members get full access to this workspace (tasks, chat, projects). You can change their role later.'}
        </p>
        {err && <p className="text-[11px] text-rose-300 mt-2">{err}</p>}
        {lastLink && (
          <div className="mt-3 p-3 rounded-xl border border-white/10 bg-white/[0.03]">
            <div className="text-[11px] text-white/50 mb-1.5">{copied ? 'Link copied. ' : ''}Send this to {lastLink.email} — joins as <span className="capitalize text-white/70">{lastLink.role || 'member'}</span>:</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-[11px] text-white/70">{lastLink.url}</code>
              <button onClick={() => copy(lastLink.url)} className="shrink-0 text-[11px] px-2 h-7 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">Copy</button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Current members" subtitle={`${members.length} in this workspace`}>
        {roleErr && <p className="text-[11px] text-rose-300 mb-2">{roleErr}</p>}
        <div className="space-y-1.5">
          {members.map(m => {
            const targetRank = ROLE_RANK[m.role] ?? -1;
            const isSelf = m.userId === meId;
            const isLastOwner = m.role === 'owner' && ownerCount <= 1;
            // Who the caller may modify: owner -> anyone (except the last owner & themselves);
            // admin -> members/guests only. The server RPC enforces this regardless of the UI.
            const canModify = !isSelf && !isLastOwner && (myRank >= 3 ? true : (myRank >= 2 ? targetRank < 2 : false));
            return (
              <div key={m.userId} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.02]">
                <div className="min-w-0 flex items-center gap-2.5">
                  <Avatar name={m.displayName || m.email} userId={m.userId} photoUrl={m.avatarUrl} size={32} />
                  <div className="min-w-0">
                    <div className="text-sm text-white/90 truncate">{m.displayName || m.email}{isSelf && <span className="text-white/40"> (you)</span>}</div>
                    <div className="text-[11px] text-white/40 truncate">{m.email}</div>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {!isSelf && (
                    <button onClick={() => startDm(m.userId).catch(() => {})} title={`Message ${m.displayName || m.email}`}
                      className="text-[11px] px-2 h-7 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 inline-flex items-center gap-1 transition-colors">
                      <MessagesSquare className="w-3 h-3" />Message
                    </button>
                  )}
                  {canModify ? (
                    <div className="relative">
                      <select value={m.role} onChange={(e) => changeRole(m.userId, e.target.value)} aria-label={`Role for ${m.displayName || m.email}`}
                        className="appearance-none text-[11px] h-7 rounded-lg bg-white/5 border border-white/10 text-white/80 pl-2.5 pr-6 outline-none focus:border-white/25 hover:bg-white/10 hover:border-white/20 cursor-pointer transition-colors">
                        {settableRoles.map(r => <option key={r} value={r} className="bg-[#0f1017]">{ROLE_LABELS[r]}</option>)}
                      </select>
                      <ChevronDown className="w-3 h-3 text-white/45 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  ) : (
                    <span title={isLastOwner ? 'The last owner — promote another owner first to change this' : undefined}
                      className="text-[10px] uppercase tracking-wide text-white/40 bg-white/5 border border-white/10 rounded-md px-1.5 h-5 flex items-center">{ROLE_LABELS[m.role] || m.role}</span>
                  )}
                  {canModify && (
                    <button onClick={() => setRemoveTarget(m)} aria-label={`Remove ${m.displayName || m.email}`}
                      className="text-white/40 hover:text-rose-300 hover:bg-white/5 p-1.5 rounded-lg transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Pending invitations" subtitle={pending.length ? `${pending.length} awaiting acceptance` : 'None yet'}>
        {pending.length === 0 ? (
          <div className="text-[11px] text-white/40">No pending invitations.</div>
        ) : (
          <div className="space-y-1.5">
            {pending.map(i => (
              <div key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.02]">
                <div className="min-w-0">
                  <div className="text-sm text-white/85 truncate">{i.email}</div>
                  <div className="text-[11px] text-white/40">invited {timeAgo(i.created_at)}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => copy(inviteUrl(i.token))} className="text-[11px] px-2 h-7 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 inline-flex items-center gap-1 transition-colors"><Link2 className="w-3 h-3" />Copy link</button>
                  <button onClick={() => revoke(i.id)} aria-label="Revoke invitation" className="text-[11px] px-2 h-7 rounded-lg text-white/50 hover:text-rose-300 hover:bg-white/5 inline-flex items-center gap-1 transition-colors"><X className="w-3 h-3" />Revoke</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Redirect old /va-desk links to /my-tasks, preserving the ?ws= workspace query param. */
function RedirectToMyTasks() {
  const location = useLocation();
  return <Navigate to={`/my-tasks${location.search}`} replace />;
}

function AppShell() {
  const { view, theme, loading, membershipsLoaded, currentWorkspaceId, onSignOut, isGuest } = useApp();
  const location = useLocation();

  // Hold the loading state until the per-workspace role is resolved too, so role-aware UI never
  // flashes the wrong role while memberships load (same gating discipline as workspace resolution).
  if (loading || (currentWorkspaceId && !membershipsLoaded)) {
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

  // The user belongs to no workspace — onboarding lives at /onboarding (create your first one;
  // invitations come later). Any other path bounces there so the URL always reflects the state.
  if (!currentWorkspaceId) {
    return (
      <Routes>
        <Route path="/onboarding" element={<OnboardingScreen onSignOut={onSignOut} />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }

  // A Guest's only relevant destinations are My Tasks + DMs; bounce them off any other view (incl. the
  // default dashboard, or a typed/bookmarked URL) to My Tasks. Role is resolved by here (membershipsLoaded).
  if (isGuest && !GUEST_VIEWS.has(view)) {
    return <Navigate to={`${VIEW_TO_PATH.mine}${location.search}`} replace />;
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
        @keyframes fadeSlideOut { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(-6px) scale(0.97); } }
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
        [data-theme="light"] .text-white\\/45, [data-theme="light"] .text-white\\/40, [data-theme="light"] .text-white\\/35 { color: #6a6d79 !important; }
        [data-theme="light"] .text-white\\/30, [data-theme="light"] .text-white\\/25, [data-theme="light"] .text-white\\/20 { color: #6f7280 !important; }
        [data-theme="light"] [class*="placeholder-white"]::placeholder { color: rgba(0,0,0,0.45) !important; }
        [data-theme="light"] .border-white\\/15, [data-theme="light"] .border-white\\/20 { border-color: rgba(0,0,0,0.14) !important; }
        [data-theme="light"] select option { color: #17181c !important; background: #ffffff !important; }
        /* Accent TEXT: dark-mode accents are bright (readable on dark) but wash out on light-tinted
           surfaces — mention pills, the recurrence preview chip, badges, links, the DM "Seen" tick,
           and error text. Darken them for light mode (the heroes are re-exempted below). */
        [data-theme="light"] .text-violet-100, [data-theme="light"] .text-violet-200, [data-theme="light"] .text-violet-300, [data-theme="light"] .text-violet-400, [data-theme="light"] .text-violet-300\\/70, [data-theme="light"] .text-violet-300\\/80, [data-theme="light"] .text-violet-200\\/90, [data-theme="light"] .text-violet-200\\/80, [data-theme="light"] .text-violet-100\\/90 { color: #6d28d9 !important; }
        [data-theme="light"] .text-emerald-200, [data-theme="light"] .text-emerald-300, [data-theme="light"] .text-emerald-400, [data-theme="light"] .text-emerald-300\\/80 { color: #047857 !important; }
        [data-theme="light"] .text-amber-100, [data-theme="light"] .text-amber-200, [data-theme="light"] .text-amber-300 { color: #b45309 !important; }
        [data-theme="light"] .text-sky-300, [data-theme="light"] .text-sky-400 { color: #0369a1 !important; }
        [data-theme="light"] .text-rose-200, [data-theme="light"] .text-rose-300, [data-theme="light"] .text-rose-400, [data-theme="light"] .text-rose-300\\/70, [data-theme="light"] .text-rose-300\\/80, [data-theme="light"] .text-rose-300\\/90, [data-theme="light"] .text-rose-100\\/90 { color: #be123c !important; }
        [data-theme="light"] .hover\\:text-violet-200:hover { color: #6d28d9 !important; }
        [data-theme="light"] .hover\\:text-rose-200:hover, [data-theme="light"] .hover\\:text-rose-300:hover, [data-theme="light"] .hover\\:text-rose-400:hover { color: #be123c !important; }
        /* EXCEPTION: the Private + My Tasks heroes stay DARK in light mode, so their accent eyebrows
           must stay BRIGHT (and a touch brighter, since "ASSIGNED TO ME" read weak). Higher specificity
           than the global accent rules above, so these win inside the heroes. */
        [data-theme="light"] .from-\\[\\#0d2a20\\] .text-emerald-200, [data-theme="light"] .from-\\[\\#0d2a20\\] .text-emerald-300, [data-theme="light"] .from-\\[\\#0d2a20\\] .text-emerald-400 { color: #a7f3d0 !important; }
        [data-theme="light"] .from-\\[\\#1a1530\\] .text-violet-200, [data-theme="light"] .from-\\[\\#1a1530\\] .text-violet-300, [data-theme="light"] .from-\\[\\#1a1530\\] .text-violet-400 { color: #c4b5fd !important; }
        [data-theme="light"] .border-white\\/5, [data-theme="light"] .border-white\\/10, [data-theme="light"] .border-white\\/\\[0\\.06\\], [data-theme="light"] .border-white\\/\\[0\\.08\\] { border-color: rgba(0,0,0,0.08) !important; }
        [data-theme="light"] .bg-white\\/\\[0\\.04\\], [data-theme="light"] .bg-white\\/\\[0\\.03\\], [data-theme="light"] .bg-white\\/\\[0\\.02\\], [data-theme="light"] .bg-white\\/\\[0\\.015\\], [data-theme="light"] .bg-white\\/\\[0\\.005\\], [data-theme="light"] .bg-white\\/5 { background: rgba(0,0,0,0.025) !important; }
        [data-theme="light"] .bg-white\\/\\[0\\.08\\], [data-theme="light"] .bg-white\\/10 { background: rgba(0,0,0,0.06) !important; }
        /* Dropdown active-row + mention-pill accent: a legible violet in light mode (the plain white-alpha wash was near-invisible). */
        [data-theme="light"] .bg-violet-500\\/25, [data-theme="light"] .bg-violet-500\\/20 { background: rgba(124,58,237,0.16) !important; }
        [data-theme="light"] .search-input { background: #ffffff !important; border-color: rgba(0,0,0,0.12) !important; color: #17181c !important; }
        [data-theme="light"] .search-input::placeholder { color: rgba(0,0,0,0.4) !important; }
        [data-theme="light"] .hover\\:bg-white\\/5:hover, [data-theme="light"] .hover\\:bg-white\\/\\[0\\.04\\]:hover, [data-theme="light"] .hover\\:bg-white\\/\\[0\\.06\\]:hover, [data-theme="light"] .hover\\:bg-white\\/\\[0\\.07\\]:hover, [data-theme="light"] .hover\\:bg-white\\/10:hover { background: rgba(0,0,0,0.04) !important; }

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
            <Routes>
              <Route path="/" element={<DashboardView />} />
              <Route path="/kanban" element={<KanbanView />} />
              <Route path="/priority-matrix" element={<MatrixView />} />
              <Route path="/projects" element={<ProjectsView />} />
              <Route path="/schedule" element={<ScheduleView />} />
              <Route path="/my-tasks" element={<MyTasksView />} />
              <Route path="/va-desk" element={<RedirectToMyTasks />} />
              <Route path="/private" element={<PrivateView />} />
              <Route path="/chat" element={<ChatView />} />
              <Route path="/dms" element={<DirectMessagesView />} />
              <Route path="/members" element={<MembersView />} />
              {/* Has a workspace, so onboarding isn't applicable — send it back to the app. */}
              <Route path="/onboarding" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
      <MobileTabs />
      <QuickAdd />
      <CommandPalette />
      <TaskModal />
      <UpgradeModal />
      <PlanPreviewBanner />
    </div>
  );
}
