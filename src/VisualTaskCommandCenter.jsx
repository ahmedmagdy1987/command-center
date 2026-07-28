import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useId, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import {
  LayoutDashboard, KanbanSquare, Grid3x3, FolderKanban, CalendarDays, Lock, UserCog,
  Plus, Search, Command, Sun, Moon, Download, Upload, X, Check,
  Clock, AlertCircle, Flag, Link2, Trash2, Copy, ChevronRight, ChevronDown, ChevronUp,
  CheckCircle2, Calendar, Zap, Timer, MoreHorizontal, Edit3, Filter,
  Flame, TrendingUp, Minimize2, Maximize2, Inbox, PauseCircle, PlayCircle, Sparkles,
  Info, LogOut, Loader2,
  KeyRound, Bell, MessageSquare, MessagesSquare, Send, Mic, Square, Play, Pause, Users, Mail, UserPlus, ArrowRight,
  FileText, Shield, Paperclip, FileImage, User, EyeOff
} from 'lucide-react';
import { tasks as tasksApi, projects as projectsApi, members as membersApi, notifications as notificationsApi, comments as commentsApi, messages as messagesApi, chatReads as chatReadsApi, directMessages as directMessagesApi, workspaces as workspacesApi, workspaceMembers as workspaceMembersApi, invitations as invitationsApi, attachments as attachmentsApi, auth } from './lib/api';
import { supabase } from './lib/supabase';
import { sanitizeTask, uid, nowISO } from './lib/sanitize';
import { resolvePlanId, computeEntitlements, getPreviewPlanId, clearPreviewPlan } from './lib/entitlements';
import { FEATURE_META, PLANS } from './lib/plans';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import AuthShell, { AuthBanner, AuthCTA } from './AuthShell';
import ErrorBoundary from './ErrorBoundary';
import { reportError, logCaught } from './lib/errors';

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
// DELIBERATELY OUTSIDE the semantic token layer in src/styles/tokens.css. This is a CATEGORICAL
// palette — its job is to make people distinguishable from each other, not to express meaning or
// react to the theme. Forcing it through brand/status tokens would collapse seven identities onto
// one hue. It is consumed as inline style (hex + a 14% `soft` tint), never as a class.
// Retuned in Phase 2: the violet (#a78bfa) and fuchsia (#e879f9) entries WERE the old brand
// identity, so a person keyed to one kept the retired palette alive on every avatar. They are
// now periwinkle (brand-adjacent) and pink. The other five are neutral hues and are unchanged;
// what matters here is that the seven stay maximally distinguishable from each other.
const ASSIGNEE_PALETTE = [
  { hex: '#7c8cff', soft: 'rgba(124,140,255,0.14)' },
  { hex: '#34d399', soft: 'rgba(52,211,153,0.14)' },
  { hex: '#f472b6', soft: 'rgba(244,114,182,0.14)' },
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
const PROJECT_PALETTE = ['#7c8cff','#f472b6','#38bdf8','#34d399','#fb923c','#f43f5e','#facc15','#94a3b8','#64748b','#22d3ee','#3dd6b3','#4ade80'];
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

const getUpNextScore = (task) => {
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

// Signed avatar URLs live ~3600s; re-sign AVATAR_REFRESH_MS before that so a face never flashes to
// initials at the TTL boundary. Module-scoped so the signing callbacks' deps are unambiguously stable.
const AVATAR_TTL_MS = 3600 * 1000;
const AVATAR_REFRESH_MS = 300 * 1000;
const AVATAR_NEG_MS = 10 * 60 * 1000;   // backoff before retrying a path that failed to sign

// Avatar signing lives in its OWN context, separate from AppCtx on purpose: the signed-URL map
// changes every time a batch of signs lands, and folding it into the big AppCtx value would re-render
// every useApp() consumer in the app on each batch. Here only Avatar subscribes.
const AvatarSignCtx = createContext({ signed: {}, requestSign: () => {} });
const useAvatarSign = () => useContext(AvatarSignCtx);
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
  const rosterWsRef = useRef(null);   // which workspace `members` belongs to (guards stale refresh results)

  // ---- Avatar signing ------------------------------------------------------------------------
  // The avatars bucket is PRIVATE, so members.avatar_url now holds a storage PATH, not a URL, and a
  // renderable URL must be MINTED per object and EXPIRES. This is the batched signing cache: paths are
  // requested by Avatar components (and eagerly by the roster effect below), collected across a paint,
  // and signed in ONE createSignedUrls call per batch — never one request per face. `exp` is set short
  // of the real 3600s TTL so the refresh interval re-signs before a URL actually dies.
  const [signedAvatars, setSignedAvatars] = useState({});   // path -> { url, exp(ms) }
  const signedAvatarsRef = useRef(signedAvatars);
  useEffect(() => { signedAvatarsRef.current = signedAvatars; }, [signedAvatars]);
  const pendingSignRef = useRef(new Set());
  const signTimerRef = useRef(null);

  // A cache entry is EITHER a live signed URL (`url` set) OR a NEGATIVE entry (`url:null`) meaning
  // "this path could not be signed — object gone, or not visible to me". Negative entries are what
  // stop an unsignable path from being re-requested every tick forever: they carry a backoff `exp`
  // and are honoured by requestAvatarSign, and the refresh interval skips them entirely.
  const flushAvatarSign = useCallback(() => {
    const paths = [...pendingSignRef.current];
    pendingSignRef.current = new Set();
    if (!paths.length) return;
    membersApi.signedAvatarUrls(paths).then(map => {
      const now = Date.now();
      const okExp = now + AVATAR_TTL_MS - AVATAR_REFRESH_MS;
      setSignedAvatars(prev => {
        let changed = false;
        const next = { ...prev };
        for (const p of paths) {
          if (map[p]) { next[p] = { url: map[p], exp: okExp }; changed = true; }
          else {
            // Failed to sign. Write a negative entry ONLY when the state actually moves — a first
            // failure, a previously-positive entry going bad, or a lapsed backoff. An all-already-
            // negative batch leaves `changed` false, so setSignedAvatars returns `prev` and React
            // bails out with NO re-render (this is what the review's Finding 1 needed).
            const cur = prev[p];
            if (!cur || cur.url || cur.exp <= now) { next[p] = { url: null, exp: now + AVATAR_NEG_MS }; changed = true; }
          }
        }
        return changed ? next : prev;
      });
    }).catch(logCaught('avatars.sign'));
  }, []);

  // Ask for a signed URL for one path. Deduped + debounced into a single batch per paint. `force`
  // (the refresh interval, and Avatar's onError) re-mints a live-but-expired URL — but it must NOT
  // punch through a NEGATIVE backoff, or a permanently-unsignable path loops forever.
  const requestAvatarSign = useCallback((path, force = false) => {
    if (!path || /^(https?:|blob:|data:)/.test(path)) return;   // already a usable URL, or a blob preview
    const cur = signedAvatarsRef.current[path];
    if (cur && cur.exp > Date.now()) {
      if (cur.url && !force) return;   // fresh positive URL — nothing to do unless forced
      if (!cur.url) return;            // negative backoff — never force through it
    }
    if (pendingSignRef.current.has(path)) return;
    pendingSignRef.current.add(path);
    clearTimeout(signTimerRef.current);
    signTimerRef.current = setTimeout(flushAvatarSign, 40);
  }, [flushAvatarSign]);

  // Eagerly sign every avatar path in the roster + my own, so the common case is one request rather
  // than a flurry of per-Avatar onMount requests (which would still batch, but flash initials first).
  useEffect(() => {
    const paths = [];
    for (const m of members) if (m?.avatarUrl) paths.push(m.avatarUrl);
    if (currentMember?.avatar_url) paths.push(currentMember.avatar_url);
    paths.forEach(p => requestAvatarSign(p));
  }, [members, currentMember, requestAvatarSign]);

  // Proactive refresh: re-sign POSITIVE entries within the refresh window of expiry, so a face never
  // flashes to initials at the TTL boundary. `e.url &&` is load-bearing — it skips negative entries so
  // a dead path is never re-signed on a timer (the review's Finding 1). Bounded to rendered paths.
  useEffect(() => {
    const id = setInterval(() => {
      const soon = Date.now() + AVATAR_REFRESH_MS;
      for (const [p, e] of Object.entries(signedAvatarsRef.current)) if (e.url && e.exp < soon) requestAvatarSign(p, true);
    }, 60 * 1000);
    return () => { clearInterval(id); clearTimeout(signTimerRef.current); };
  }, [requestAvatarSign]);
  // Tasks mid-exit-animation (id present -> the card renders its fade/slide-out before actual removal).
  const [exitingIds, setExitingIds] = useState(() => new Set());
  // Project cards mid-exit-animation (same two-phase pattern as tasks).
  const [exitingProjectIds, setExitingProjectIds] = useState(() => new Set());
  const [profileUserId, setProfileUserId] = useState(null);   // whose profile the ProfileView shows (null = closed)
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
  /**
   * Transient toast. `action` (optional) is `{ label, onClick }` and renders as a button inside the
   * toast — added 2026-07-19 so a destructive-but-reversible action can offer UNDO at the moment it
   * happens, which is the only point the user is still thinking about it. Running the action also
   * dismisses the toast, so it cannot be clicked twice.
   */
  const showToast = useCallback((message, tone = 'error', action = null) => {
    const id = uid();
    setAppToasts(p => [...p, { id, message, tone, action }]);
    // Longer window when there is an action: 4.5s is fine to READ a message but tight to notice an
    // Undo, decide, and hit it.
    setTimeout(() => setAppToasts(p => p.filter(x => x.id !== id)), action ? 8000 : 4500);
  }, []);
  const chatViewRef = useRef(view);
  useEffect(() => { chatViewRef.current = view; }, [view]);
  // Advance my team-chat read cursor. SERVER-SIDE since 20260719134628 (`chat_reads`), replacing the
  // per-device `cc_chat_last_seen:<wsId>` localStorage key — which was invisible to other members
  // (so no read receipts were possible), wrong on a second device, and lost on a machine wipe.
  // Still per-workspace, for the same reason the old key was: one global cursor would mark workspace
  // B's older-but-unseen messages read just because you opened chat in A.
  // `coverAt` is the triggering message's SERVER timestamp when we have one — see chatReads.markRead
  // for why the client's own now() is not safe here. Fire-and-forget: the badge zeroes optimistically
  // and the DB clamps a stale or out-of-order write, so a failed cursor write is never destructive.
  const markChatRead = useCallback((coverAt) => {
    setChatUnread(0);
    if (!currentWorkspaceId) return;
    chatReadsApi.markRead(currentWorkspaceId, coverAt).catch(logCaught('chat.markRead'));
  }, [currentWorkspaceId]);

  // Recompute the team-chat badge from the SERVER cursor, for boot and workspace-switch. Deliberately
  // NOT on the context: the only other plausible caller was ChatView's "delete for me", and that one
  // must not recompute (see the note in hideForMe) — so exposing this would only invite the race the
  // `viewing` guard below exists to prevent.
  const chatUnreadWsRef = useRef(currentWorkspaceId);
  useEffect(() => { chatUnreadWsRef.current = currentWorkspaceId; }, [currentWorkspaceId]);
  const refreshChatUnread = useCallback(async () => {
    const me = session?.user?.id;
    const ws = currentWorkspaceId;
    if (!me || !ws) return;
    try {
      const rs = await chatReadsApi.reads(ws);
      const since = rs.find(r => r.userId === me)?.lastReadAt || null;
      const n = await messagesApi.unreadCount(since, ws);
      // Drop a late resolve that lost a race with a workspace switch — otherwise workspace A's count
      // lands on workspace B's badge.
      if (chatUnreadWsRef.current !== ws) return;
      // Badge-race fix, the exact twin of refreshDms' `viewing` guard: while the channel is the view
      // being looked at, markChatRead has already zeroed the badge optimistically — don't let the
      // lagging server value re-inflate it. This matters MORE than it did for the old localStorage
      // cursor, which was written synchronously in the effect body and so was always already visible
      // to this read. The cursor upsert is now behind a list fetch AND a getSession, while this path
      // is a chat_reads SELECT plus a chat_unread_count — so `since` here is reliably the PRE-OPEN
      // cursor, and without the guard the stale count usually lands LAST and wins.
      if (chatViewRef.current === 'chat') return;
      setChatUnread(n);
    } catch (e) { logCaught('chat.unreadCount')(e); }
  }, [session?.user?.id, currentWorkspaceId]);

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
    } catch (e) { reportError(e, 'dms.load'); }
  }, [currentWorkspaceId, userId]);

  const markDmRead = useCallback(async (conversationId, coverAt) => {
    if (!conversationId) return;
    setDmConversations(prev => prev.map(c => c.id === conversationId ? { ...c, unread: 0 } : c));
    try { await directMessagesApi.markRead(conversationId, coverAt); } catch (e) { reportError(e, 'dms.markRead'); }
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
        reportError(err, 'workspace.resolve');
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
        const [t, p, s] = await Promise.all([tasksApi.list(currentWorkspaceId), projectsApi.list(currentWorkspaceId), tasksApi.stats(currentWorkspaceId).catch(logCaught('tasks.stats', () => null))]);
        if (!mounted) return;
        setTasks(t);
        setProjects(p);
        setWorkspaceStats(s);
      } catch (err) {
        reportError(err, 'workspace.load');
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
    const t = setTimeout(() => { tasksApi.stats(currentWorkspaceId).then(setWorkspaceStats).catch(logCaught('tasks.stats refresh')); }, 500);
    return () => clearTimeout(t);
  }, [currentWorkspaceId, tasks]);

  // Load the current workspace's members for the assignee picker + member-aware views/labels.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let on = true;
    rosterWsRef.current = currentWorkspaceId;
    workspaceMembersApi.listForWorkspace(currentWorkspaceId)
      .then(m => { if (on) setMembers(m); })
      .catch(e => reportError(e, 'workspace.members'));
    // Clear on switch/unmount so a workspace change can't briefly show the prior workspace's roster
    // (mirrors the tasks/projects reset in the data-load effect). In-place reloads go through
    // refreshMembers below, which REPLACES the roster without ever blanking it.
    return () => { on = false; setMembers([]); };
  }, [currentWorkspaceId]);

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

  // Live unread badge for chat: count messages newer than my SERVER-SIDE read cursor (chat_reads)
  // and bump it on new messages from others while they're not viewing the channel.
  // A member with no cursor row yet resolves to `since = null`, and the RPC then counts the whole
  // visible channel — the same thing the old code did when the localStorage key was missing.
  useEffect(() => {
    const me = session?.user?.id;
    if (!me || !currentWorkspaceId) return;
    let on = true;
    // Deferred so the initial count isn't a synchronous setState in the effect body — the same
    // house pattern as the typing-indicator effect above. (refreshChatUnread only setStates after
    // two awaits, so this is already true at runtime; the deferral is what makes it true at the
    // CALL SITE, which is what the lint rule reads.)
    const t = setTimeout(refreshChatUnread, 0);
    const unsub = messagesApi.subscribe(({ type, message }) => {
      if (type !== 'INSERT' || !message || !on) return;
      if (message.senderId === me) return;
      if (chatViewRef.current === 'chat') return;   // viewing -> ChatView keeps it read
      setChatUnread(n => n + 1);
    }, 'messages-unread', currentWorkspaceId);
    return () => { on = false; clearTimeout(t); unsub(); };
  }, [session?.user?.id, currentWorkspaceId, refreshChatUnread]);

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
      reportError(e, `tasks.reconcile (${reason})`);
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
        // Resolved, not hardcoded — see defaultProjectId. `...partial` still wins when the caller
        // names a project; this is only the fallback for callers that don't.
        project: defaultProjectId(projects, 'other'),
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
      reportError(err, 'tasks.add');
      setTasks(prev => prev.filter(t => t.id !== optimistic.id));
      showToast("Couldn't add the task. Please try again.");
    }
  }, [session, currentWorkspaceId, showToast, projects]);

  const updateTask = useCallback(async (id, patch) => {
    setTasks(prev => prev.map(t => t.id === id ? {
      ...t, ...patch,
      updatedAt: nowISO(),
      completedAt: patch.status === 'done' ? (t.completedAt || nowISO()) : (patch.status && patch.status !== 'done' ? null : t.completedAt),
    } : t));
    try {
      await tasksApi.update(id, patch);
    } catch (err) {
      reportError(err, 'tasks.update');
      // Reconcile within the CURRENT workspace only — a bare list() would pull tasks from every
      // workspace the user belongs to into the active view (RLS-safe, but wrong scope on screen).
      // Also re-sync the open modal so it doesn't keep showing an edit the server rejected.
      tasksApi.list(currentWorkspaceId).then(fresh => { setTasks(fresh); setEditingTask(et => et ? (fresh.find(t => t.id === et.id) ?? et) : et); }).catch(logCaught('tasks.reconcile after failed update'));
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
      attachmentsApi.removeAllForTask(id).catch(logCaught('attachments.removeAllForTask')).finally(() => {
        tasksApi.delete(id).catch(err => {
          reportError(err, 'tasks.delete');
          tasksApi.list(currentWorkspaceId).then(setTasks).catch(logCaught('tasks.reconcile after failed delete'));   // reconcile with server on failure
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
      reportError(err, 'projects.update');
      projectsApi.list(currentWorkspaceId).then(p => setProjects(p)).catch(logCaught('projects.reconcile after failed update'));
      showToast("Couldn't save the project change — reverted.");
    }
  }, [currentWorkspaceId, showToast]);

  // Two-phase delete via the sanctioned delete_project RPC: fade the card out (~180ms), then run the
  // cascade/unassign and refetch (both tasks and projects changed server-side). Reduced-motion ->
  // immediate. mode: 'cascade' (owner: delete tasks too) | 'unassign' (owner+admin: re-file to reassignTo).
  const deleteProject = useCallback((id, mode, reassignTo) => {
    const reconcile = () => Promise.all([tasksApi.list(currentWorkspaceId), projectsApi.list(currentWorkspaceId)])
      .then(([t, p]) => { setTasks(t); setProjects(p); }).catch(logCaught('projects.reconcile after delete'));
    const finish = async () => {
      setProjects(p => p.filter(x => x.id !== id));
      setExitingProjectIds(p => { const n = new Set(p); n.delete(id); return n; });
      try {
        await projectsApi.deleteViaRpc(id, currentWorkspaceId, mode, reassignTo);
        await reconcile();
      } catch (err) {
        reportError(err, 'projects.delete');
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
      reportError(err, 'tasks.duplicate');
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
      reportError(err, 'tasks.subtasks update');
      // Reconcile to server on failure — including the open modal, which otherwise keeps the stale checklist.
      tasksApi.list(currentWorkspaceId).then(fresh => { setTasks(fresh); setEditingTask(et => et ? (fresh.find(t => t.id === et.id) ?? et) : et); }).catch(logCaught('tasks.reconcile after failed subtask update'));
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
    catch (err) { reportError(err, 'tasks.import'); showToast("Couldn't import those tasks. Please try again."); }
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
    } catch (err) { reportError(err, 'invitations.pending'); }
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

  // Reload the current workspace's roster (after a role change / removal / profile edit) AND the
  // caller's own memberships (so myRole / canManageMembers update if they changed their own role).
  // STALE-WHILE-REFETCHING, not blank-then-fetch: the old reload-key approach re-ran the roster
  // effect, whose cleanup emptied `members` for the whole round-trip — every identity surface
  // degraded to silhouettes / 'Former member' (permanently, if the fetch failed). It also resolves
  // only AFTER the roster is actually updated, so callers like ProfileModal.save can await real
  // propagation. rosterWsRef drops a late result that lands after a workspace switch.
  const refreshMembers = useCallback(async () => {
    const ws = currentWorkspaceId;
    try {
      const [roster, mine] = await Promise.all([
        ws ? workspaceMembersApi.listForWorkspace(ws) : Promise.resolve(null),
        workspaceMembersApi.listMine(),
      ]);
      if (roster && rosterWsRef.current === ws) setMembers(roster);
      setMemberships(mine);
    } catch (e) { reportError(e, 'memberships.refresh'); }
  }, [currentWorkspaceId]);

  // Resolve an assignee id -> { id, label, hex, soft, initials } for chips/labels. 'Me' for self,
  // 'Unassigned' (neutral) for null, display name otherwise. Color is deterministic per user id.
  const resolveAssignee = useCallback((assigneeId) => {
    if (!assigneeId) return { id: null, known: false, label: 'Unassigned', hex: UNASSIGNED_STYLE.hex, soft: UNASSIGNED_STYLE.soft, initials: '·', avatarUrl: null, statusEmoji: '', statusText: '' };
    const m = members.find(x => x.userId === assigneeId);
    // `known: false` = no roster row. For a full member that means the person LEFT ('Former member');
    // a guest's roster is row-scoped server-side, so for them absence proves nothing — keep 'Member'.
    // Avatar call sites gate on `known` and pass '' so the SILHOUETTE renders — the old fallback
    // initialled to "ME", indistinguishable from your own 'Me' disc in the palette/receipts.
    const name = m?.displayName || m?.email || (isGuest ? 'Member' : 'Former member');
    const c = assigneeColor(assigneeId);
    return { id: assigneeId, known: !!m, label: assigneeId === userId ? 'Me' : name, hex: c.hex, soft: c.soft, initials: initialsOf(name),
      avatarUrl: m?.avatarUrl || null, statusEmoji: m?.statusEmoji || '', statusText: m?.statusText || '' };
  }, [members, userId, isGuest]);

  /**
   * The ONE identity lookup every surface uses: a roster row -> a renderable person. Returns null for
   * someone who isn't in the current workspace roster (a former member), so callers degrade gracefully
   * instead of rendering an empty shell. email/bio come back NULL for a guest viewer — the roster RPC
   * withholds them server-side — so the profile view simply hides those rows rather than special-casing.
   */
  const personOf = useCallback((personId) => {
    if (!personId) return null;
    const m = members.find(x => x.userId === personId);
    if (!m) return null;
    return {
      id: personId,
      name: m.displayName || m.email || 'Member',
      email: m.email || null,
      role: m.role,
      avatarUrl: m.avatarUrl || null,
      statusEmoji: m.statusEmoji || '',
      statusText: m.statusText || '',
      bio: m.bio || null,
      isSelf: personId === userId,
    };
  }, [members, userId]);

  // Profile view: any identity surface calls openProfile(id); ONE <ProfileView> is mounted in AppShell.
  const openProfile = useCallback((personId) => { if (personId) setProfileUserId(personId); }, []);
  const closeProfile = useCallback(() => setProfileUserId(null), []);

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
    members, meId: userId, resolveAssignee, personOf, refreshMembers,
    profileUserId, openProfile, closeProfile,
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
    members, userId, resolveAssignee, personOf, refreshMembers,
    profileUserId, openProfile, closeProfile,
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
  // Separate memo so a sign batch re-renders only Avatars, not every useApp() consumer.
  const avatarSignValue = useMemo(() => ({ signed: signedAvatars, requestSign: requestAvatarSign }),
    [signedAvatars, requestAvatarSign]);

  return (
    <AppCtx.Provider value={value}>
     <AvatarSignCtx.Provider value={avatarSignValue}>
      {children}
      {createPortal(
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-[200] flex flex-col items-center gap-2 pointer-events-none w-[calc(100vw-2rem)] max-w-sm">
          {appToasts.map(tt => (
            <div key={tt.id} style={{ animation: 'slideUp .2s ease' }}
              className={cx('pointer-events-auto w-full flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur',
                tt.tone === 'error' ? 'border-danger/25 bg-danger/10 text-danger-text' : 'border-line bg-surface-raised/90 text-secondary')}>
              {tt.tone === 'error' ? <AlertCircle className="w-4 h-4 shrink-0 mt-px" /> : <Info className="w-4 h-4 shrink-0 mt-px" />}
              <span className="flex-1 break-words">{tt.message}</span>
              {tt.action && (
                <button
                  onClick={() => { setAppToasts(p => p.filter(x => x.id !== tt.id)); tt.action.onClick?.(); }}
                  className="shrink-0 font-semibold underline underline-offset-2 text-brand-text hover:text-brand-text-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover/70 rounded px-0.5">
                  {tt.action.label}
                </button>
              )}
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
     </AvatarSignCtx.Provider>
    </AppCtx.Provider>
  );
}

/* =================================================================================
   SHARED UI PRIMITIVES
================================================================================= */
const cx = (...xs) => xs.filter(Boolean).join(' ');

/**
 * The project id a NEW task should default to, resolved against the workspace's REAL projects.
 *
 * Never hardcode a seed id. `tasks.project` is free text with NO foreign key (see CLAUDE.md,
 * Bundle 3), so an id that does not resolve is accepted silently and the task renders with no
 * project chip — unfiled, with nothing to indicate anything went wrong. The seed ids 'other' and
 * 'personal' were assumed to exist everywhere and DO NOT: checked live 2026-07-19, no workspace has
 * 'other' and two of three lack 'personal'.
 *
 * Prefers `preferred` when it genuinely exists (so a workspace that DOES still have the seed project
 * keeps its familiar default), then either seed, then simply the first project. Returns '' only when
 * the workspace has no projects at all — the caller must handle that, because there is no honest
 * default in that case.
 */
const defaultProjectId = (projects, preferred) => {
  const has = (id) => !!id && (projects || []).some(p => p.id === id);
  if (has(preferred)) return preferred;
  if (has('other')) return 'other';
  if (has('personal')) return 'personal';
  return (projects || [])[0]?.id || '';
};

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

/** The assignee pill. Swapping its 1.5px dot for a real face is the highest-leverage change in the app:
 *  task cards, the TaskModal header, dashboard MiniRows, Top-3 and the command palette all render through
 *  here. Unassigned passes an empty name on purpose so Avatar shows its silhouette rather than initialling
 *  the word "Unassigned". Theme-aware for the same reason Avatar is — `soft` + `hex` text washes out on
 *  light, so light mode uses near-black text on a faint tint. NOT wrapped in PersonButton: three of its
 *  four call sites already sit inside a clickable task card, and a button-in-button is invalid DOM. */
function AssigneeChip({ assigneeId, showLabel = true, size = 'sm' }) {
  const { resolveAssignee, theme } = useApp();
  const a = resolveAssignee(assigneeId);
  const light = theme === 'light';
  const dims = size === 'sm' ? 'h-5 text-micro' : 'h-6 text-xs';
  const face = size === 'sm' ? 14 : 18;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full font-medium tracking-wide pl-0.5', dims, showLabel ? (size === 'sm' ? 'pr-2' : 'pr-2.5') : 'pr-0.5')}
      style={{ background: light ? `${a.hex}1f` : a.soft, color: light ? '#0b0b12' : a.hex, border: `1px solid ${a.hex}33` }}>
      <Avatar name={a.known ? a.label : ''} userId={a.id} photoUrl={a.avatarUrl} size={face} />
      {/* When the label is hidden the chip is a BARE avatar — and every branch of Avatar is
          aria-hidden (photo alt="", initials, silhouette), so without this the assignee is announced
          as nothing at all and an assigned task is indistinguishable from an unassigned one. That
          regressed on 2026-07-19: aria-hidden was added to Avatar's initials branch on the claim that
          "every call site pairs it with a real name", which was true of the other three call sites but
          NOT of this one. sr-only rather than a title/aria-label on the span: the chip sits inside a
          clickable task card, and a title here would also fire as a mouse tooltip over the card. */}
      {showLabel ? a.label : <span className="sr-only">{`Assigned to ${a.label}`}</span>}
    </span>
  );
}

function Badge({ children, tone = 'neutral', icon: Icon }) {
  const tones = {
    neutral: 'bg-fill text-muted border-line',
    overdue: 'bg-danger/15 text-danger-text border-danger/30',
    today:   'bg-warning/15 text-warning-text border-warning/30',
    soon:    'bg-info/15 text-info-text border-info/30',
    later:   'bg-fill text-muted border-line',
    block:   'bg-danger/15 text-danger-text border-danger/30',
    success: 'bg-success/15 text-success-text border-success/30',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 h-5 text-micro font-medium', tones[tone])}>
    {Icon && <Icon className="w-3 h-3" />}{children}
  </span>;
}

function IconButton({ icon: Icon, label, active, onClick }) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className={cx(
        'inline-flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200',
        'border border-line-subtle hover:border-line',
        active ? 'bg-fill-strong text-primary' : 'bg-fill-subtle text-muted hover:bg-fill hover:text-primary',
      )}>
      <Icon className="w-4 h-4" />
    </button>
  );
}

function Tooltip({ children, content, className = 'inline-flex' }) {
  return (
    <span className={cx('relative group', className)}>
      {children}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 -top-9 whitespace-nowrap text-micro font-medium px-2 py-1 rounded-md bg-tooltip border border-tooltip-fg/15 text-tooltip-fg opacity-0 group-hover:opacity-100 transition-opacity z-50">
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
    <div className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_.15s_ease]" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-line bg-surface-raised shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-primary font-display">Change password</h3>
          <button onClick={onClose} className="text-muted hover:text-primary"><X className="w-4 h-4" /></button>
        </div>

        {success ? (
          <div className="py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-success/20 border border-success/30 flex items-center justify-center mx-auto mb-3">
              <Check className="w-6 h-6 text-success-text" strokeWidth={3} />
            </div>
            <div className="text-sm text-primary font-medium">Password changed successfully</div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5 block">Current password</label>
              <input type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoFocus
                className="w-full bg-input border border-line rounded-lg px-3 h-10 text-sm text-primary outline-none focus:border-brand-hover/50" />
            </div>
            <div>
              <label className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5 block">New password</label>
              <input type="password" value={next} onChange={e => setNext(e.target.value)} required minLength={10}
                placeholder="At least 10 characters"
                className="w-full bg-input border border-line rounded-lg px-3 h-10 text-sm text-primary placeholder-faint outline-none focus:border-brand-hover/50" />
            </div>
            <div>
              <label className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5 block">Confirm new password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                className="w-full bg-input border border-line rounded-lg px-3 h-10 text-sm text-primary outline-none focus:border-brand-hover/50" />
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger-text">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} disabled={loading}
                className="flex-1 h-10 rounded-lg border border-line bg-fill hover:bg-fill-strong text-sm text-secondary font-medium transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={loading || !current || !next || !confirm}
                className="flex-1 h-10 rounded-lg bg-brand hover:bg-brand-hover text-brand-fg font-semibold text-sm hover:shadow-lg hover:shadow-brand/15 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2">
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
        'border-line-subtle bg-gradient-to-br from-fill to-fill-subtle',
        'hover:border-line hover:from-fill-strong hover:to-fill',
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
          {/* Unchecked ring via border-line-strong (class, not inline rgba): same 20% white in dark, but the
              light sheet remaps the CLASS to visible black-alpha — inline stayed white-on-white in light. */}
          <button
            onClick={(e) => { e.stopPropagation(); updateTask(task.id, { status: done ? 'inbox' : 'done' }); }}
            className="shrink-0 w-4 h-4 rounded-full border-2 border-line-strong flex items-center justify-center transition-all"
            style={{ borderColor: done ? priority.hex : undefined, background: done ? priority.hex : 'transparent' }}
          >
            {done && <Check className="w-2.5 h-2.5" style={{ color: 'rgb(var(--color-canvas))' }} strokeWidth={3} />}
          </button>
          <PriorityDot priority={task.priority} />
          {isPrivate && <span title="Private: visible only to the creator and assignee"><Lock className="w-3 h-3 text-faint shrink-0" /></span>}
          {task.blocked && <PauseCircle className="w-3.5 h-3.5 text-danger-text shrink-0" />}
        </div>
        {showAssignee && <AssigneeChip assigneeId={task.assigneeId} showLabel={!compact} size="sm" />}
      </div>

      <div className={cx('font-medium leading-snug text-primary mb-2', done && 'line-through text-muted', compact ? 'text-sm' : 'text-[15px]')}>
        {task.title}
      </div>

      {!compact && task.description && (
        <p className="text-xs text-muted leading-relaxed mb-3 line-clamp-2">{task.description}</p>
      )}

      {totalSub > 0 && !compact && (
        <div className="mb-3">
          <div className="h-1 bg-fill rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${(doneCount/totalSub)*100}%`, background: `linear-gradient(90deg, ${priority.hex}, ${assignee.hex})` }} />
          </div>
          <div className="text-micro text-faint mt-1 font-medium tracking-wide">{doneCount}/{totalSub} subtasks</div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {project && (
          <span className="inline-flex items-center gap-1 text-micro font-medium text-muted">
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
          <span key={t} className="text-micro text-faint">#{t}</span>
        ))}
        {!compact && task.createdBy && (
          /* A face, but NOT a PersonButton: the whole card is already a click target for opening the task. */
          <span className="text-micro text-faint inline-flex items-center gap-1">
            · by
            <Avatar name={resolveAssignee(task.createdBy).known ? creatorLabel(task.createdBy) : ''} userId={task.createdBy} photoUrl={resolveAssignee(task.createdBy).avatarUrl} size={12} />
            {creatorLabel(task.createdBy)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Render text with @mentions shown as styled pills. Matches the FULL display name of any workspace
 *  member (longest-first) so "@Ahmed Magdy" highlights as one pill, not just "@Ahmed". Cosmetic — the
 *  mention payload is the uuid[]. */
function MentionText({ text, mentions }) {
  const { members, openProfile } = useApp();
  const s = String(text || '');
  // Pill ONLY names that were actually mentioned (the row's mentions uuid[]) — not any @Name that happens
  // to match a member. So free-typed "@Ahmed" (which fires no notification) and DM bodies (no mentions
  // array / no picker) don't render a misleading pill.
  if (!s.includes('@') || !Array.isArray(mentions) || !mentions.length) return s;
  const mentionSet = new Set(mentions);
  const mentioned = (members || []).filter(m => mentionSet.has(m.userId) && (m.displayName || m.email));
  const names = mentioned.map(m => m.displayName || m.email).sort((a, b) => b.length - a.length);
  if (!names.length) return s;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(@(?:' + names.map(esc).join('|') + '))', 'g');
  // '@Name' -> userId, so the pill can open that person's profile. The pill (not an inline avatar) is the
  // right affordance here: a face mid-sentence wrecks line-height and reads as noise.
  const idByAt = new Map(mentioned.map(m => ['@' + (m.displayName || m.email), m.userId]));
  return s.split(re).map((p, i) => idByAt.has(p)
    ? <button key={i} type="button" title="View profile"
        onClick={e => { e.stopPropagation(); e.preventDefault(); openProfile(idByAt.get(p)); }}
        className="rounded px-1 -mx-0.5 bg-brand/20 text-brand-text font-medium hover:bg-brand/30 transition-colors">{p}</button>
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
        <div className="fixed z-[80] max-h-52 overflow-y-auto rounded-xl border border-line bg-surface-raised shadow-2xl py-1"
          style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}>
          <div className="px-3 pt-1 pb-1.5 text-micro font-medium uppercase tracking-widest text-faint">Mention someone</div>
          {filtered.map((m, i) => (
            <button key={m.userId} type="button" onMouseDown={(ev) => { ev.preventDefault(); pick(m); }} onMouseEnter={() => setActive(i)}
              className={cx('w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left', i === active ? 'bg-brand/25 text-primary' : 'text-primary')}>
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
      .catch(logCaught('members.list for comments'));
    return () => { mounted = false; };
  }, []);

  // Load this task's comments + subscribe to live changes while the modal is open.
  useEffect(() => {
    if (!taskId) return;
    let mounted = true;
    setLoading(true);
    commentsApi.list(taskId)
      .then(list => { if (mounted) setItems(list); })
      .catch(err => reportError(err, 'comments.list'))
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
      reportError(err, 'comments.add');
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
    } catch (err) { reportError(err, 'comments.edit'); }
  };

  const remove = async (id) => {
    setItems(prev => prev.filter(c => c.id !== id));
    try { await commentsApi.remove(id); }
    catch (err) { reportError(err, 'comments.delete'); commentsApi.list(taskId).then(setItems).catch(logCaught('comments.reconcile')); }
  };

  return (
    <div className="pt-5 border-t border-line-subtle">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-muted" />
        <div className="text-micro font-medium uppercase tracking-widest text-faint">Discussion</div>
        {items.length > 0 && <div className="text-micro text-faint">{items.length}</div>}
      </div>

      <div ref={scrollRef} className="max-h-72 overflow-y-auto no-scrollbar space-y-3 pr-1">
        {loading ? (
          <div className="py-4 text-center text-meta text-faint">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-meta text-faint">No comments yet. Start the discussion.</div>
        ) : items.map(c => {
          const mine = c.authorId === userId;
          const edited = c.updatedAt && c.createdAt && c.updatedAt !== c.createdAt;
          return (
            <div key={c.id} className="group">
              <div className="flex items-center gap-2 mb-1">
                {/* `people` is members.list() (select('*')) so avatar_url/status_emoji are already loaded. */}
                <PersonButton personId={c.authorId} className="gap-1.5 min-w-0" title={mine ? 'Your profile' : `View ${nameOf(c.authorId)}'s profile`}>
                  <Avatar name={nameOf(c.authorId)} userId={c.authorId} photoUrl={people[c.authorId]?.avatar_url} size={20} />
                  <span className="text-xs font-medium text-secondary truncate">
                    {people[c.authorId]?.status_emoji && <span className="mr-1">{people[c.authorId].status_emoji}</span>}
                    {mine ? 'You' : nameOf(c.authorId)}
                  </span>
                </PersonButton>
                <span className="text-micro text-faint shrink-0">{timeAgo(c.createdAt)}{edited ? ' · edited' : ''}</span>
                {mine && editId !== c.id && (
                  <span className="ml-auto flex items-center gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                    <button onClick={() => { setEditId(c.id); setEditText(c.body); }} className="text-micro text-faint hover:text-secondary">Edit</button>
                    <button onClick={() => remove(c.id)} className="text-micro text-faint hover:text-danger-text">Delete</button>
                  </span>
                )}
              </div>
              {editId === c.id ? (
                <div className="space-y-1.5">
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(c.id); } else if (e.key === 'Escape') setEditId(null); }}
                    className="w-full bg-fill border border-line rounded-lg px-3 py-2 text-xs text-primary outline-none focus:border-brand-hover/50 resize-none" />
                  <div className="flex items-center gap-3">
                    <button onClick={() => saveEdit(c.id)} className="text-micro font-semibold text-brand-text hover:text-brand-text-hover">Save</button>
                    <button onClick={() => setEditId(null)} className="text-micro text-faint hover:text-secondary">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-secondary leading-relaxed whitespace-pre-wrap break-words rounded-lg border border-line-subtle bg-fill-subtle px-3 py-2"><MentionText text={c.body} mentions={c.mentions} /></div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-end gap-2 mt-3">
        <MentionTextarea value={text} onChange={setText} onMentionsChange={setMentions} members={members} meId={userId} onEnter={send} rows={2}
          placeholder="Write a comment…  (@ to mention, Enter to send)"
          className="bg-fill border border-line rounded-lg px-3 py-2 text-xs text-primary placeholder-faint outline-none focus:border-brand-hover/50 resize-none" />
        <button onClick={send} disabled={!text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-xs font-semibold bg-inverse text-inverse-fg hover:bg-inverse/90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity shrink-0">
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
    attachmentsApi.signedUrl(attachment.storagePath, 3600).then(u => { if (on) setUrl(u); }).catch(logCaught('attachments.signedUrl', () => { if (on) setFailed(true); }));
    return () => { on = false; };
  }, [attachment.storagePath, isImg]);
  if (isImg && url && !failed) {
    return <img src={url} alt="" className="w-10 h-10 rounded-md object-cover border border-line shrink-0" />;
  }
  const Icon = isImg ? FileImage : FileText;
  return (
    <div className="w-10 h-10 rounded-md border border-line bg-fill flex items-center justify-center shrink-0">
      <Icon className="w-4 h-4 text-muted" />
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
    attachmentsApi.list(taskId).then(setItems).catch(logCaught('attachments.list', () => setItems([])));
  }, [taskId]);
  // Guarded mount load — don't setState after unmount / after the taskId changed.
  useEffect(() => {
    let on = true;
    attachmentsApi.list(taskId).then(l => { if (on) setItems(l); }).catch(logCaught('attachments.list', () => { if (on) setItems([]); }));
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
        <div className="text-micro font-medium uppercase tracking-widest text-faint flex items-center gap-1.5"><Paperclip className="w-3 h-3" />Attachments</div>
        {count > 0 && <div className="text-micro text-faint font-medium tabular-nums">{count}/{attachmentsApi.MAX_PER_TASK}</div>}
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
          className={cx('mb-2 rounded-lg border border-dashed px-3 py-3 text-center cursor-pointer transition-colors outline-none focus-visible:border-brand-hover/60 focus-visible:bg-brand-hover/5',
            dragActive ? 'border-brand-hover/60 bg-brand-hover/5' : 'border-line bg-fill-subtle hover:bg-fill')}
        >
          <div className="flex items-center justify-center gap-2 text-xs text-muted">
            {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</> : <><Upload className="w-3.5 h-3.5" />Drop files or click to upload</>}
          </div>
          <div className="mt-0.5 text-micro text-faint">Images, PDF, docs · up to 25 MB each</div>
          <input ref={fileRef} type="file" multiple className="hidden"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            onChange={onPick} />
        </div>
      )}

      {error && (
        <div className="mb-2 flex items-start gap-1.5 text-meta text-danger-text/90">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /><span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss" className="text-faint hover:text-secondary shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {items === null ? (
        <div className="inline-flex items-center gap-2 text-meta text-faint"><Loader2 className="w-3 h-3 animate-spin" />Loading…</div>
      ) : count === 0 ? (
        !canEdit && <div className="text-xs text-faint italic">No attachments.</div>
      ) : (
        <div className="space-y-1.5">
          {items.map(a => (
            <div key={a.id} className="group flex items-center gap-2.5 rounded-lg border border-line bg-fill px-2.5 py-1.5">
              <AttachmentThumb attachment={a} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-primary truncate">{a.filename}</div>
                <div className="text-micro text-faint truncate">
                  {a.sizeBytes != null && `${attachHumanSize(a.sizeBytes)} · `}{creatorLabel(a.uploadedBy)} · {new Date(a.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button onClick={() => download(a)} aria-label={`Download ${a.filename}`}
                className="shrink-0 text-faint hover:text-secondary transition-colors p-1"><Download className="w-4 h-4" /></button>
              {canDelete(a) && (
                <button onClick={() => setConfirmDel(a)} aria-label={`Delete ${a.filename}`}
                  className="shrink-0 text-faint hover:text-danger-text focus:text-danger-text transition-all p-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"><Trash2 className="w-4 h-4" /></button>
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
  // `requestUpgrade` + `useEntitlements()` were dropped here on 2026-07-19: TaskModal's ONLY
  // entitlement gate was the recurringTasks one on the Repeat button, and that feature was removed
  // (see the RECURRENCE note). Nothing else in this modal is plan-gated.
  const { editingTask, setEditingTask, updateTask, deleteTask, duplicateTask, projects, toggleSubtask, addSubtask, removeSubtask, moveSubtask, members, meId, isOwner, isAdmin, resolveAssignee, closeEditing, creatorLabel } = useApp();
  const t = editingTask;
  const [newSub, setNewSub] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => { setNewSub(''); }, [editingTask?.id]);

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
    <div className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-6 animate-[fadeIn_.15s_ease]" onClick={closeEditing}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Edit task" className="w-full sm:max-w-2xl max-h-screen sm:max-h-[85vh] overflow-hidden rounded-t-2xl sm:rounded-2xl border border-line bg-surface-raised shadow-2xl flex flex-col">
        <div className="px-6 pt-5 pb-3 border-b border-line-subtle" style={{ background: `linear-gradient(180deg, ${priority.bg}, transparent)` }}>
          <div className="flex items-center gap-2 mb-3">
            <AssigneeChip assigneeId={t.assigneeId} />
            {t.privacy === 'private' && <Badge icon={Lock}>Private</Badge>}
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
            className="w-full bg-transparent text-xl sm:text-2xl font-semibold text-primary placeholder-faint outline-none font-display read-only:cursor-default break-words"
            placeholder="Task title"
          />
          {t.createdBy && (() => { const cr = resolveAssignee(t.createdBy); return (
            <div className="mt-1.5 flex items-center gap-1.5 text-meta text-faint">
              <span>Added by</span>
              <PersonButton personId={t.createdBy} className="gap-1.5 min-w-0" title={`View ${creatorLabel(t.createdBy)}'s profile`}>
                <Avatar name={cr.known ? creatorLabel(t.createdBy) : ''} userId={t.createdBy} photoUrl={cr.avatarUrl} size={16} />
                <span className="text-muted hover:text-secondary truncate">
                  {cr.statusEmoji && <span className="mr-1">{cr.statusEmoji}</span>}
                  {creatorLabel(t.createdBy)}
                </span>
              </PersonButton>
            </div>
          ); })()}
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
            <ToggleChip active={t.important} onClick={() => set({ important: !t.important })} icon={Flag} label="Important" color="#7c8cff" disabled={!canEditTask} />
            <ToggleChip active={t.blocked} onClick={() => set({ blocked: !t.blocked })} icon={PauseCircle} label="Blocked" color="#f43f5e" disabled={!canEditTask} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5">Due date</div>
              <input type="date" value={t.dueDate ? t.dueDate.slice(0,10) : ''} onChange={e => set({ dueDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
                disabled={!canEditTask}
                className="w-full bg-fill border border-line rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-line-strong disabled:opacity-60 disabled:cursor-default" />
            </div>
            <div>
              <div className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5">Scheduled for</div>
              <input type="date" value={t.scheduledDate ? t.scheduledDate.slice(0,10) : ''} onChange={e => set({ scheduledDate: e.target.value ? new Date(e.target.value + 'T12:00:00').toISOString() : null })}
                disabled={!canEditTask}
                className="w-full bg-fill border border-line rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-line-strong disabled:opacity-60 disabled:cursor-default" />
            </div>
          </div>

          <div>
            <div className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5">Notes</div>
            <textarea value={t.description} onChange={e => set({ description: e.target.value })} rows={4}
              readOnly={!canEditTask}
              maxLength={20000}
              placeholder="Context, acceptance criteria, links…"
              className="w-full bg-fill border border-line rounded-lg px-3 py-2.5 text-sm text-primary outline-none focus:border-line-strong resize-y read-only:cursor-default read-only:opacity-80" />
          </div>

          {t.blocked && (
            <div>
              <div className="text-micro font-medium uppercase tracking-widest text-danger-text/70 mb-1.5">Blocked because</div>
              <input value={t.blockedReason} onChange={e => set({ blockedReason: e.target.value })} placeholder="Waiting on…"
                readOnly={!canEditTask}
                maxLength={1000}
                className="w-full bg-danger/5 border border-danger/20 rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-danger/40 read-only:cursor-default" />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-micro font-medium uppercase tracking-widest text-faint">Checklist</div>
              {t.subtasks.length > 0 && <div className="text-micro text-faint font-medium tabular-nums">{doneSub}/{t.subtasks.length} done</div>}
            </div>
            {t.subtasks.length > 0 && (
              <div className="h-1 bg-fill rounded-full overflow-hidden mb-2.5">
                <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(doneSub / t.subtasks.length) * 100}%`, background: `linear-gradient(90deg, ${priority.hex}, ${assignee.hex})` }} />
              </div>
            )}
            <div className="space-y-1.5">
              {t.subtasks.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 group">
                  <button onClick={() => canEditTask && toggleSubtask(t.id, s.id)} disabled={!canEditTask} aria-pressed={s.done}
                    className={cx('shrink-0 w-4 h-4 rounded border-2 border-line-strong flex items-center justify-center transition-all', !canEditTask && 'cursor-default')}
                    style={{ borderColor: s.done ? priority.hex : undefined, background: s.done ? priority.hex : 'transparent' }}>
                    {s.done && <Check className="w-2.5 h-2.5" style={{ color: 'rgb(var(--color-canvas))' }} strokeWidth={3} />}
                  </button>
                  <div className={cx('flex-1 text-sm', s.done ? 'text-faint line-through' : 'text-primary')}>{s.title}</div>
                  {canEditTask && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button onClick={() => moveSubtask(t.id, s.id, -1)} disabled={i === 0} aria-label="Move item up"
                        className="text-faint hover:text-secondary disabled:opacity-20 disabled:cursor-default transition-colors"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button onClick={() => moveSubtask(t.id, s.id, 1)} disabled={i === t.subtasks.length - 1} aria-label="Move item down"
                        className="text-faint hover:text-secondary disabled:opacity-20 disabled:cursor-default transition-colors"><ChevronDown className="w-3.5 h-3.5" /></button>
                      <button onClick={() => removeSubtask(t.id, s.id)} aria-label="Delete item"
                        className="ml-0.5 text-faint hover:text-danger-text transition-colors"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </div>
              ))}
              {canEditTask ? (
                <div className="flex gap-2 pt-1">
                  <input value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitSub()}
                    placeholder="Add checklist item…" maxLength={500}
                    className="flex-1 bg-fill border border-line rounded-lg px-3 py-1.5 text-sm text-primary outline-none focus:border-brand-hover/50" />
                  <button onClick={submitSub} className="px-3 rounded-lg border border-line bg-fill hover:bg-fill-strong text-secondary text-sm">Add</button>
                </div>
              ) : t.subtasks.length === 0 && (
                <div className="text-xs text-faint italic">No checklist items.</div>
              )}
            </div>
          </div>

          <Attachments taskId={t.id} canEdit={canEditTask} />

          <div className="pt-4 border-t border-line-subtle text-meta text-faint flex flex-wrap gap-x-4 gap-y-1">
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
    <div className={cx('relative inline-flex items-center gap-1.5 rounded-full border border-line bg-fill px-3 h-8 text-xs text-primary transition-colors',
      disabled ? 'opacity-60' : 'hover:bg-fill-strong cursor-pointer')}>
      {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      <span className="text-faint">{label}:</span>
      <span className="text-primary font-medium">{currentLabel}</span>
      {!disabled && <ChevronDown className="w-3 h-3 text-faint" />}
      <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
        aria-label={label}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default">
        {options.map(([v,l]) => <option key={v} value={v} className="bg-surface-raised text-primary">{l}</option>)}
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
  const { meId, resolveAssignee } = useApp();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);   // drives the gentle enter/exit transition
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);

  const avatarFor = (v, lbl) => {
    if (v === 'all') return { all: true };
    if (v === '' || v === 'unassigned' || v == null) return { unassigned: true, hex: UNASSIGNED_STYLE.hex, soft: UNASSIGNED_STYLE.soft, initials: '·' };
    const id = v === 'me' ? meId : v;
    const c = assigneeColor(id);
    const r = resolveAssignee(id);
    // `known` rides along so the trigger/rows can silhouette a roster-absent assignee (the injected
    // former-assignee option in TaskModal) instead of initialling the fallback label — the same
    // known-gate every other avatar call site applies.
    return { id, hex: c.hex, soft: c.soft, initials: initialsOf(lbl), avatarUrl: r.avatarUrl, statusEmoji: r.statusEmoji, known: r.known };
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
    ? 'relative inline-flex items-center gap-1.5 rounded-lg border border-line bg-fill-subtle hover:bg-fill px-2.5 h-9 text-xs cursor-pointer transition-colors shrink-0'
    : 'relative inline-flex items-center gap-1.5 rounded-full border border-line bg-fill hover:bg-fill-strong px-3 h-8 text-xs cursor-pointer transition-colors';

  return (
    <>
      <button type="button" ref={btnRef} disabled={disabled} onClick={() => (open ? close() : openMenu())} aria-haspopup="listbox" aria-expanded={open} className={cx(triggerCls, disabled && 'opacity-60 !cursor-default')}>
        {variant === 'filter' && <Filter className="w-3 h-3 text-faint shrink-0" />}
        {curAv && !curAv.all && <Avatar name={curAv.unassigned || !curAv.known ? '' : (current ? current[1] : '')} userId={curAv.id} photoUrl={curAv.avatarUrl} size={16} />}
        <span className="text-faint shrink-0">{label}:</span>
        <span className="text-primary font-medium truncate max-w-[140px]">{current ? current[1] : (value || '')}</span>
        <ChevronDown className={cx('w-3 h-3 text-faint shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={close} />
          <div role="listbox" aria-label={label}
            className={cx('fixed z-[71] rounded-xl border border-line bg-surface-raised shadow-2xl overflow-hidden flex flex-col transition-all duration-150 ease-out',
              shown ? 'opacity-100 translate-y-0' : cx('opacity-0', pos.up ? 'translate-y-1' : '-translate-y-1'))}
            style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: pos.bottom } : { top: pos.top }) }}>
            <div className="p-1.5 border-b border-line-subtle">
              <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey}
                placeholder="Search people…"
                className="w-full bg-fill border border-line rounded-lg px-2.5 h-8 text-xs text-primary placeholder-faint outline-none focus:border-brand-hover/50" />
            </div>
            <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-center text-meta text-faint">No one found</div>
              ) : filtered.map((o, i) => {
                const av = avatarFor(o[0], o[1]);
                const isSel = o[0] === value;
                return (
                  <button key={String(o[0]) || 'unassigned'} type="button" role="option" aria-selected={isSel}
                    onMouseEnter={() => setActive(i)} onClick={() => choose(o)}
                    className={cx('w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors',
                      i === active ? 'bg-brand/25 text-primary' : 'text-primary hover:bg-fill')}>
                    {av.all ? (
                      <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-fill-strong text-muted"><Users className="w-3 h-3" /></span>
                    ) : (
                      // Avatar, not a hand-rolled circle: it already does photo -> initials -> silhouette
                      // AND the light-mode swap that used to be duplicated inline right here.
                      <Avatar name={av.unassigned || !av.known ? '' : o[1]} userId={av.id} photoUrl={av.avatarUrl} size={20} />
                    )}
                    <span className="flex-1 truncate">
                      {/* status helps you pick who's free — but not on the filter, which is a criterion, not a person */}
                      {variant !== 'filter' && av.statusEmoji && <span className="mr-1">{av.statusEmoji}</span>}
                      {o[1]}
                    </span>
                    {isSel && <Check className="w-3.5 h-3.5 text-brand-text shrink-0" />}
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
        active ? 'text-primary' : cx('text-muted border-line bg-fill', !disabled && 'hover:bg-fill-strong'))}
      style={active ? { background: `${color}22`, borderColor: `${color}55`, color } : {}}>
      <Icon className="w-3.5 h-3.5" />{label}
    </button>
  );
}

/* =================================================================================
   RECURRENCE — REMOVED 2026-07-19 (UI only; the tasks.recurring COLUMN is deliberately KEPT).
   The picker, its helpers (isRecurring/normalizeRecurrence/formatRecurrence/DAY_*), the two badges,
   and the recurringTasks entitlement gate all lived here. They were removed because the feature had
   NO BACKEND OF ANY KIND: no DB function, trigger or cron job ever read tasks.recurring, so not one
   occurrence was ever generated. Five live tasks had carried active daily/weekly rules since
   2026-04-26 and had produced nothing. It was also advertised on every pricing tier — and an
   advertised feature that does not exist is worse than a missing one, so the UI and the claim went
   together. sanitize.js still round-trips the column, so every existing rule is preserved verbatim
   for a future BUILD; nothing was migrated away and nothing was lost.
   TO BUILD IT FOR REAL: a pg_cron spawner is the natural shape (the project already runs two jobs;
   DUE_DATE_REMINDERS.md is the closest precedent). The open design questions are timezone/DST, what
   completing one occurrence means for the series, and edit-series vs edit-occurrence — and it must
   not spawn a backlog for rules that have been idle for months.
================================================================================= */

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
      // Default project resolved against the workspace's REAL projects — see defaultProjectId. The
      // old code hardcoded the seed ids 'personal' (private view) and 'other', neither of which
      // exists in every workspace, so a quick-add could file a task under an id that resolves to
      // nothing: no chip, no error, effectively unfiled.
      setPrivacy(view === 'private' ? 'private' : 'workspace');
      setProject(defaultProjectId(projects, view === 'private' ? 'personal' : 'other'));
    } else {
      setTitle('');
    }
  }, [quickAddOpen, view, meId, projects]);

  if (!quickAddOpen) return null;

  const submit = () => {
    if (!title.trim() || submittingRef.current) return;   // guard a fast double-Enter from creating two tasks
    submittingRef.current = true;
    addTask({ title: title.trim(), assigneeId, privacy, priority, project, status: 'inbox' });
    setQuickAddOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm flex items-start justify-center pt-24 px-4 animate-[fadeIn_.15s_ease]" onClick={() => setQuickAddOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-line bg-surface-raised shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-line-subtle flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-brand-text" />
          <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="What needs to get done?" maxLength={500}
            className="flex-1 bg-transparent text-lg text-primary outline-none placeholder-faint font-display" />
          <kbd className="text-micro text-faint bg-fill border border-line rounded px-1.5 py-0.5">Enter</kbd>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <AssigneeSelect label="Assignee" value={assigneeId ?? ''}
              options={[['', 'Unassigned'], ...(meId ? [[meId, 'Me']] : []), ...members.filter(m => m.userId !== meId).map(m => [m.userId, m.displayName || m.email])]}
              onChange={v => setAssigneeId(v || null)} />
            <div className="w-px h-6 bg-fill-strong self-center mx-1" />
            <span className="self-center text-meta font-medium text-faint">Visibility</span>
            <button onClick={() => setPrivacy(privacy === 'private' ? 'workspace' : 'private')}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
                privacy === 'private' ? 'text-primary' : 'text-muted border-line bg-fill')}
              style={privacy === 'private' ? { background: 'rgba(124,140,255,0.14)', borderColor: '#7c8cff55', color: '#7c8cff' } : {}}>
              <Lock className="w-3 h-3" />{privacy === 'private' ? 'Private' : 'Shared'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.values(PRIORITIES).map(p => (
              <button key={p.id} onClick={() => setPriority(p.id)}
                className={cx('inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-medium transition-all',
                  priority === p.id ? 'text-primary' : 'text-muted border-line bg-fill')}
                style={priority === p.id ? { background: p.bg, borderColor: p.ring, color: p.hex } : {}}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.hex, boxShadow: `0 0 8px ${p.glow}` }} />{p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={project} onChange={e => setProject(e.target.value)} aria-label="Project"
              className="bg-fill border border-line rounded-full px-3 h-8 text-xs text-secondary outline-none cursor-pointer">
              {projects.map(p => <option key={p.id} value={p.id} className="bg-surface-raised">{p.icon} {p.name}</option>)}
            </select>
            <div className="flex-1" />
            <button onClick={submit} disabled={!title.trim()}
              className="inline-flex items-center gap-1.5 rounded-full px-4 h-8 text-xs font-semibold bg-inverse text-inverse-fg hover:bg-inverse/90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity">
              <Plus className="w-3.5 h-3.5" />Add task
            </button>
          </div>
          <div className="text-meta text-muted">Tip: press <kbd className="px-1 py-0.5 bg-fill border border-line rounded text-secondary">{shortcutLabel('N')}</kbd> or <kbd className="px-1 py-0.5 bg-fill border border-line rounded text-secondary">N</kbd> anywhere to capture.</div>
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
      ? directMessagesApi.listRecentMessages(currentWorkspaceId, 500).catch(logCaught('dms.recentMessages for palette', () => []))
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
        .catch(logCaught('messages.search', () => { if (on) setServerChatMsgs([]); }));
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
    { id: 'v-dash', label: 'Go to Home', icon: LayoutDashboard, run: () => { setView('dashboard'); setPaletteOpen(false); } },
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
    <div className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm flex items-start justify-center pt-24 px-4 animate-[fadeIn_.15s_ease]" onClick={() => setPaletteOpen(false)}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-2xl border border-line bg-surface-raised shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-line-subtle flex items-center gap-3">
          <Command className="w-4 h-4 text-faint" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={handleKey}
            placeholder="Search tasks, messages, or run a command…"
            className="flex-1 bg-transparent text-base text-primary outline-none placeholder-faint" />
          <kbd className="text-micro text-faint bg-fill border border-line rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto py-2">
          {results.cmds.length > 0 && (
            <div className="px-2">
              <div className="px-3 py-1.5 text-micro font-medium uppercase tracking-widest text-faint">Commands</div>
              {results.cmds.map((c, i) => {
                const active = i === idx;
                return (
                  <button key={c.id} onClick={c.run} onMouseEnter={() => setIdx(i)}
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                      active ? 'bg-fill-strong text-primary' : 'text-secondary hover:bg-fill')}>
                    <c.icon className="w-4 h-4" />{c.label}
                  </button>
                );
              })}
            </div>
          )}
          {results.tasks.length > 0 && (
            <div className="px-2 pt-2">
              <div className="px-3 py-1.5 text-micro font-medium uppercase tracking-widest text-faint">Tasks</div>
              {results.tasks.map((t, i) => {
                const ii = results.cmds.length + i;
                const active = ii === idx;
                return (
                  <button key={t.id} onClick={() => { setEditingTask(t); setPaletteOpen(false); }} onMouseEnter={() => setIdx(ii)}
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                      active ? 'bg-fill-strong text-primary' : 'text-secondary hover:bg-fill')}>
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
              <div className="px-3 py-1.5 text-micro font-medium uppercase tracking-widest text-faint">Messages</div>
              {results.msgs.map((m, i) => {
                const ii = results.cmds.length + results.tasks.length + i;
                const active = ii === idx;
                const Icon = m.kind === 'dm' ? MessagesSquare : MessageSquare;
                const sender = resolveAssignee(m.senderId);
                const who = sender.label;
                return (
                  <button key={`${m.kind}-${m.id}`} onClick={() => openMessage(m)} onMouseEnter={() => setIdx(ii)}
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                      active ? 'bg-fill-strong text-primary' : 'text-secondary hover:bg-fill')}>
                    {/* The face says who; the DM/Team glyph stays as the small kind marker. */}
                    <Avatar name={sender.known ? who : ''} userId={m.senderId} photoUrl={sender.avatarUrl} size={20} />
                    <span className="flex-1 min-w-0 truncate">{m.body}</span>
                    <span className="text-micro text-faint shrink-0 inline-flex items-center gap-1">
                      <Icon className="w-3 h-3" />{who} · {m.kind === 'dm' ? 'DM' : 'Team'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {flat.length === 0 && <div className="px-4 py-8 text-center text-faint text-sm">No matches</div>}
        </div>
      </div>
    </div>
  );
}

/* =================================================================================
   SIDEBAR
================================================================================= */
function Sidebar() {
  const { view, setView, tasks, meId, chatUnread, dmUnread, canManageMembers, isGuest, personOf, openProfile } = useApp();
  const me = personOf(meId);

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
        view === id ? 'bg-fill-strong text-primary border border-line' : 'text-muted hover:text-primary hover:bg-fill border border-transparent')}>
      {React.createElement(icon, { className: 'w-4 h-4' })}
      <span className="flex-1 text-left font-medium">{label}</span>
      {badge != null && badge > 0 && (
        <span className="text-micro font-semibold text-muted bg-fill border border-line rounded-md px-1.5 h-5 flex items-center">{badge}</span>
      )}
    </button>
  );

  return (
    <aside className="hidden lg:flex flex-col w-64 shrink-0 border-r border-line-subtle bg-surface">
      <div className="px-5 pt-6 pb-5 border-b border-line-subtle">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-gradient flex items-center justify-center shadow-lg shadow-brand/10">
            <Sparkles className="w-4 h-4 text-brand-fg" />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-primary font-brand tracking-tight">Corlyvo</div>
            <div className="text-micro text-faint uppercase tracking-widest">Visual task management</div>
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
            <div className="px-3 pb-2 text-micro font-medium uppercase tracking-widest text-faint">Team</div>
            {item('dashboard', LayoutDashboard, 'Home')}
            {item('kanban', KanbanSquare, 'Kanban', counts.all)}
            {item('matrix', Grid3x3, 'Priority Matrix')}
            {item('projects', FolderKanban, 'Projects')}
            {item('schedule', CalendarDays, 'Schedule')}
            {item('chat', MessageSquare, 'Chat', chatUnread)}
            {item('dms', MessagesSquare, 'Direct messages', dmUnread)}
            {canManageMembers && item('members', Users, 'Members')}

            <div className="px-3 pt-5 pb-2 text-micro font-medium uppercase tracking-widest text-faint">My views</div>
            {item('mine', UserCog, 'My Tasks', counts.mine)}
            {item('private', Lock, 'Private tasks', counts.private)}
          </>
        )}
      </div>

      <div className="p-3 border-t border-line-subtle">
        <div className="rounded-xl border border-line-subtle bg-fill-subtle p-3">
          <div className="text-micro uppercase tracking-widest text-faint mb-1.5">Overview</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-primary font-display">{counts.all}</div>
            <div className="text-meta text-faint">open tasks</div>
          </div>
          {counts.overdue > 0 && (
            <div className="mt-2 text-meta text-danger-text flex items-center gap-1">
              <Flame className="w-3 h-3" />{counts.overdue} overdue
            </div>
          )}
        </div>

        {/* You, anchored at the bottom — the second way into your own profile besides the top-bar avatar.
            `me` is null until the roster loads; render nothing rather than a flash of placeholder identity. */}
        {me && (
          <button onClick={() => openProfile(meId)} title="Your profile"
            className="mt-2 w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left border border-transparent hover:bg-fill">
            <Avatar name={me.name} userId={meId} photoUrl={me.avatarUrl} size={30} />
            <div className="min-w-0 leading-tight">
              <div className="text-note font-medium text-primary truncate flex items-center gap-1">
                {me.statusEmoji && <span aria-hidden="true">{me.statusEmoji}</span>}
                <span className="truncate">{me.name}</span>
              </div>
              <div className="text-micro text-faint truncate">{me.statusText || 'View your profile'}</div>
            </div>
          </button>
        )}
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
          <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={() => setMoreOpen(false)} />
          <div className="absolute bottom-0 left-0 right-0 rounded-t-2xl border-t border-line bg-surface-raised pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl" style={{ animation: 'slideUp .18s ease' }}>
            <div className="mx-auto mb-1 h-1 w-9 rounded-full bg-fill-strong" />
            <div className="px-4 py-2 text-micro font-medium uppercase tracking-widest text-faint">More</div>
            <div className="px-2 pb-1">
              {more.map(it => (
                <button key={it.id} onClick={() => go(it.id)}
                  className={cx('w-full flex items-center gap-3 px-3 h-12 rounded-xl text-left transition-colors',
                    view === it.id ? 'bg-fill-strong text-primary' : 'text-secondary hover:bg-fill')}>
                  <it.icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-sm font-medium">{it.label}</span>
                  {it.badge > 0 && (
                    <span className="min-w-[16px] h-4 px-1 rounded-full bg-danger text-brand-fg text-[9px] font-bold leading-none flex items-center justify-center">{it.badge > 9 ? '9+' : it.badge}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-line-subtle bg-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {primary.map(it => (
            <button key={it.id} onClick={() => go(it.id)}
              className={cx('relative flex-1 min-w-0 py-2.5 flex flex-col items-center justify-center gap-0.5 transition-colors',
                view === it.id ? 'text-primary' : 'text-faint')}>
              <it.icon className="w-5 h-5" />
              {it.badge > 0 && (
                <span className="absolute top-1.5 left-1/2 translate-x-2 min-w-[14px] h-3.5 px-1 rounded-full bg-danger text-brand-fg text-[8px] font-bold leading-none flex items-center justify-center">{it.badge > 9 ? '9+' : it.badge}</span>
              )}
              <span className="text-[9px] font-medium tracking-wide">{it.label}</span>
            </button>
          ))}
          {more.length > 0 && (
            <button onClick={() => setMoreOpen(o => !o)} aria-label="More destinations" aria-expanded={moreOpen}
              className={cx('relative flex-1 min-w-0 py-2.5 flex flex-col items-center justify-center gap-0.5 transition-colors',
                moreActive || moreOpen ? 'text-primary' : 'text-faint')}>
              <MoreHorizontal className="w-5 h-5" />
              {moreBadge > 0 && <span className="absolute top-1.5 left-1/2 translate-x-2 w-2 h-2 rounded-full bg-danger" />}
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
  return { Icon: Bell, hex: light ? '#4650d6' : '#9aa3ff' };
}

function NotificationToast({ n, light, onOpen, onDismiss }) {
  const { id } = n;
  const { resolveAssignee } = useApp();
  const tv = notifVisual(n.type, light);
  const actor = n.actorId ? resolveAssignee(n.actorId) : null;   // null for system notices (due_soon/overdue)
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
      className={cx('pointer-events-auto flex items-start gap-2.5 w-full text-left px-3.5 py-3 rounded-xl border border-line bg-surface-raised shadow-2xl hover:border-line-strong transition-colors',
        leaving ? 'animate-[fadeSlideOut_.18s_ease_forwards]' : 'animate-[slideUp_.2s_ease]')}>
      <span className="mt-0.5 shrink-0 relative">
        {actor
          ? <Avatar name={actor.known ? actor.label : ''} userId={n.actorId} photoUrl={actor.avatarUrl} size={28} />
          : <span className="w-7 h-7 rounded-lg border flex items-center justify-center"
              style={{ background: tv.hex + '1f', borderColor: tv.hex + '55' }}>
              <tv.Icon className="w-3.5 h-3.5" style={{ color: tv.hex }} />
            </span>}
        {actor && (
          <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center border"
            style={{ background: light ? '#ffffff' : '#191f35', borderColor: light ? '#d1d5db' : 'rgba(255,255,255,0.12)' }}>
            <tv.Icon className="w-2 h-2" style={{ color: tv.hex }} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-meta font-semibold text-primary">{n.title || 'New notification'}</span>
        <span className="block text-xs text-muted leading-snug">{n.message}</span>
      </span>
    </button>
  );
}

function NotificationBell() {
  const { session, tasks, setEditingTask, theme, currentWorkspaceId, setView, setDmActiveConv, view, dmActiveConv, resolveAssignee } = useApp();
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
      .catch(err => reportError(err, 'notifications.list'))
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [userId, currentWorkspaceId]);

  // 5b: keep the accurate server unread count fresh — on load, on switch, and after any bell change
  // (new notification, mark-read, clear), debounced so a burst collapses into one count query.
  useEffect(() => {
    if (!userId || !currentWorkspaceId) return undefined;
    const t = setTimeout(() => { notificationsApi.unreadCount(currentWorkspaceId).then(setServerUnread).catch(logCaught('notifications.unreadCount')); }, 300);
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
        notificationsApi.markRead(n.id).catch(logCaught('notifications.markRead'));
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
      stale.forEach(n => notificationsApi.markRead(n.id).catch(logCaught('notifications.markRead stale DM')));
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
      reportError(err, 'notifications.openTask');
    }
  }, [tasks, setEditingTask]);

  const handleOpen = (n) => {
    setOpen(false);
    removeToast(n.id);
    if (!n.read) {
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
      notificationsApi.markRead(n.id).catch(err => {
        reportError(err, 'notifications.markRead');
        notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(logCaught('notifications.reconcile')); // reconcile with server on failure
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
      reportError(err, 'notifications.markAllRead');
      notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(logCaught('notifications.reconcile')); // reconcile with server on failure
    }
  };

  // Two-phase delete: fade/slide the row out (~180ms), then remove + persist. Reduced-motion -> immediate.
  const deleteNotif = (id) => {
    const finish = () => {
      setItems(p => p.filter(x => x.id !== id));
      setExitingNotifIds(p => { const n = new Set(p); n.delete(id); return n; });
      notificationsApi.delete(id).catch(err => {
        reportError(err, 'notifications.delete');
        notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(logCaught('notifications.reconcile')); // reconcile with server on failure
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
        reportError(err, 'notifications.clearAll');
        notificationsApi.list(50, currentWorkspaceId).then(setItems).catch(logCaught('notifications.reconcile')); // reconcile with server on failure
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
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-danger text-brand-fg text-[9px] font-bold leading-none flex items-center justify-center pointer-events-none shadow-[0_0_8px_rgba(244,63,94,0.5)]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-11 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface-raised shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-line-subtle">
                <div className="text-xs font-semibold text-primary">
                  Notifications
                  {unreadCount > 0 && <span className="ml-1.5 text-micro font-medium text-faint">{unreadCount} new</span>}
                </div>
                <div className="flex items-center gap-3">
                  {unreadCount > 0 && (
                    <button onClick={markAll}
                      className="inline-flex items-center gap-1 text-micro font-medium text-muted hover:text-primary transition-colors">
                      <Check className="w-3 h-3" />Mark all read
                    </button>
                  )}
                  {items.length > 0 && (
                    <button onClick={() => setConfirmClear(true)}
                      className="inline-flex items-center gap-1 text-micro font-medium text-faint hover:text-danger-text transition-colors">
                      <Trash2 className="w-3 h-3" />Clear all
                    </button>
                  )}
                </div>
              </div>
              <div className="max-h-[70vh] overflow-y-auto no-scrollbar">
                {loading ? (
                  <div className="px-3 py-6 text-center text-meta text-faint">Loading…</div>
                ) : items.length === 0 ? (
                  <div className="px-3 py-8 text-center">
                    <Bell className="w-5 h-5 text-faint mx-auto mb-2" />
                    <div className="text-meta text-faint">You're all caught up</div>
                  </div>
                ) : (
                  items.map(n => (
                    <div key={n.id}
                      className={cx('group relative flex items-stretch border-b border-line-subtle last:border-b-0 transition-colors hover:bg-fill',
                        !n.read && 'bg-fill-subtle',
                        exitingNotifIds.has(n.id) && 'animate-[fadeSlideOut_.18s_ease_forwards]')}>
                      <button onClick={() => handleOpen(n)}
                        className="min-w-0 flex-1 text-left flex items-start gap-2.5 pl-3 pr-1 py-2.5">
                        {(() => {
                          const tv = notifVisual(n.type, light);
                          // A face answers WHO did it; the type glyph rides along as a corner badge to keep
                          // WHAT. due_soon/overdue are system-generated (actor_id is null) -> glyph only.
                          const actor = n.actorId ? resolveAssignee(n.actorId) : null;
                          return (
                          <span className="relative mt-0.5 shrink-0">
                            {actor
                              ? <Avatar name={actor.known ? actor.label : ''} userId={n.actorId} photoUrl={actor.avatarUrl} size={28} />
                              : <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: light ? `${tv.hex}1f` : `${tv.hex}22` }}>
                                  <tv.Icon className="w-4 h-4" style={{ color: tv.hex }} />
                                </span>}
                            {actor && (
                              <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center border"
                                style={{ background: light ? '#ffffff' : '#191f35', borderColor: light ? '#d1d5db' : 'rgba(255,255,255,0.12)' }}>
                                <tv.Icon className="w-2 h-2" style={{ color: tv.hex }} />
                              </span>
                            )}
                            {!n.read && <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full" style={{ background: light ? '#4650d6' : '#7c8cff', boxShadow: `0 0 6px ${light ? 'rgba(70,80,214,0.45)' : 'rgba(124,140,255,0.7)'}` }} />}
                          </span>
                          ); })()}
                        <span className="min-w-0 flex-1">
                          <span className={cx('block text-xs leading-snug', n.read ? 'text-muted' : 'text-primary')}>{n.message}</span>
                          <span className="block mt-0.5 text-micro text-faint">{timeAgo(n.createdAt)}</span>
                        </span>
                      </button>
                      <button onClick={() => deleteNotif(n.id)} aria-label="Delete notification"
                        className="shrink-0 px-2.5 flex items-center text-faint hover:text-danger-text focus:text-danger-text transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100">
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
          className="w-full bg-input border border-line rounded-xl px-3 h-11 text-sm text-primary placeholder-faint outline-none focus:border-brand-hover/60 focus:bg-input-focus focus:ring-2 focus:ring-brand/20 transition-colors" />
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
      <div className="fixed inset-0 z-[60] bg-overlay backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
          className="pointer-events-auto w-full max-w-sm rounded-2xl border border-line bg-surface-raised shadow-2xl p-5 outline-none"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
          <h2 className="text-base font-semibold text-primary mb-1">{title}</h2>
          {message && <p className="text-xs text-muted mb-4 break-words">{message}</p>}
          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose}
              className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">Cancel</button>
            <button ref={btnRef} onClick={onConfirm} disabled={confirmDisabled}
              className={cx('h-9 px-4 rounded-xl text-brand-fg text-xs font-semibold transition-colors inline-flex items-center gap-1.5',
                confirmDisabled ? 'bg-danger/40 text-muted cursor-not-allowed'
                  : tone === 'danger' ? 'bg-danger hover:bg-danger-hover' : 'bg-brand hover:bg-brand-hover')}>
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
function ProjectDeleteModal({ open, project, projects, taskCount, isOwner, onCancel, onConfirm }) {
  const [mode, setMode] = useState('unassign');   // 'unassign' | 'cascade'
  const [confirmText, setConfirmText] = useState('');
  const [dest, setDest] = useState('');           // chosen destination project id ('' = not yet chosen)
  const panelRef = useRef(null);
  useEffect(() => { if (open) setTimeout(() => panelRef.current?.focus(), 30); }, [open]);
  if (!open || !project) return null;

  const checking = taskCount === null;
  const errored = taskCount === -1;
  const count = typeof taskCount === 'number' && taskCount > 0 ? taskCount : 0;

  // THE DESTINATION IS NOW CHOSEN, NOT GUESSED. This used to be
  //     const reassignTo = project.id === 'other' ? 'personal' : 'other';
  // — a hardcoded SEED id. `tasks.project` is free text with no FK, and the RPC did not validate the
  // target, so moving tasks to an id that does not resolve silently UNFILED them: the chip just
  // disappears and nothing errors. Live check 2026-07-19: NO workspace has a project called 'other',
  // and two of three lack 'personal', so this path was wrong for essentially every project.
  // Now: real projects only, excluding the one being deleted, defaulting to the first.
  const candidates = (projects || []).filter(p => p.id !== project.id);
  const destId = dest && candidates.some(p => p.id === dest) ? dest : (candidates[0]?.id || '');
  const destName = candidates.find(p => p.id === destId)?.name || '';
  // With nowhere to move them to, "Keep the tasks" is not offerable. Owners can still cascade; a
  // non-owner is left with no valid action, and the modal says so rather than failing on confirm.
  const noDestination = candidates.length === 0;

  const cascadeReady = mode !== 'cascade' || confirmText.trim() === (project.name || '').trim();
  const unassignReady = mode !== 'unassign' || count === 0 || !!destId;
  const canConfirm = !checking && !errored && cascadeReady && unassignReady;
  // reset in the close handlers (not an effect) so a reopened modal starts fresh — cascade must always
  // require re-typing the project name — while staying clear of the react-hooks/set-state-in-effect rule.
  const reset = () => { setMode('unassign'); setConfirmText(''); setDest(''); };
  const handleCancel = () => { reset(); onCancel(); };
  const doConfirm = () => { if (!canConfirm) return; const m = mode, r = destId; reset(); onConfirm(m, r); };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-overlay backdrop-blur-sm" onClick={handleCancel} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Delete ${project.name}`}
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-line bg-surface-raised shadow-2xl p-5 outline-none"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); handleCancel(); } }}>
          <h2 className="text-base font-semibold text-primary mb-1 break-words">Delete “{project.name}”?</h2>

          {checking && <p className="text-xs text-muted mb-4">Checking for tasks…</p>}
          {errored && <p className="text-xs text-danger-text mb-4">Couldn't check this project's tasks. Please try again.</p>}
          {!checking && !errored && count === 0 && (
            <p className="text-xs text-muted mb-4">This project has no tasks. It will be permanently deleted.</p>
          )}

          {!checking && !errored && count > 0 && (
            <div className="space-y-2 mb-4">
              <p className="text-xs text-muted">“{project.name}” has {count} task{count === 1 ? '' : 's'}. Choose what happens to them:</p>
              <label className={cx('flex items-start gap-2.5 p-2.5 rounded-xl border transition-colors',
                noDestination ? 'border-line opacity-50 cursor-not-allowed'
                  : cx('cursor-pointer', mode === 'unassign' ? 'border-brand-hover/50 bg-brand/10' : 'border-line hover:bg-fill'))}>
                <input type="radio" name="pdmode" checked={mode === 'unassign'} disabled={noDestination}
                  onChange={() => setMode('unassign')} className="mt-0.5" />
                <span className="text-xs text-secondary min-w-0 flex-1">
                  <span className="font-medium text-primary">Keep the tasks</span>
                  {noDestination
                    ? <> — unavailable: this is the only project, so there is nowhere to move them.</>
                    : <> — move them to another project, then delete “{project.name}”.</>}
                  {!noDestination && (
                    <span className="mt-2 flex items-center gap-2">
                      <span className="text-meta text-muted shrink-0">Move to</span>
                      {/* A real picker over the workspace's REAL projects. Rendering it inside the label
                          is fine — a <select> is not a nested button — but stopPropagation keeps a click
                          on the dropdown from also toggling the radio underneath it. */}
                      <select value={destId} onChange={e => { setDest(e.target.value); setMode('unassign'); }}
                        onClick={e => e.stopPropagation()}
                        aria-label="Destination project for the kept tasks"
                        className="flex-1 min-w-0 h-8 px-2 rounded-lg bg-fill border border-line text-xs text-primary outline-none focus:border-brand-hover/50">
                        {candidates.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </span>
                  )}
                </span>
              </label>
              {isOwner && (
                <label className={cx('flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors',
                  mode === 'cascade' ? 'border-danger-hover/50 bg-danger/10' : 'border-line hover:bg-fill')}>
                  <input type="radio" name="pdmode" checked={mode === 'cascade'} onChange={() => setMode('cascade')} className="mt-0.5" />
                  <span className="text-xs text-secondary"><span className="font-medium text-danger-text">Delete the tasks too</span> — permanently removes the project and its {count} task{count === 1 ? '' : 's'}. Can't be undone.</span>
                </label>
              )}
              {mode === 'cascade' && (
                <div className="pt-1">
                  <p className="text-meta text-muted mb-1.5">Type <span className="text-secondary font-medium">{project.name}</span> to confirm:</p>
                  <input autoFocus value={confirmText} onChange={e => setConfirmText(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-fill border border-line text-xs text-primary outline-none focus:border-danger-hover/50"
                    placeholder={project.name} aria-label="Type the project name to confirm deletion" />
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button onClick={handleCancel}
              className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">Cancel</button>
            <button onClick={doConfirm} disabled={!canConfirm}
              className={cx('h-9 px-4 rounded-xl text-brand-fg text-xs font-semibold transition-colors inline-flex items-center gap-1.5',
                !canConfirm ? 'bg-fill-strong text-faint cursor-not-allowed'
                  : mode === 'cascade' ? 'bg-danger hover:bg-danger-hover' : 'bg-brand hover:bg-brand-hover')}>
              <Trash2 className="w-3.5 h-3.5" />
              {/* Name the DESTINATION in the button, so the irreversible action states where the tasks
                  are actually going rather than leaving it to the radio label above. */}
              {count > 0 && mode === 'cascade'
                ? `Delete project + ${count} task${count === 1 ? '' : 's'}`
                : count > 0 && destName
                  ? `Move ${count} task${count === 1 ? '' : 's'} to “${destName}” & delete`
                  : 'Delete project'}
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
      <div className="fixed inset-0 z-[60] bg-overlay backdrop-blur-sm" onClick={dismissUpgrade} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-line bg-surface-raised shadow-2xl p-5"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); dismissUpgrade(); } }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand to-brand-alt flex items-center justify-center shrink-0 shadow-lg shadow-brand/15">
              <Sparkles className="w-4 h-4 text-brand-fg" />
            </span>
            <div className="text-micro font-semibold uppercase tracking-widest text-brand-text/80">{tier.name} feature</div>
            <button onClick={dismissUpgrade} aria-label="Close" className="ml-auto text-faint hover:text-secondary transition-colors"><X className="w-4 h-4" /></button>
          </div>
          <h2 className="text-base font-semibold text-primary mb-1">{meta.isLimit ? meta.label : `Unlock ${meta.label}`}</h2>
          {meta.blurb && <p className="text-xs text-muted mb-4 leading-relaxed">{meta.blurb}</p>}
          <div className="rounded-xl border border-line bg-fill-subtle px-3 py-2.5 mb-4 text-note text-muted">
            Included on <span className="font-semibold text-primary">{tier.name}</span> and up.
          </div>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => go('/pricing')}
              className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">See all plans</button>
            <button onClick={() => go(`/checkout?plan=${tier.id}`)}
              className="h-9 px-4 rounded-xl text-brand-fg text-xs font-semibold bg-brand-gradient-cta hover:shadow-lg hover:shadow-brand/15 transition-all inline-flex items-center gap-1.5">
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
      <div className="pointer-events-auto inline-flex items-center gap-2 px-3 h-9 rounded-full border border-warning-hover/30 bg-warning/15 backdrop-blur text-meta text-warning-text shadow-lg">
        <span className="w-1.5 h-1.5 rounded-full bg-warning-hover shrink-0" />
        Previewing the <span className="font-semibold">{entitlements.plan.name}</span> plan
        <button onClick={exit} className="ml-1 font-semibold text-warning-text hover:text-primary underline underline-offset-2 transition-colors">Exit</button>
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
      <div className="fixed inset-0 z-[60] bg-overlay backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
        <form onSubmit={submit}
          className="pointer-events-auto w-full max-w-sm rounded-2xl border border-line bg-surface-raised shadow-2xl p-5"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-primary">{editing ? 'Edit project' : 'New project'}</h2>
            <button type="button" onClick={onClose} className="text-faint hover:text-secondary transition-colors"><X className="w-4 h-4" /></button>
          </div>

          <label className="block text-meta font-medium text-muted mb-1">Name</label>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="e.g. Marketing"
            className="w-full h-9 px-3 rounded-xl bg-fill border border-line text-sm text-primary outline-none focus:border-line-strong transition-colors mb-4" />

          <div className="flex items-start gap-3 mb-3">
            <div className="flex-1">
              <label className="block text-meta font-medium text-muted mb-1.5">Color</label>
              <div className="flex flex-wrap gap-1.5">
                {PROJECT_PALETTE.map(c => (
                  <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Use color ${c}`}
                    className={cx('w-6 h-6 rounded-lg transition-transform', color === c ? 'ring-2 ring-primary/70 scale-110' : 'hover:scale-105')}
                    style={{ background: c }} />
                ))}
              </div>
            </div>
            <div>
              <label className="block text-meta font-medium text-muted mb-1.5">Preview</label>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold"
                style={{ background: color + '22', color, border: `1px solid ${color}44` }}>{icon || '◇'}</div>
            </div>
          </div>

          <label className="block text-meta font-medium text-muted mb-1.5">Icon</label>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {PROJECT_ICONS.map(ic => (
              <button key={ic} type="button" onClick={() => setIcon(ic)}
                className={cx('w-7 h-7 rounded-lg text-sm flex items-center justify-center transition-colors',
                  icon === ic ? 'bg-fill-strong text-primary' : 'bg-fill text-muted hover:bg-fill-strong')}>{ic}</button>
            ))}
          </div>

          {err && <p className="text-meta text-danger-text mb-3">{err}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose}
              className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">Cancel</button>
            <button type="submit" disabled={busy}
              className={cx('h-9 px-4 rounded-xl text-xs font-semibold text-brand-fg transition-colors', busy ? 'bg-brand/40 cursor-not-allowed' : 'bg-brand hover:bg-brand-hover')}>
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
      <div className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-line bg-surface-raised shadow-2xl p-5"
          style={{ animation: 'slideUp .2s ease' }} onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-semibold text-primary">Create workspace</h2>
            <button onClick={onClose} className="text-faint hover:text-secondary transition-colors"><X className="w-4 h-4" /></button>
          </div>
          <p className="text-xs text-faint mb-4">A fresh space for a team's tasks, projects, and chat. You'll be its owner.</p>
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
  const badgeCls = 'w-4 h-4 rounded-md bg-brand flex items-center justify-center text-[8px] font-bold text-brand-fg shrink-0';
  const initial = (name) => (name || 'W').slice(0, 1).toUpperCase();
  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen(o => !o)} title="Switch or create workspace"
        className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl border border-line bg-fill-subtle text-xs hover:bg-fill cursor-pointer transition-colors">
        <span className={badgeCls}>{initial(current.name)}</span>
        <span className="font-medium text-primary max-w-[90px] sm:max-w-[140px] truncate">{current.name}</span>
        <ChevronDown className="w-3 h-3 text-faint shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-11 z-40 w-56 rounded-xl border border-line bg-surface-raised shadow-2xl py-1.5">
            <div className="px-3 py-1.5 text-micro font-medium uppercase tracking-widest text-faint">Workspaces</div>
            {workspaces.map(w => (
              <button key={w.id} onClick={() => { switchWorkspace(w.id); setOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-fill hover:text-primary transition-colors">
                <span className={badgeCls}>{initial(w.name)}</span>
                <span className="flex-1 truncate text-left">{w.name}</span>
                {w.id === currentWorkspaceId && <Check className="w-3.5 h-3.5 text-brand-text shrink-0" />}
              </button>
            ))}
            {pendingInvites.length > 0 && (
              <>
                <div className="my-1 h-px bg-fill-strong" />
                <div className="px-3 py-1.5 text-micro font-medium uppercase tracking-widest text-faint">Invitations</div>
                {pendingInvites.map(inv => (
                  <button key={inv.id} onClick={() => { setOpen(false); acceptInvitation(inv.token).catch(err => reportError(err, 'invitations.accept')); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-fill hover:text-primary transition-colors">
                    <span className="w-4 h-4 rounded-md bg-success/20 border border-success-hover/30 flex items-center justify-center shrink-0"><UserPlus className="w-2.5 h-2.5 text-success-text" /></span>
                    <span className="flex-1 text-left truncate">Join {inv.workspaceName}</span>
                  </button>
                ))}
              </>
            )}
            <div className="my-1 h-px bg-fill-strong" />
            <button onClick={() => { setOpen(false); if (entitlements.atWorkspaceLimit) requestUpgrade('workspaces'); else setCreateOpen(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-fill hover:text-primary transition-colors">
              <span className="w-4 h-4 rounded-md border border-dashed border-line-strong flex items-center justify-center shrink-0"><Plus className="w-2.5 h-2.5" /></span>
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
    live: 'bg-success-hover shadow-[0_0_8px_rgba(52,211,153,0.6)]',
    connecting: 'bg-warning-hover animate-pulse',
    offline: 'bg-danger-hover',
  }[syncStatus];
  const syncLabel = { live: 'Synced', connecting: 'Connecting…', offline: 'Offline' }[syncStatus];

  return (
    <>
    <header className="sticky top-0 z-20 border-b border-line-subtle bg-surface/80 backdrop-blur-xl">
      <div className="flex items-center gap-2 px-4 lg:px-6 h-14">
        <div className="lg:hidden flex items-center gap-2 mr-2">
          <div className="w-7 h-7 rounded-md bg-brand-gradient flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-brand-fg" />
          </div>
        </div>

        <WorkspaceSwitcher />

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
          <input id="global-search" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            placeholder="Search tasks… ( / )"
            className="search-input w-full bg-input border border-line rounded-xl pl-9 pr-8 h-9 text-sm text-primary placeholder-faint outline-none focus:border-brand-hover/50 focus:bg-input-focus transition-colors" />
          {filters.search && (
            <button onClick={() => setFilters(f => ({ ...f, search: '' }))} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-faint hover:text-secondary hover:bg-fill-strong transition-colors">
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

        <div className="hidden md:flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-line-subtle bg-fill-subtle" title={syncLabel}>
          <span className={cx('w-1.5 h-1.5 rounded-full transition-colors', syncDot)} />
          <span className="text-micro font-medium text-muted">{syncLabel}</span>
        </div>

        <div className="flex items-center gap-1.5">
          {view === 'kanban' && (
            <IconButton icon={compact ? Maximize2 : Minimize2} label="Toggle compact" active={compact} onClick={() => setCompact(c => !c)} />
          )}
          <IconButton icon={Command} label={`Command palette (${shortcutLabel('K')})`} onClick={() => setPaletteOpen(true)} />
          <button onClick={() => setQuickAddOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-inverse text-inverse-fg text-xs font-semibold hover:bg-inverse/90 transition-colors">
            <Plus className="w-3.5 h-3.5" />New<kbd className="hidden sm:inline text-[9px] text-inverse-fg/50 bg-inverse-fg/10 rounded px-1 py-0.5">N</kbd>
          </button>
          <NotificationBell />
          <div className="relative">
            {/* The account menu trigger IS your avatar (the near-universal convention). Nothing is lost:
                settings, theme, export/import, plans and sign-out all still live inside this menu. */}
            <button onClick={() => setMenuOpen(o => !o)} aria-label="Account and settings" aria-expanded={menuOpen}
              className="rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-hover/60 hover:opacity-80 transition-opacity">
              <Avatar name={currentMember?.display_name || currentMember?.email} userId={meId} photoUrl={currentMember?.avatar_url} size={28} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border border-line bg-surface-raised shadow-2xl py-1.5">
                  {currentMember && (
                    <div className="px-3 py-2.5 border-b border-line-subtle flex items-start gap-2.5">
                      <Avatar name={currentMember.display_name || currentMember.email} userId={meId} photoUrl={currentMember.avatar_url} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-primary truncate">
                          {currentMember.status_emoji && <span className="mr-1">{currentMember.status_emoji}</span>}
                          {currentMember.display_name || currentMember.email}
                        </div>
                        <div className="text-micro text-faint mt-0.5 capitalize truncate">{myRole || currentMember.role} · <span className="text-brand-text/80 normal-case">{entitlements.plan.name}</span></div>
                        <div className="text-micro text-faint mt-0.5 truncate normal-case">{currentMember.status_text || currentMember.email}</div>
                      </div>
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
                  <div className="h-px bg-fill my-1" />
                  <MenuItem icon={Sparkles} onClick={() => { setMenuOpen(false); navigate('/pricing'); }}>Plans &amp; pricing</MenuItem>
                  <MenuItem icon={FileText} onClick={() => { setMenuOpen(false); navigate('/terms'); }}>Terms of Service</MenuItem>
                  <MenuItem icon={Shield} onClick={() => { setMenuOpen(false); navigate('/privacy'); }}>Privacy Policy</MenuItem>
                  <MenuItem icon={User} onClick={() => { setProfileOpen(true); setMenuOpen(false); }}>Edit profile</MenuItem>
                  <MenuItem icon={KeyRound} onClick={() => { setPasswordModalOpen(true); setMenuOpen(false); }}>Change password</MenuItem>
                  <div className="h-px bg-fill my-1" />
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
 * via membersApi.updateProfile; the server validates (role-title impersonation, length, and that
 * avatar_url is a bare storage path in the caller's OWN uid folder) so a rejection surfaces inline.
 * Avatar uploads to the caller's own folder in the PRIVATE avatars bucket and stores the resulting
 * storage PATH — never a URL, because a private bucket has no stable one; rendering mints a
 * short-lived signed URL at paint time. Saving re-syncs the top bar (refreshCurrentMember) AND the
 * workspace roster (refreshMembers) so every identity surface reflects the edit immediately.
 */
/** Status emojis offered by the profile picker. Every entry is verified against the server's emoji-only
 *  rule (members_validate_profile: no letters/digits, no letter-like symbols — checked live, 32/32 accept),
 *  and the picker is the ONLY way to set status_emoji, so the client can never submit a value the DB rejects. */
const STATUS_EMOJIS = ['🟢','🟡','🔴','🔵','⚪','🔥','☕','🎯','✅','🚀','💡','📌','🛠️','💻','📞','🎧',
  '🧠','⏳','🌴','🏖️','🤒','🚗','🍕','🌙','⚡','✨','🎉','👀','💬','📚','🏃','😴'];

function ProfileModal({ onClose }) {
  const { currentMember, refreshCurrentMember, refreshMembers, theme } = useApp();
  const light = theme === 'light';
  const [displayName, setDisplayName] = useState(() => currentMember?.display_name || '');
  const [statusText, setStatusText] = useState(() => currentMember?.status_text || '');
  const [statusEmoji, setStatusEmoji] = useState(() => currentMember?.status_emoji || '');
  const [bio, setBio] = useState(() => currentMember?.bio || '');
  // avatar_url now holds a storage PATH (private bucket). `avatarPath` is what will be saved; `preview`
  // is a transient blob: URL for instant feedback on a fresh pick (the signed URL for a just-uploaded
  // object would otherwise take a round trip to appear). `savedPathRef` is the persisted value at open,
  // held so we can (a) never delete it until a successful replacement saves, and (b) tell an abandoned
  // session upload apart from the real saved object.
  const [avatarPath, setAvatarPath] = useState(() => currentMember?.avatar_url || null);
  const [preview, setPreview] = useState(null);
  const savedPathRef = useRef(currentMember?.avatar_url || null);
  const previewRef = useRef(null);   // current blob URL, so we can revoke the previous one
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => { setTimeout(() => panelRef.current?.focus(), 30); }, []);
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const setPreviewBlob = (url) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreview(url);
  };
  // A path is an ABANDONED session upload (safe to delete) iff it exists and is not the saved object.
  const dropIfAbandoned = (path) => {
    if (path && path !== savedPathRef.current) membersApi.removeAvatar(path).catch(logCaught('avatars.remove'));
  };

  const pickAvatar = async (file) => {
    if (!file) return;
    setErr(''); setBusy(true);
    try {
      const newPath = await membersApi.uploadAvatar(file);
      dropIfAbandoned(avatarPath);          // replacing a photo re-picked this session — don't leak it
      setAvatarPath(newPath);
      setPreviewBlob(URL.createObjectURL(file));   // instant preview; the signed URL catches up in the roster
    } catch (e) { setErr(e?.message || 'Avatar upload failed.'); }
    finally { setBusy(false); }
  };

  const removePhoto = () => {
    dropIfAbandoned(avatarPath);            // an unsaved session upload is deleted now; a saved one waits for save
    setAvatarPath(null);
    setPreviewBlob(null);
  };

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await membersApi.updateProfile({ displayName, statusText, statusEmoji, bio, avatarUrl: avatarPath });
      // The replaced/removed SAVED object is now orphaned — delete it (re-upload deletes the previous).
      // Only after the save commits, because until then it is still the live avatar.
      if (savedPathRef.current && savedPathRef.current !== avatarPath) {
        membersApi.removeAvatar(savedPathRef.current).catch(logCaught('avatars.remove'));
      }
      savedPathRef.current = avatarPath;    // so a later close in this session won't delete what we just saved
      // BOTH refreshes: currentMember drives only the top bar; every roster-driven surface (sidebar
      // card, chat facepile, DM list, Members page, comment headers, the profile card itself) reads
      // the workspace roster, which without refreshMembers() kept the old name/photo until a reload.
      await Promise.all([refreshCurrentMember?.(), refreshMembers?.()]);
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not save your profile.');
      setBusy(false);
    }
  };

  // Cancel / backdrop / Escape: an upload made this session but never saved is garbage — delete it now
  // rather than leaving it for the hourly sweep (the bucket is private, so a leak is workspace-readable,
  // not world-readable, but eager cleanup is still right). save() calls onClose directly and never
  // routes here, so a just-saved object is never touched.
  const handleClose = () => { dropIfAbandoned(avatarPath); onClose(); };

  return createPortal(
    <>
      {/* z-[80]: ProfileModal must layer ABOVE ProfileView (z-[70]) — "Edit profile" inside the profile
          card mounts this as a sibling body portal, and at the old z-[60] the editor painted invisibly
          BEHIND the card (clicking seemed to do nothing while focus sat in the hidden panel). */}
      <div className="fixed inset-0 z-[80] bg-overlay backdrop-blur-sm" onClick={handleClose} />
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Edit profile"
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-line bg-surface-raised shadow-2xl p-5 outline-none max-h-[85vh] overflow-y-auto"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); handleClose(); } }}>
          <h2 className="text-base font-semibold text-primary mb-4">Edit profile</h2>

          <div className="flex items-center gap-3 mb-4">
            <Avatar name={displayName || currentMember?.email} userId={currentMember?.id} photoUrl={preview || avatarPath} size={56} />
            <div className="flex flex-col gap-1.5">
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="h-8 px-3 rounded-lg bg-fill border border-line text-xs font-medium text-secondary hover:bg-fill-strong transition-colors disabled:opacity-50">
                {busy ? 'Working…' : 'Upload photo'}
              </button>
              {(preview || avatarPath) && <button onClick={removePhoto} className="text-meta text-faint hover:text-danger-text text-left">Remove photo</button>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; pickAvatar(f); }} />
            </div>
          </div>

          <label className="block text-meta text-muted mb-1">Display name</label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={60}
            className="w-full h-9 px-3 mb-3 rounded-xl bg-fill border border-line text-xs text-primary outline-none focus:border-brand-hover/50" />

          <label className="block text-meta text-muted mb-1">Status</label>
          <div className="flex gap-2 mb-2">
            <button type="button" onClick={() => setEmojiOpen(o => !o)} aria-expanded={emojiOpen} aria-label="Pick a status emoji"
              className={cx('w-14 h-9 rounded-xl border flex items-center justify-center text-base transition-colors',
                emojiOpen ? 'border-brand-hover/50 bg-brand/20' : 'border-line bg-fill hover:bg-fill-strong')}>
              {statusEmoji || <Plus className="w-3.5 h-3.5 text-faint" />}
            </button>
            <input value={statusText} onChange={e => setStatusText(e.target.value)} maxLength={80} placeholder="What are you up to?" aria-label="Status text"
              className="flex-1 h-9 px-3 rounded-xl bg-fill border border-line text-xs text-primary outline-none focus:border-brand-hover/50" />
          </div>
          {/* An INLINE grid, not a floating popover: the modal panel is overflow-y-auto, which would clip an
              absolutely-positioned one. Picking is the only input path — the server accepts emoji only, so a
              free-text field was never a valid way to set this. */}
          {/* Theme-aware like Avatar: bg-input read as a dark slab once the light overrides turned
              the modal panel white, and the white-alpha hover was invisible on it. */}
          {emojiOpen && (
            <div className={cx('mb-3 p-2 rounded-xl border border-line', light ? 'bg-fill' : 'bg-input')}>
              <div className="grid grid-cols-8 gap-1">
                {STATUS_EMOJIS.map(em => (
                  <button key={em} type="button" onClick={() => { setStatusEmoji(em); setEmojiOpen(false); }} aria-label={`Status emoji ${em}`}
                    className={cx('h-8 rounded-lg text-base transition-colors', light ? 'hover:bg-fill-strong' : 'hover:bg-fill-strong',
                      statusEmoji === em && 'bg-brand/20 ring-1 ring-brand-hover/50')}>{em}</button>
                ))}
              </div>
              {statusEmoji && (
                <button type="button" onClick={() => { setStatusEmoji(''); setEmojiOpen(false); }}
                  className="mt-1.5 w-full h-7 rounded-lg text-meta text-muted hover:text-danger-text hover:bg-fill transition-colors">Clear emoji</button>
              )}
            </div>
          )}

          <label className="block text-meta text-muted mb-1">Bio</label>
          <textarea value={bio} onChange={e => setBio(e.target.value)} maxLength={280} rows={3}
            className="w-full px-3 py-2 rounded-xl bg-fill border border-line text-xs text-primary outline-none focus:border-brand-hover/50 resize-none" />
          <div className="text-micro text-faint text-right mb-3">{bio.length}/280</div>

          {err && <p className="text-xs text-danger-text mb-3 break-words">{err}</p>}

          <div className="flex items-center justify-end gap-2">
            <button onClick={handleClose}
              className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">Cancel</button>
            <button onClick={save} disabled={busy}
              className="h-9 px-4 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg text-xs font-semibold transition-colors disabled:opacity-50">Save</button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
/**
 * Wraps identity content (an avatar, a name, or both) in a keyboard-accessible control that opens that
 * person's ProfileView. Falls back to a plain <span> when there's nobody to open (an unassigned chip, a
 * former member), so callers never have to branch. stopPropagation by default: most identity surfaces sit
 * inside something else clickable (a task card, a conversation row), and opening a profile must not also
 * trigger that. NB: never render this INSIDE another <button> — that's invalid DOM; restructure the parent
 * into sibling buttons instead (see the DM conversation row).
 */
function PersonButton({ personId, children, className, title }) {
  const { openProfile } = useApp();
  if (!personId) return <span className={cx('inline-flex items-center', className)}>{children}</span>;
  return (
    <button type="button" title={title || 'View profile'}
      onClick={e => { e.stopPropagation(); e.preventDefault(); openProfile(personId); }}
      className={cx('inline-flex items-center rounded-md hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-hover/60 transition-opacity', className)}>
      {children}
    </button>
  );
}

/**
 * The profile view — the payoff that makes avatar / status / bio mean anything. Opened from any identity
 * surface via openProfile(id); exactly one instance is mounted (AppShell). Read-only for other people;
 * your own row gets "Edit profile", which reuses ProfileModal rather than shipping a second editor.
 *
 * Data comes from personOf() — i.e. the workspace roster the app already loads, so there is no new fetch
 * and no new read path. email/bio arrive NULL for a GUEST viewer (workspace_members_list withholds them
 * server-side) so those rows simply don't render — the guest scoping needs no client logic. A missing
 * roster row means different things by viewer: for a member/admin/owner the roster is complete, so the
 * person has LEFT; for a GUEST the roster is row-scoped server-side (self + task co-participants + DM
 * peers), so an ACTIVE member can be absent — that gets the "limited" state, never a false "has left".
 *
 * Portaled to <body> — which does NOT keep it dark. data-theme is stamped on <html>, and the design
 * tokens are declared there, so a portaled node inherits the light values like any other node: in
 * light mode this panel renders LIGHT like every other modal. (An earlier comment claimed the
 * opposite; it was wrong then, and it is wrong now for a different reason.)
 */
function ProfileView() {
  const { profileUserId, closeProfile, personOf, startDm, isGuest } = useApp();
  const [editing, setEditing] = useState(false);
  const [dmErr, setDmErr] = useState('');
  const [dmBusy, setDmBusy] = useState(false);
  const panelRef = useRef(null);
  // Mirrors the CURRENT profile id so a startDm result that lands after Close (or after switching
  // profiles) is discarded — the component stays mounted across close/reopen, so an unguarded late
  // setDmErr would resurface as a stale error on the NEXT profile anyone opens.
  const openIdRef = useRef(null);
  useEffect(() => {
    openIdRef.current = profileUserId;
    if (profileUserId) setTimeout(() => panelRef.current?.focus(), 30);
  }, [profileUserId]);
  if (!profileUserId) return null;

  const p = personOf(profileUserId);
  const close = () => { setEditing(false); setDmErr(''); closeProfile(); };
  const message = async () => {
    if (dmBusy) return;   // double-click guard: two racing startDm calls double-navigate + double-fetch
    setDmBusy(true); setDmErr('');
    const forId = p.id;
    try {
      await startDm?.(forId);                         // success navigates to the thread…
      if (openIdRef.current === forId) close();       // …close only if this profile is still the open one
    } catch (e) {
      reportError(e, 'dms.start from profile');
      if (openIdRef.current === forId) setDmErr("Couldn't start the conversation. Please try again.");
    } finally { setDmBusy(false); }
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[70] bg-overlay backdrop-blur-sm" onClick={close} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-6 pointer-events-none">
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={p ? `${p.name} profile` : 'Profile'}
          className="pointer-events-auto w-full max-w-sm rounded-2xl border border-line bg-surface-raised shadow-2xl p-5 outline-none"
          style={{ animation: 'slideUp .2s ease' }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>

          {!p ? (
            /* Guest viewers get a row-scoped roster, so "not in MY roster" ≠ "has left" — claiming
               "no longer in this workspace" about an active admin was simply false. */
            <div className="text-center py-4">
              <Avatar name="" userId={profileUserId} size={72} className="mx-auto mb-3" />
              <h2 className="text-base font-semibold text-primary mb-1">{isGuest ? 'Profile unavailable' : 'No longer in this workspace'}</h2>
              <p className="text-xs text-muted">
                {isGuest
                  ? 'As a guest you can see full profiles only for people on your tasks or in your direct messages.'
                  : "This person has left, so their profile isn't available here."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center text-center">
                <Avatar name={p.name} userId={p.id} photoUrl={p.avatarUrl} size={72} className="mb-3" />
                <h2 className="text-base font-semibold text-primary break-words">{p.name}{p.isSelf && <span className="text-faint font-normal"> (you)</span>}</h2>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-micro uppercase tracking-wide px-2 py-0.5 rounded-full border border-line bg-fill text-muted">{p.role}</span>
                </div>
                {(p.statusEmoji || p.statusText) && (
                  <div className="mt-3 inline-flex items-center gap-1.5 max-w-full px-2.5 py-1 rounded-full bg-fill border border-line">
                    {p.statusEmoji && <span className="text-sm leading-none">{p.statusEmoji}</span>}
                    {p.statusText && <span className="text-xs text-secondary truncate">{p.statusText}</span>}
                  </div>
                )}
                {p.bio && <p className="mt-3 text-xs text-muted leading-relaxed whitespace-pre-wrap break-words">{p.bio}</p>}
                {p.email && <p className="mt-3 text-meta text-faint break-all">{p.email}</p>}
              </div>

              {dmErr && <p className="mt-3 text-xs text-danger-text text-center break-words">{dmErr}</p>}

              <div className="flex items-center justify-end gap-2 mt-5">
                <button onClick={close}
                  className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">Close</button>
                {p.isSelf ? (
                  <button onClick={() => setEditing(true)}
                    className="h-9 px-4 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg text-xs font-semibold transition-colors inline-flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" />Edit profile
                  </button>
                ) : (
                  /* Failure keeps the card OPEN with an inline error — the old handler closed
                     immediately and swallowed the rejection, so a failed start looked like a no-op. */
                  <button onClick={message} disabled={dmBusy}
                    className="h-9 px-4 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-50">
                    <MessageSquare className="w-3.5 h-3.5" />{dmBusy ? 'Opening…' : 'Message'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {editing && <ProfileModal onClose={() => setEditing(false)} />}
    </>,
    document.body
  );
}
function MenuItem({ icon: Icon, children, onClick }) {
  return <button onClick={onClick} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-fill hover:text-primary transition-colors">
    <Icon className="w-3.5 h-3.5" />{children}
  </button>;
}
function FilterPill({ label, value, options, onChange }) {
  const current = options.find(([v]) => v === value);
  const currentLabel = current ? current[1] : value;
  return (
    <div className="relative inline-flex items-center gap-1.5 rounded-lg border border-line bg-fill-subtle hover:bg-fill px-2.5 h-9 text-xs cursor-pointer transition-colors shrink-0">
      <Filter className="w-3 h-3 text-faint shrink-0" />
      <span className="text-faint shrink-0">{label}:</span>
      <span className="text-primary font-medium">{currentLabel}</span>
      <ChevronDown className="w-3 h-3 text-faint shrink-0" />
      <select value={value} onChange={e => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
        {options.map(([v,l]) => <option key={v} value={v} className="bg-surface-raised text-primary">{l}</option>)}
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
        <h1 className="text-2xl lg:text-3xl font-semibold text-primary font-display tracking-tight" style={{ letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle && <p className="text-sm text-faint mt-1">{subtitle}</p>}
      </div>
      {accent && <div className="hidden sm:block text-micro uppercase tracking-widest text-faint">{accent}</div>}
    </div>
  );
}

function Card({ children, className, title, subtitle, action, accent }) {
  return (
    <section className={cx('relative rounded-2xl border border-line-subtle bg-gradient-to-br from-fill-subtle to-fill-subtle overflow-hidden', className)}>
      {accent && <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />}
      {(title || action) && (
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div>
            {title && <h3 className="text-compact font-semibold text-primary font-display tracking-tight">{title}</h3>}
            {subtitle && <p className="text-meta text-faint mt-0.5">{subtitle}</p>}
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
        <ViewHeader title="Home" subtitle="Your team's tasks, priorities, and messages in one place." accent={new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric'})} />
        <FirstRunPanel />
      </div>
    );
  }

  const open = tasks.filter(t => t.status !== 'done');
  const ranked = [...open].map(t => ({ t, s: getUpNextScore(t) })).sort((a,b) => b.s - a.s);
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
      <ViewHeader title="Home" subtitle="Today's ranked priorities, flagged blockers, and where your energy should go." accent={new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric'})} />

      <Card title="Up next" subtitle="Auto-ranked by priority, due date, urgency, and blockers." accent="#7c8cff">
        {top3.length === 0 ? (
          <EmptyState icon={Sparkles} text="Nothing on fire. Beautiful." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {top3.map((r, i) => (
              <div key={r.t.id} className="relative">
                <div className="absolute -top-2 -left-2 z-10 w-7 h-7 rounded-full bg-brand text-brand-fg text-xs font-bold flex items-center justify-center shadow-lg shadow-brand/15 font-display">
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
        <StatCard label="My tasks" value={counts.mine} color="#7c8cff" icon={<span className="w-2 h-2 rounded-full" style={{background:'#7c8cff'}} />} onClick={() => setView('mine')} />
        <StatCard label="Assigned to others" value={counts.others} color="#34d399" icon={<span className="w-2 h-2 rounded-full" style={{background:'#34d399'}} />} onClick={() => setView('kanban')} />
        <StatCard label="Unassigned" value={counts.unassigned} color={UNASSIGNED_STYLE.hex} icon={<span className="w-2 h-2 rounded-full" style={{background:UNASSIGNED_STYLE.hex}} />} onClick={() => setView('kanban')} />
        <StatCard label="Completed this week" value={counts.doneWeek} color="#34d399" icon={<CheckCircle2 className="w-3 h-3 text-success-text" />} />
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
                  <span className="text-secondary font-medium">{pr.label}</span>
                </div>
                <div className="flex-1 h-2 bg-fill rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${(c/max)*100}%`, background: pr.hex, boxShadow: `0 0 12px ${pr.glow}` }} />
                </div>
                <div className="w-8 text-right text-xs font-semibold text-secondary tabular-nums">{c}</div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="My upcoming" subtitle="Tasks assigned to you, by due date" accent="#7c8cff" action={<button onClick={() => setView('mine')} className="text-meta text-faint hover:text-secondary inline-flex items-center gap-0.5">See all <ChevronRight className="w-3 h-3" /></button>}>
          {myUpcoming.length === 0 ? <EmptyState icon={Calendar} text="No upcoming tasks. Nothing on your plate." /> :
            <div className="space-y-2">{myUpcoming.map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}</div>}
        </Card>
        <Card title="Assigned to others" subtitle="What your teammates are working on" accent="#34d399" action={<button onClick={() => setView('kanban')} className="text-meta text-faint hover:text-secondary inline-flex items-center gap-0.5">See all <ChevronRight className="w-3 h-3" /></button>}>
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
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--color-fill-strong)" strokeWidth="3" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="url(#g1)" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={`${(progress / 100) * 94.2478} 94.2478`} />
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                  {/* Progress IS the sanctioned Flow Mint moment: brand blue resolving into mint
                      as the ring completes. Not a decorative gradient — it carries the meaning. */}
                  <stop offset="0%" stopColor="#5b67f1" />
                  <stop offset="100%" stopColor="#3dd6b3" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-primary font-display">{progress}%</div>
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
    <Tag onClick={onClick} className={cx('relative text-left rounded-2xl border border-line-subtle bg-gradient-to-br from-fill-subtle to-fill-subtle p-4 overflow-hidden group transition-all w-full',
      onClick && 'hover:border-line hover:-translate-y-0.5 cursor-pointer')}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full opacity-20 blur-2xl" style={{ background: color }} />
      <div className="relative">
        <div className="flex items-center gap-1.5 text-micro uppercase tracking-widest text-faint mb-2">{icon}{label}</div>
        <div className="text-3xl font-semibold text-primary font-display tabular-nums" style={{ color }}>{value}</div>
      </div>
    </Tag>
  );
}
function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-line-subtle bg-fill-subtle py-2">
      <div className="text-xl font-semibold text-primary font-display tabular-nums">{value}</div>
      <div className="text-micro uppercase tracking-widest text-faint">{label}</div>
    </div>
  );
}
function MiniRow({ task, onClick, showBlocked, showTime }) {
  const due = formatDue(task.dueDate);
  const { projects } = useApp();
  const proj = projects.find(p => p.id === task.project);
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 p-2 -mx-2 rounded-lg hover:bg-fill text-left transition-colors group">
      <PriorityDot priority={task.priority} />
      <div className="flex-1 min-w-0">
        <div className="text-compact text-primary font-medium truncate">{task.title}</div>
        <div className="flex items-center gap-2 mt-0.5 text-micro text-faint">
          <span style={{ color: proj?.color }}>{proj?.icon} {proj?.name}</span>
          {due && <><span>·</span><span className={cx(due.tone==='overdue' && 'text-danger-text', due.tone==='today' && 'text-warning-text')}>{due.label}</span></>}
          {showTime && <><span>·</span><span>{new Date(task.updatedAt).toLocaleDateString(undefined, { month:'short', day:'numeric'})}</span></>}
          {showBlocked && task.blocked && <><span>·</span><span className="text-danger-text">blocked</span></>}
        </div>
      </div>
      <AssigneeChip assigneeId={task.assigneeId} showLabel={false} />
    </button>
  );
}
function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <div className="w-10 h-10 rounded-full bg-fill flex items-center justify-center mb-2">
        <Icon className="w-4 h-4 text-faint" />
      </div>
      {title && <div className="text-sm font-medium text-secondary mb-0.5">{title}</div>}
      <div className="text-xs text-faint">{text}</div>
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
    <div className="relative rounded-3xl border border-line-subtle bg-gradient-to-br from-brand/[0.10] via-brand-alt/[0.05] to-transparent p-6 sm:p-8 overflow-hidden">
      <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-brand/10 blur-3xl pointer-events-none" />
      <div className="relative max-w-xl">
        <div className="w-11 h-11 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-lg shadow-brand/15 mb-4">
          <Sparkles className="w-5 h-5 text-brand-fg" />
        </div>
        <h2 className="text-2xl font-semibold text-primary font-display tracking-tight">Welcome to Corlyvo</h2>
        <p className="mt-2 text-sm text-muted leading-relaxed">
          One shared place for who’s doing what — tasks, a board, and your schedule, plus team chat and
          direct messages. Start by adding your first task.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={() => setQuickAddOpen(true)}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-xl bg-inverse text-inverse-fg text-sm font-semibold hover:bg-inverse/90 transition-colors">
            <Plus className="w-4 h-4" />Create your first task
          </button>
          <span className="text-meta text-faint">or press <kbd className="px-1.5 py-0.5 rounded bg-fill-strong border border-line font-medium text-muted">N</kbd></span>
        </div>

        {!hintsOff && (
          <div className="mt-7">
            <div className="flex items-center justify-between mb-2.5">
              <div className="text-micro font-medium uppercase tracking-widest text-faint">A few things to try</div>
              <button onClick={dismissHints} className="text-meta text-faint hover:text-secondary transition-colors">Dismiss</button>
            </div>
            <div className="grid sm:grid-cols-3 gap-2.5">
              {hints.map(h => (
                <button key={h.label} onClick={h.go}
                  className="text-left rounded-2xl border border-line-subtle bg-fill-subtle p-3.5 hover:bg-fill hover:border-line transition-colors group">
                  <h.icon className="w-4 h-4 text-brand-text mb-2" />
                  <div className="text-compact font-medium text-primary">{h.label}</div>
                  <div className="text-meta text-faint mt-0.5 leading-snug">{h.desc}</div>
                  <div className="mt-2 text-meta font-medium text-brand-text/80 inline-flex items-center gap-0.5 group-hover:text-brand-text-hover-hover">{h.cta}<ChevronRight className="w-3 h-3" /></div>
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
  const { startDraftTask, filters, meId, projects } = useApp();
  // "+ Add task" creates a row (status pre-set to this column, defaults from the active filters) and opens
  // the full TaskModal on it; an abandoned empty draft is auto-removed on close (AppProvider.closeEditing).
  const add = () => startDraftTask({
    status,
    assigneeId: filters.assignee === 'me' ? meId : (filters.assignee === 'unassigned' ? null : (filters.assignee !== 'all' ? filters.assignee : meId)),
    project: filters.project !== 'all' ? filters.project : defaultProjectId(projects, 'other'),
    privacy: filters.privacy !== 'all' ? filters.privacy : 'workspace',
  });
  return (
    <button onClick={add} type="button"
      className="w-full flex items-center justify-center gap-1.5 py-2 text-meta text-faint hover:text-primary hover:bg-fill border border-dashed border-line hover:border-line-strong rounded-lg transition-colors">
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
        over ? 'border-line-strong bg-fill' : 'border-line-subtle bg-fill-subtle')}>
      <div className="px-4 pt-4 pb-3 border-b border-line-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: columnAccent, boxShadow: `0 0 8px ${columnAccent}99` }} />
          <h4 className="text-sm font-semibold text-primary font-display tracking-tight">{column.label}</h4>
          <span className="text-micro text-faint bg-fill border border-line rounded-md px-1.5 h-4 flex items-center">{tasks.length}</span>
        </div>
      </div>
      <div className="p-2 space-y-2 min-h-[120px] max-h-[calc(100vh-240px)] overflow-y-auto">
        {column.id !== 'done' && <ColumnQuickAdd status={column.id} />}
        {tasks.length === 0 ? (
          <div className="text-center py-6 text-meta text-faint">{column.hint}</div>
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
      <div data-surface="inverted" className="relative rounded-3xl border border-line-subtle bg-hero-private p-6 overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-brand/10 blur-3xl" />
        <div className="absolute bottom-0 left-20 w-64 h-64 rounded-full bg-brand/[0.06] blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-line bg-input backdrop-blur px-2.5 h-6 text-micro font-medium uppercase tracking-widest text-secondary mb-3">
              <Lock className="w-3 h-3" />Private · you + assignee
            </div>
            <h1 className="text-3xl lg:text-4xl font-semibold text-primary font-display tracking-tight" style={{letterSpacing:'-0.02em'}}>Private tasks</h1>
            <p className="text-sm text-muted mt-2 max-w-md">Private tasks are visible only to you and anyone they're assigned to, never the whole workspace.</p>
          </div>
          <button onClick={() => setQuickAddOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-inverse text-inverse-fg text-xs font-semibold hover:bg-inverse/90">
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
        <h3 className="text-meta font-semibold uppercase tracking-widest text-muted">{title}</h3>
        <span className="text-micro text-faint">{tasks.length}</span>
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
      <div data-surface="inverted" className="relative rounded-3xl border border-line-subtle bg-hero-mine p-6 overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 rounded-full bg-success/10 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2.5 h-6 text-micro font-medium uppercase tracking-widest text-success-text mb-3">
              <UserCog className="w-3 h-3" />Assigned to me
            </div>
            <h1 className="text-3xl lg:text-4xl font-semibold text-primary font-display tracking-tight">My Tasks</h1>
            <p className="text-sm text-muted mt-2">Everything assigned to you. Prioritize and get it done.</p>
          </div>
          <button onClick={() => setQuickAddOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-success text-inverse-fg text-xs font-semibold hover:bg-success-hover">
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
                {t.blockedReason && <div className="mt-1 ml-2 text-meta text-danger-text/80 italic">↳ {t.blockedReason}</div>}
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
    <div className="rounded-xl border border-line bg-input backdrop-blur p-3">
      <div className="text-micro uppercase tracking-widest text-muted mb-1">{label}</div>
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
        over ? 'border-line-strong bg-fill' : 'border-line-subtle bg-fill-subtle')}>
      <div className="pointer-events-none absolute inset-x-6 -top-10 h-20 rounded-full opacity-40 blur-2xl" style={{ background: accent }} />
      <div className="relative flex items-start justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-primary font-display" style={{ color: accent }}>{title}</h4>
          <p className="text-meta text-faint mt-0.5">{subtitle}</p>
        </div>
        <span className="text-micro text-faint bg-fill border border-line rounded-md px-1.5 h-5 flex items-center">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="relative flex items-center justify-center h-40 text-meta text-faint italic">Drop tasks here</div>
      ) : (
        <div className="relative space-y-2">
          {tasks.slice(0, 6).map(t => <TaskCard key={t.id} task={t} compact onClick={() => setEditingTask(t)} />)}
          {tasks.length > 6 && <div className="text-meta text-faint pl-1">+ {tasks.length - 6} more</div>}
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

      <div className="hidden md:flex items-center justify-center gap-2 text-micro font-semibold uppercase tracking-widest text-secondary md:ml-10">
        <Flame className="w-3.5 h-3.5 text-danger-text" />
        <span>More urgent →</span>
      </div>

      <div className="flex gap-3 md:gap-4">
        <div className="hidden md:flex items-center justify-center w-7 shrink-0" aria-hidden>
          <div
            className="flex items-center gap-2 text-micro font-semibold uppercase tracking-widest text-secondary whitespace-nowrap"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            <TrendingUp className="w-3.5 h-3.5 text-brand-text" />
            <span>More important →</span>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 min-w-0">
          <MatrixQuad id="q1" title="Do first"  subtitle="Urgent + Important"          tasks={quadrants.q1} accent="#f43f5e" />
          <MatrixQuad id="q2" title="Schedule"  subtitle="Important, not urgent"       tasks={quadrants.q2} accent="#7c8cff" />
          <MatrixQuad id="q3" title="Delegate"  subtitle="Urgent, not important"       tasks={quadrants.q3} accent="#fb923c" />
          <MatrixQuad id="q4" title="Eliminate" subtitle="Consider dropping" tasks={quadrants.q4} accent="#64748b" />
        </div>
      </div>

      <div className="flex items-center gap-2 text-meta text-faint justify-center text-center px-4">
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
      .catch(err => { reportError(err, 'projects.taskCount'); if (alive) setDeleteCount(-1); });
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
        <div className="text-meta text-faint">{projects.length} project{projects.length === 1 ? '' : 's'}</div>
        {canManage && (
          <button onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-fill border border-line text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">
            <Plus className="w-3.5 h-3.5" /> New project
          </button>
        )}
      </div>
      {projects.length === 0 && (
        <Card>
          <EmptyState icon={FolderKanban} title="No projects yet"
            text="Projects group your tasks by where they live — a client, an area, a workstream."
            action={canManage ? (
              <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-inverse text-inverse-fg text-xs font-semibold hover:bg-inverse/90 transition-colors">
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
            <section key={p.id} className={cx('group relative rounded-2xl border border-line-subtle bg-gradient-to-br from-fill-subtle to-transparent p-5 overflow-hidden',
              exitingProjectIds.has(p.id) && 'animate-[fadeSlideOut_.18s_ease_forwards]')}>
              <div className="absolute top-0 right-0 w-40 h-40 rounded-full blur-3xl opacity-20" style={{ background: p.color }} />
              <div className="relative">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold" style={{ background: p.color + '22', color: p.color, border: `1px solid ${p.color}44` }}>
                      {p.icon}
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-primary font-display">{p.name}</h3>
                      <div className="text-meta text-faint">{open.length} open · {done.length} done</div>
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button onClick={() => setEditTarget(p)} aria-label={`Edit ${p.name}`}
                        className="p-1.5 rounded-lg text-faint hover:text-secondary hover:bg-fill transition-colors">
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      {(isOwner || isAdmin) && (
                        <button onClick={() => { setDeleteCount(null); setDeleteTarget(p); }} aria-label={`Delete ${p.name}`}
                          className="p-1.5 rounded-lg text-faint hover:text-danger-text hover:bg-fill transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="h-1.5 bg-fill rounded-full overflow-hidden mb-4">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: p.color, boxShadow: `0 0 12px ${p.color}99` }} />
                </div>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {open.slice(0, 5).map(t => <MiniRow key={t.id} task={t} onClick={() => setEditingTask(t)} />)}
                  {open.length === 0 && <div className="text-meta text-faint italic py-4 text-center">No open tasks in {p.name}.</div>}
                  {open.length > 5 && <div className="text-meta text-faint pl-1">+ {open.length - 5} more</div>}
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
        projects={projects}
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
                d.isToday ? 'border-brand/30 bg-brand/[0.06]' :
                d.isPast ? 'border-line-subtle bg-fill-subtle opacity-70' :
                'border-line-subtle bg-fill-subtle')}>
              <div className="text-center">
                <div className="text-micro uppercase tracking-widest text-faint">{weekday}</div>
                <div className={cx('text-2xl font-semibold font-display tabular-nums leading-none mt-1', d.isToday ? 'text-brand-text' : 'text-primary')}>{dayNum}</div>
                <div className="text-micro text-faint mt-0.5">{month}</div>
                {d.isToday && <div className="inline-flex mt-2 text-[9px] font-semibold uppercase tracking-widest text-brand-text">Today</div>}
              </div>
              <div className="min-w-0">
                {d.tasks.length === 0 ? (
                  <div className="h-full flex items-center text-meta text-faint italic">Nothing scheduled</div>
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
    // App-level boundary OUTSIDE the provider: a render throw in AppProvider or the shell shows the
    // full-screen fallback instead of a white screen. Per-view boundaries live on the routes below.
    <ErrorBoundary name="app" fullScreen>
      <AppProvider session={session} currentMember={currentMember} onSignOut={onSignOut} refreshCurrentMember={refreshCurrentMember}>
        <AppShell />
      </AppProvider>
    </ErrorBoundary>
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
// Colors are INLINE rather than Tailwind classes. The original reason is now GONE: light mode used to
// be retrofitted by `[data-theme="light"]` rules living inside per-view <style> blocks, so a
// class-based fill was only themed while the view that declared the rule was mounted — which is why
// the bar washed out in a cold-loaded DM. Design tokens are global, so a class-based fill would now
// be correct everywhere too. Inline is retained because the waveform also needs per-bar computed
// values; if you convert it, `bg-fill`/`bg-brand` are the right tokens and the cold-load bug cannot
// return.
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

  if (failed) return <div className="mt-1 text-meta text-danger-text/70">Voice note unavailable</div>;

  const playedHex = light ? '#4650d6' : '#7c8cff';
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
        style={{ background: light ? 'rgba(70,80,214,0.14)' : 'rgba(91,103,241,0.25)', border: `1px solid ${playedHex}4d`, color: playedHex }}>
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 translate-x-px" />}
      </button>
      <div ref={barRef} onClick={onBarClick} onKeyDown={onBarKey} role="slider" tabIndex={pending ? -1 : 0}
        aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(current)}
        className="flex-1 h-7 flex items-center gap-[2px] cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-brand-hover/40">
        {peaks.map((p, i) => (
          <span key={i} aria-hidden="true"
            className="flex-1 rounded-full transition-colors duration-75"
            style={{ height: `${Math.round(p * 100)}%`, minWidth: 2, background: (i / WAVEFORM_BARS) < ratio ? playedHex : unplayedHex }} />
        ))}
      </div>
      <span className="shrink-0 text-micro tabular-nums" style={{ color: light ? 'rgba(15,17,23,0.5)' : 'rgba(255,255,255,0.45)' }}>
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
    messagesApi.signedUrl(path).then(u => { if (on) setUrl(u); }).catch(logCaught('messages.signedUrl', () => { if (on) setFailed(true); }));
    return () => { on = false; };
  }, [path, url]);
  if (failed) return <div className="mt-1 text-meta text-danger-text/70">Voice note unavailable</div>;
  if (!url) return (
    <div className="mt-1 inline-flex items-center gap-2 px-1 py-1.5 text-meta text-faint">
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
  return <div className={cx('animate-pulse rounded-md bg-fill', className)} />;
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
      <span className="px-2.5 h-6 inline-flex items-center rounded-full text-micro font-medium uppercase tracking-wider backdrop-blur-sm border"
        style={{ background: light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)', color: light ? '#5a5d69' : 'rgba(255,255,255,0.5)', borderColor: light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)' }}>
        {label}
      </span>
    </div>
  );
}

/** The one avatar in the app. Photo if the user has one, else their initials, else a silhouette —
 *  never an empty circle. The deterministic per-user color still tints the fallback, so a person
 *  stays recognisable at a glance whether or not they've uploaded a photo.
 *  Photo -> two-letter initials -> silhouette. THEME-AWARE, and it must stay that way: `soft` is a 14%
 *  tint built for dark surfaces, so `soft` background + `hex` text is unreadable on light. Light mode
 *  therefore swaps to a soft hex tint with near-black text (a solid `hex` fill was tried first and read
 *  as a wall of loud color discs). Doing it here — rather than per call site — is what lets every avatar
 *  in the app be light-safe at once. NB on mechanism: inline styles are unaffected by CSS theming
 *  either way, so theme is read from context. Do NOT repeat the old claim that light CSS "never
 *  reaches portaled modals" — tokens are declared on <html>, so portals inherit them like anything
 *  else. (The per-user `hex`/`soft` pair is a CATEGORICAL identity palette, deliberately outside the
 *  semantic token layer; see ASSIGNEE_PALETTE.) */
function Avatar({ name, userId, photoUrl, size = 28, className }) {
  const { theme } = useApp();
  const { signed, requestSign } = useAvatarSign();
  const light = theme === 'light';
  const c = assigneeColor(userId);
  const initials = initialsFor(name);

  // `photoUrl` is now usually a STORAGE PATH (the avatars bucket is private). Resolve it to a
  // short-lived signed URL through the shared cache; a value that is already a URL (a blob: preview,
  // a data: URI, or a legacy https URL) is used verbatim. A path with no signed URL yet resolves to
  // null → the fallback (initials/silhouette) shows until the sign lands, then it swaps in.
  const isPath = !!photoUrl && !/^(https?:|blob:|data:)/.test(photoUrl);
  useEffect(() => { if (isPath) requestSign(photoUrl); }, [isPath, photoUrl, requestSign]);
  const src = isPath ? (signed[photoUrl]?.url || null) : (photoUrl || null);

  // FINDING 3 — the single most important client fix. Previously `broken` was a bare boolean set by
  // onError and NEVER reset, so ONE expired signed URL degraded a face to initials permanently, until
  // the component remounted. Instead we remember WHICH src failed. showPhoto is false only while the
  // current src is the one that errored — so when the refresh interval (or an onError-triggered
  // re-sign) mints a fresh URL, `src` changes, no longer equals `brokenSrc`, and the <img> retries.
  // Keyed off src rather than reset in an effect, which also keeps this off the setState-in-effect path.
  const [brokenSrc, setBrokenSrc] = useState(null);
  const showPhoto = !!src && brokenSrc !== src;
  // Cap onError-driven re-signs to ONE per successful-load cycle for a given path. Without this, a
  // signable-but-undecodable object (a corrupt upload that still signs) would loop: onError → force
  // re-sign → fresh token → new src → retry → fail → … (the review's Finding 2). A genuinely expired
  // URL still recovers, because the proactive refresh interval is the primary re-sign path and a
  // successful load clears this guard so the next expiry may force again.
  const erroredForRef = useRef(null);

  return (
    <span className={cx('rounded-full flex items-center justify-center font-semibold shrink-0 select-none overflow-hidden', className)}
      style={{
        width: size, height: size,
        // Light fallback: a SOFT tint + near-black text, not the former full-saturation disc — a board
        // of solid color circles read louder than any content. Border keeps the identity hue at 35%.
        background: showPhoto ? 'transparent' : (light ? c.hex + '26' : c.soft),
        color: light ? '#0b0b12' : c.hex,
        border: `1px solid ${light ? c.hex + '59' : c.hex + '33'}`,
        fontSize: Math.round(size * 0.36),
      }}>
      {showPhoto ? (
        // Fixed box + lazy/async decode: an avatar renders in every roster row and chat line, so it
        // must never drive layout off an image whose real dimensions we don't control.
        // FILL THE CONTENT BOX — do NOT restate `size` here. The wrapper is border-box with a 1px
        // border, so its content box is (size-2) square. An img authored at `size` gets its WIDTH
        // clamped to size-2 by preflight's `img { max-width: 100% }` while the inline HEIGHT stays
        // `size`, yielding a portrait box: `cover` then over-crops horizontally and overflow-hidden
        // shaves a row of pixels off the top and bottom. The error is a fixed 2px, so it is worst on
        // the small avatars (17% at size 12, 7% at 28). 100%/100% keeps it exactly square at every
        // size; flexShrink guards the same width against the wrapper's flex context.
        <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async"
          onLoad={() => { erroredForRef.current = null; }}
          // On error, fall back to initials AND force a fresh sign ONCE per load-cycle: an expired
          // signed URL is the expected cause, and re-minting it changes `src`, which `showPhoto` uses
          // to retry with the new URL. The once-per-path guard stops a corrupt-but-signable object
          // from looping; a genuinely-missing object just settles on initials.
          onError={() => {
            setBrokenSrc(src);
            if (isPath && erroredForRef.current !== photoUrl) { erroredForRef.current = photoUrl; requestSign(photoUrl, true); }
          }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', display: 'block', flexShrink: 0 }} />
      ) : initials ? (
        // aria-hidden for the same reason the other two branches already are (`alt=""` on the photo,
        // aria-hidden on the silhouette): an avatar is decoration, and every call site pairs it with
        // a real name — in a PersonButton title, a sibling label, or an sr-only summary. Without
        // this, a screen reader reads bare initials ("A M") as if they were content.
        <span aria-hidden="true">{initials}</span>
      ) : (
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
// Broadcast when any message menu opens, carrying its menu id; every OTHER open menu closes on hearing
// it. See the "ONLY ONE MENU OPEN AT A TIME" effect in MsgBubble for why this is an event and not state.
const MSG_MENU_OPEN_EVENT = 'cc:msg-menu-open';

/** "Dense" = a bubble whose box has no text half-leading to soften the gap to its neighbour: a voice
 *  note (fixed-height control row) or a tombstone. Drives the message-row spacing in MessageList. */
const isDenseMsg = (m) => !!m && (!!m.deletedAt || !!m.audioPath || !!m.localUrl);

/** One message bubble: tombstone / body (+ "(edited)") / voice note, an inline editor, and a
 *  hover-and-touch "…" actions menu. Shared by team chat + DMs.
 *
 *  TWO-TIER DELETE. `onDelete` is "delete for everyone" — a soft-delete that tombstones the row for
 *  both sides, capped at MSG_EDIT_WINDOW_MS by the DB trigger. `onHide` is "delete for me" — a row
 *  in dm_message_hides that removes the message from MY view only, with NO time limit, and which
 *  therefore also works on someone ELSE's message and on an existing tombstone. BOTH surfaces now
 *  pass `onHide` — DMs via dm_message_hides (20260716000040) and team chat via message_hides
 *  (20260719134752) — so the two menus are identical, which is the whole point. */
function MsgBubble({ m, mine, onDelete, onEdit, onHide }) {
  const [menu, setMenu] = useState(false);
  const [pos, setPos] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [actable, setActable] = useState(false);   // within the 10-min window — evaluated on menu open
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const deleted = !!m.deletedAt;
  const edited = !!m.editedAt;
  const hasBody = !!m.body;
  const canCopy = hasBody && !deleted;
  // Trigger visibility (pure): the precise 10-min window is computed in openMenu, not at render
  // (Date.now() is impure for render), and gates Edit/Delete inside the menu via `actable`.
  // A pending bubble has no server row yet, so there is nothing to edit, copy or delete on it.
  // "Delete for me" has no time limit and no sender restriction, so it is available on ANY settled
  // message — including a tombstone — on both surfaces.
  const canHide = !!onHide && !m.pending;
  const menuBtn = !m.pending && (canCopy || canHide || (mine && !deleted));
  // Keep in sync with the menu's `w-44` below — this is the width used to clamp it on-screen.
  const MENU_W = 176;
  const MENU_ROW_H = 34;    // one item: px-3 py-2 (16) + a 12px/1.5 line box (18), no wrap
  const MENU_PAD_Y = 10;    // the menu's own py-1 (8) + its 1px top and bottom border
  const MENU_HINT_H = 48;   // the expiry hint wraps to two lines at this width
  // Anchor the menu to the trigger's viewport rect, then render it via a PORTAL to document.body so
  // it escapes the scroll/overflow clipping of the message list (the old absolute menu was clipped
  // and spilled off the edge). Clamp horizontally so it never runs off-screen on mobile.
  const openMenu = () => {
    // Always open. This used to bail when nothing was actionable, which made the visible trigger a
    // SILENT NO-OP on an own voice note past the window — indistinguishable from a broken button.
    // The menu now explains itself instead (see the expiry hint).
    const within = Date.now() - new Date(m.createdAt).getTime() < MSG_EDIT_WINDOW_MS;
    setActable(within);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      let left = mine ? r.right - MENU_W : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - MENU_W - 8));
      // The vertical reserve must track the ITEM COUNT. A fixed one was sized for a 3-item menu, and
      // the DM case now renders FOUR (Edit · Copy · Delete for me · Delete for everyone) — on the
      // newest message the clamp pushed the last row below the fold, and the menu is `fixed` with no
      // overflow, so "Delete for everyone" became unreachable. Prefer below the trigger, flip above
      // when it would overflow, and only clamp if it fits neither way.
      const rows = (mine && hasBody && within && !deleted ? 1 : 0)
                 + (canCopy ? 1 : 0)
                 + (canHide ? 1 : 0)
                 + (mine && within && !deleted ? 1 : 0);
      const h = MENU_PAD_Y + rows * MENU_ROW_H + (mine && !deleted && !within ? MENU_HINT_H : 0);
      const below = r.bottom + 6;
      const top = below + h <= window.innerHeight - 8
        ? below
        : Math.max(8, Math.min(r.top - 6 - h, window.innerHeight - h - 8));
      setPos({ top, left });
    }
    // Tell every other open menu to close (see the single-open effect). Dispatched BEFORE setMenu so
    // this bubble's own listener is not yet attached and cannot close the menu we are opening.
    window.dispatchEvent(new CustomEvent(MSG_MENU_OPEN_EVENT, { detail: menuId }));
    setMenu(true);
  };

  // Escape closes the menu and returns focus to the trigger. Without this the menu was mouse-only:
  // it is portaled to document.body, so it lands at the END of the tab order rather than after the
  // trigger, and there was no way to dismiss it from the keyboard at all.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // No stopPropagation: this listener is on `window`, the last node in the bubble path, so there
      // is nothing left to stop — and AppProvider's own window-level Escape handler is registered at
      // mount, so it runs first regardless. Harmless here (its targets are all inert in a chat view),
      // but don't add a guard that reads as if it prevents that; it wouldn't.
      setMenu(false);
      btnRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // ONLY ONE MENU OPEN AT A TIME. `menu` is per-bubble local state, so before this every bubble could
  // have its own menu open simultaneously — Escape then closed only the one whose effect happened to
  // be mounted, and a stray portal could sit over the thread indefinitely.
  // A window event rather than lifted state: these bubbles are siblings scattered through a list with
  // no common owner, and MsgBubble is shared by ChatView and DmThread — lifting `menu` would mean
  // threading an open-id through MessageList and both callers for no behavioural gain.
  useEffect(() => {
    if (!menu) return;
    const onOtherOpened = (e) => { if (e.detail !== menuId) setMenu(false); };
    window.addEventListener(MSG_MENU_OPEN_EVENT, onOtherOpened);
    return () => window.removeEventListener(MSG_MENU_OPEN_EVENT, onOtherOpened);
  }, [menu, menuId]);

  // MOVE FOCUS INTO THE MENU on open. This is the fix for the real defect: the trigger was
  // keyboard-reachable (focus-visible) but the ITEMS never were. The menu is portaled to the END of
  // document.body, so Tab from the trigger went to the NEXT bubble's trigger — reaching "Delete for
  // me" meant tabbing through the rest of the application. Focus is restored to the trigger on
  // Escape (above) and on close via the item handlers.
  // Depends on `pos` too: the portal does not render until pos is set, so focusing on `menu` alone
  // would run before the items exist.
  useEffect(() => {
    if (!menu || !pos) return;
    const first = menuRef.current?.querySelector('[data-menuitem]');
    first?.focus();
  }, [menu, pos]);

  // Roving focus within the menu. Items are real buttons, so Enter/Space already activate them and
  // Tab still works; this adds the arrow/Home/End conventions a menu is expected to honour.
  const onMenuKeyDown = (e) => {
    const items = Array.from(menuRef.current?.querySelectorAll('[data-menuitem]') || []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };

  // Close when focus leaves the menu entirely (Tab off the last item, or a click elsewhere).
  // relatedTarget is null for a click on non-focusable chrome, which is also a leave.
  const onMenuBlur = (e) => {
    if (!menuRef.current?.contains(e.relatedTarget)) setMenu(false);
  };
  const copy = () => { try { navigator.clipboard?.writeText(m.body || ''); } catch { /* ignore */ } setMenu(false); };
  const startEdit = () => { setDraft(m.body || ''); setEditing(true); setMenu(false); };
  const saveEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== (m.body || '')) onEdit?.(m, next);   // no-op if unchanged/empty
  };

  // The "…" trigger + its portaled menu. Rendered by BOTH the tombstone branch and the normal
  // bubble, because "delete for me" stays available after a message is deleted for everyone.
  const showEdit = mine && hasBody && actable && !deleted;
  const showDeleteAll = mine && actable && !deleted;
  const actions = menuBtn && (
    <>
      <button ref={btnRef} onClick={() => (menu ? setMenu(false) : openMenu())} aria-label="Message actions"
        aria-haspopup="true" aria-expanded={menu}
        className={cx('absolute -top-2 w-6 h-6 rounded-full bg-surface-raised border border-line flex items-center justify-center text-muted hover:text-secondary transition-opacity',
          // Always visible on touch (no hover there); hover-revealed on desktop. focus-visible keeps
          // it keyboard-reachable — without it the only delete path was mouse-only. The UA focus ring
          // is deliberately NOT suppressed: it is the only focus affordance here, and it stays
          // visible in both themes without needing a light-sheet rule.
          'opacity-100 sm:opacity-0 sm:group-hover/bubble:opacity-100 focus-visible:opacity-100',
          mine ? '-left-2' : '-right-2')}>
        <MoreHorizontal className="w-3 h-3" />
      </button>
      {menu && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setMenu(false)} />
          {/* maxHeight + scroll so an extreme viewport degrades gracefully: a `fixed` box with no
              overflow would put the last row off-screen with no way to reach it. */}
          <div ref={menuRef} role="menu" aria-label="Message actions"
            onKeyDown={onMenuKeyDown} onBlur={onMenuBlur}
            className="fixed z-[71] w-44 rounded-xl border border-line bg-surface-raised shadow-2xl py-1 overflow-y-auto"
            style={{ top: pos.top, left: pos.left, maxHeight: 'calc(100vh - 16px)', animation: 'slideUp .12s ease' }}>
            {showEdit && (
              <button onClick={startEdit} data-menuitem role="menuitem" className="w-full flex items-center gap-2 px-3 py-2 text-note text-secondary hover:bg-fill whitespace-nowrap">
                <Edit3 className="w-3.5 h-3.5" />Edit
              </button>
            )}
            {canCopy && (
              <button onClick={copy} data-menuitem role="menuitem" className="w-full flex items-center gap-2 px-3 py-2 text-note text-secondary hover:bg-fill whitespace-nowrap">
                <Copy className="w-3.5 h-3.5" />Copy
              </button>
            )}
            {canHide && (
              <button onClick={() => { setMenu(false); btnRef.current?.focus(); onHide?.(m); }} data-menuitem role="menuitem" className="w-full flex items-center gap-2 px-3 py-2 text-note text-secondary hover:bg-fill whitespace-nowrap">
                <EyeOff className="w-3.5 h-3.5" />Delete for me
              </button>
            )}
            {showDeleteAll && (
              <button onClick={() => { setMenu(false); btnRef.current?.focus(); onDelete?.(m); }} data-menuitem role="menuitem" className="w-full flex items-center gap-2 px-3 py-2 text-note text-danger-text hover:bg-danger/10 whitespace-nowrap">
                <Trash2 className="w-3.5 h-3.5" />Delete for everyone
              </button>
            )}
            {/* Say WHY the destructive options are gone rather than leaving the user to guess —
                "I can't find delete" was the reported symptom, and an expired window looks identical
                to a missing feature. Shown whenever YOUR OWN live message is past the window, so it
                also covers the DM case where only "Delete for me" survives, not just the team-chat
                case where the menu would otherwise be empty. (It is never empty: menuBtn requires
                one of canCopy/canHide/(mine && !deleted), and the last of those implies this hint.) */}
            {mine && !deleted && !actable && (
              <div className="px-3 py-2 text-meta text-faint leading-snug">
                Edit and delete-for-everyone expire 10 minutes after sending.
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </>
  );

  // Tombstone — content was stripped server-side; render a muted placeholder in place. It still
  // carries the actions menu so it can be cleared from your own view ("delete for me", DMs).
  if (deleted) {
    return (
      <div className={cx('group/bubble relative max-w-full rounded-2xl px-3 py-2 border text-compact italic text-faint bg-fill-subtle border-line',
        mine ? 'rounded-tr-sm' : 'rounded-tl-sm')}>
        This message was deleted
        {actions}
      </div>
    );
  }

  // Inline editor for an own text message within the window.
  if (editing) {
    return (
      <div className={cx('max-w-full rounded-2xl px-3 py-2 border',
        mine ? 'bg-brand/20 border-brand/25 rounded-tr-sm' : 'bg-fill border-line rounded-tl-sm')}>
        <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          rows={Math.min(6, Math.max(1, (draft.match(/\n/g)?.length || 0) + 1))}
          className="w-full bg-transparent text-sm text-primary leading-relaxed outline-none resize-none" />
        <div className="mt-1 flex items-center justify-end gap-3 text-meta">
          <button onClick={() => setEditing(false)} className="text-faint hover:text-secondary">Cancel</button>
          <button onClick={saveEdit} className="font-medium text-brand-text hover:text-brand-text-hover">Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className={cx('group/bubble relative max-w-full rounded-2xl px-3 py-2 border',
      mine ? 'bg-brand/20 border-brand/25 rounded-tr-sm' : 'bg-fill border-line rounded-tl-sm')}>
      {m.body && (
        <div className="text-sm text-primary leading-relaxed whitespace-pre-wrap break-words" title={absoluteTime(m.createdAt)}>
          <MentionText text={m.body} mentions={m.mentions} />
          {edited && <span className="ml-1.5 text-micro text-faint not-italic">(edited)</span>}
        </div>
      )}
      {(m.audioPath || m.localUrl) && (
        <VoiceNote path={m.audioPath} localUrl={m.localUrl} duration={m.audioDuration} pending={m.pending} />
      )}
      {actions}
    </div>
  );
}

/** The scrollable message timeline — sticky day dividers, sender grouping, avatars (both
 *  surfaces), per-message receipts (DM), skeleton loading, empty state, sticky-bottom
 *  autoscroll, and a jump-to-latest button. Shared by the team channel and DM threads. */
/** Shared by team chat AND DMs — any change here lands in both. `avatarFor(senderId) -> photoUrl` is
 *  optional so a caller that has no roster handy still renders correct initials. */
function MessageList({ items, userId, nameOf, avatarFor, loading, empty, onDelete, onEdit, onHide, receiptFor, hasMore, onLoadOlder, loadingOlder }) {
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
      // A text bubble's `leading-relaxed` line box carries ~3px of half-leading top and bottom, which
      // visually pads the 2px grouped gap into something acceptable. A voice note (a fixed 32px
      // control row) and a tombstone (13px/1.5) have no such half-leading, so the same 2px reads as
      // FLUSH against the next bubble. Give any row that touches a dense box real extrinsic spacing.
      const roomy = isDenseMsg(m) || isDenseMsg(prev);
      if (newDay) groups.push({ key: m.id, label: dayLabel(m.createdAt), rows: [] });
      groups[groups.length - 1].rows.push({ m, firstOfGroup, roomy });
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
              className="text-meta px-3 h-7 rounded-full bg-fill border border-line hover:bg-fill-strong text-muted disabled:opacity-50 transition-colors">
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {days.map(day => (
          <section key={day.key}>
            <DayDivider label={day.label} />
            {day.rows.map(({ m, firstOfGroup, roomy }) => {
              const mine = m.senderId === userId;
              return (
                <div key={m.id} className={cx('flex gap-2.5', mine && 'flex-row-reverse', firstOfGroup ? 'mt-3' : roomy ? 'mt-2' : 'mt-1')}>
                  {!mine && (firstOfGroup
                    ? <PersonButton personId={m.senderId} className="shrink-0 self-start" title={`View ${nameOf(m.senderId)}'s profile`}>
                        <MsgAvatar name={nameOf(m.senderId)} userId={m.senderId} photoUrl={avatarFor?.(m.senderId)} />
                      </PersonButton>
                    : <span className="w-7 shrink-0" aria-hidden="true" />)}
                  <div className={cx('flex flex-col min-w-0 max-w-[78%]', mine ? 'items-end' : 'items-start')}>
                    {firstOfGroup && (
                      <div className={cx('flex items-baseline gap-2 mb-1 px-0.5', mine && 'flex-row-reverse')}>
                        {!mine && (
                          <PersonButton personId={m.senderId} className="text-note font-semibold text-secondary hover:text-primary">
                            {nameOf(m.senderId)}
                          </PersonButton>
                        )}
                        <span className="text-micro text-faint tabular-nums">{clockTime(m.createdAt)}</span>
                      </div>
                    )}
                    <MsgBubble m={m} mine={mine} onDelete={onDelete} onEdit={onEdit} onHide={onHide} />
                    {/* NOT gated on `mine`. DMs put a receipt under MY last message only ("Seen" by
                        the one peer); team chat puts each member's face under whichever message THEY
                        last read, which is usually someone else's. Dropping the gate is safe for the
                        DM caller because its receiptFor already returns null unless m.id is the last
                        OWN message id — a condition that implies `mine` — so this is behaviour-
                        preserving there and merely permissive here. */}
                    {receiptFor && receiptFor(m)}
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
          className="absolute bottom-3 right-3 z-10 w-9 h-9 rounded-full bg-surface-raised border border-line shadow-xl flex items-center justify-center text-secondary hover:text-primary hover:border-line-strong">
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
    <div className="px-4 py-1.5 text-meta text-faint border-t border-line-subtle shrink-0 flex items-center gap-1.5">
      <span className="flex gap-0.5">
        <span className="w-1 h-1 rounded-full bg-brand-hover/70 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1 h-1 rounded-full bg-brand-hover/70 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1 h-1 rounded-full bg-brand-hover/70 animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      {label}
    </div>
  );
}

/** Shared composer: autosizing textarea (1 → ~6 rows), voice button, primary Send, a
 *  recording bar, and a visible send-failure + Retry affordance. Presentational — the view
 *  owns recording + send state and passes handlers down. */
function Composer({ onSubmitText, onTyping, onStopTyping, recording, seconds, onStartRecording, onStopRecording, micError, canVoice, onUpgradeVoice, placeholder, mentionMembers, meId }) {
  // personOf (not resolveAssignee) — the latter labels yourself 'Me', which would render every
  // photo-less self-avatar as "M". The composer face should carry your real initials.
  const { personOf } = useApp();
  const me = personOf(meId);
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
    catch (e) { reportError(e, 'messages.send'); setFailedBody(body); setFailedMentions(mns || []); }
    finally { setSending(false); }
  };
  const submit = () => { const body = text.trim(); if (!body) return; const mns = mentions; setText(''); setMentions([]); onStopTyping?.(); doSend(body, mns); };
  const retry = () => { const body = failedBody, mns = failedMentions; setFailedBody(''); setFailedMentions([]); doSend(body, mns); };

  return (
    <div className="border-t border-line shrink-0">
      {failedBody && (
        <div className="px-4 py-1.5 flex items-center gap-2 text-meta text-danger-text/90 border-b border-line-subtle">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 truncate">Couldn’t send “{failedBody}”.</span>
          <button onClick={retry} className="font-semibold underline underline-offset-2 hover:text-danger-text">Retry</button>
          <button onClick={() => setFailedBody('')} aria-label="Dismiss" className="text-faint hover:text-secondary"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      <div className="p-3">
        {recording ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs text-danger-text">
              <span className="w-2 h-2 rounded-full bg-danger animate-pulse" /> Recording {fmtDur(seconds)}
            </span>
            <span className="flex items-end gap-0.5 h-4" aria-hidden="true">
              {[0, 1, 2, 3, 4].map(i => <span key={i} className="w-0.5 rounded-full bg-danger-hover/70 animate-pulse" style={{ height: `${6 + ((i * 7 + seconds * 5) % 10)}px`, animationDelay: `${i * 120}ms` }} />)}
            </span>
            <div className="flex-1" />
            <button onClick={() => onStopRecording(true)} className="text-xs text-muted hover:text-secondary">Cancel</button>
            <button onClick={() => onStopRecording(false)} className="inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-xs font-semibold bg-inverse text-inverse-fg hover:bg-inverse/90">
              <Square className="w-3 h-3" />Stop &amp; send
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            {/* Your own face, so the composer reads as "you, about to speak" and matches the bubbles above.
                Hidden on narrow screens — the textarea needs the width more than the affordance. */}
            {me && <Avatar name={me.name} userId={meId} photoUrl={me.avatarUrl} size={28} className="hidden sm:flex mb-1 shrink-0" />}
            <MentionTextarea textareaRef={taRef} value={text} onChange={setText} onMentionsChange={setMentions}
              members={mentionMembers} meId={meId} onEnter={submit} onTyping={onTyping} onBlur={() => onStopTyping?.()} rows={1}
              placeholder={placeholder}
              className="max-h-[140px] bg-fill border border-line rounded-xl px-3 py-2 text-sm text-primary placeholder-faint outline-none focus:border-brand-hover/50 resize-none overflow-y-hidden leading-relaxed" />
            {/* focus-visible RING, not just the border tint. `focus:outline-none` suppressed the UA
                ring and the only replacement was a 1px border going white/10 -> violet-400/50: a
                1.92:1 state change in dark and 2.23:1 in light — effectively invisible, and well under
                the WCAG 1.4.11 3:1 minimum for a non-text indicator. This was the ONLY
                `focus:outline-none` in the file with no ring beside it; the other three already pair one. */}
            <button onClick={() => canVoice ? onStartRecording() : onUpgradeVoice?.()} disabled={sending}
              aria-label={canVoice ? 'Record a voice note' : 'Upgrade to unlock voice notes'}
              title={canVoice ? 'Record a voice note' : 'Upgrade to unlock voice notes'}
              className="inline-flex items-center justify-center w-9 h-9 rounded-xl border border-line bg-fill text-secondary hover:bg-fill-strong hover:text-primary hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover/70 focus:border-brand-hover/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 shrink-0">
              {canVoice ? <Mic className="w-4 h-4" /> : <Lock className="w-3.5 h-3.5" />}
            </button>
            <button onClick={submit} disabled={!text.trim() || sending}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 h-9 text-xs font-semibold bg-inverse text-inverse-fg hover:bg-inverse/90 disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
              <Send className="w-3.5 h-3.5" />Send
            </button>
          </div>
        )}
        {micError && <div className="mt-1.5 text-meta text-danger-text/80">{micError}</div>}
      </div>
    </div>
  );
}

function ChatView() {
  const { session, markChatRead, showToast, currentMember, currentWorkspaceId, requestUpgrade, members, meId } = useApp();
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
    membersApi.list().then(list => { if (on) setPeople(Object.fromEntries((list || []).map(m => [m.id, m]))); }).catch(logCaught('members.list for chat'));
    return () => { on = false; };
  }, []);

  // Load + subscribe; mark read while open. Scoped to the current workspace (re-runs on switch).
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let on = true;
    // Mark read from INSIDE the .then, with the newest loaded message's SERVER timestamp as the
    // cover time. Two reasons this moved: (a) the cursor is now peer-visible, so it must not claim
    // to have read messages we never actually loaded — a failed load now correctly leaves the badge
    // standing; (b) anchoring to the server stamp rather than the client's now() keeps the cursor
    // from landing just before a message the server stamped at ~the same instant.
    messagesApi.list(200, currentWorkspaceId).then(list => {
      if (!on) return;
      setItems(list);
      setHasMore(list.length >= 200);
      markChatRead(list.length ? list[list.length - 1].createdAt : undefined);
    }).catch(e => reportError(e, 'messages.list')).finally(() => { if (on) setLoading(false); });
    const unsub = messagesApi.subscribe(({ type, message }) => {
      if (!message || !on) return;
      setItems(prev => {
        if (type === 'DELETE') return prev.filter(m => m.id !== message.id);
        if (type === 'UPDATE') return prev.map(m => m.id === message.id ? message : m);
        return prev.some(m => m.id === message.id) ? prev : [...prev, message];
      });
      // Clear the typing indicator immediately on someone else's message (don't wait for "stopped typing").
      if (type === 'INSERT' && message.senderId !== userId) setShownTyping('');
      markChatRead(message.createdAt);
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
    } catch (e) { reportError(e, 'messages.loadOlder'); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [items, currentWorkspaceId]);

  // Stop any in-flight recording on unmount.
  useEffect(() => () => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  // useCallback'd because receiptFor depends on it: an inline definition would change identity every
  // render and re-create that callback (and so re-render every message row) on each poll tick.
  const nameOf = useCallback((id) => (id === userId ? 'You' : (people[id]?.display_name || people[id]?.email || 'Someone')), [people, userId]);

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
          reportError(e, 'messages.voiceSend');
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
      reportError(e, 'voice.mic');
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
    catch (e) { reportError(e, 'messages.delete'); messagesApi.list(200, currentWorkspaceId).then(setItems).catch(logCaught('messages.reconcile')); }
  };

  // Edit own text in place; the DB trigger enforces the 10-minute window + stamps edited_at.
  const edit = async (m, body) => {
    setItems(prev => prev.map(x => x.id === m.id ? { ...x, body, editedAt: nowISO() } : x));
    try { await messagesApi.update(m.id, body); }
    catch (e) { reportError(e, 'messages.edit'); messagesApi.list(200, currentWorkspaceId).then(setItems).catch(logCaught('messages.reconcile')); }
  };

  // "Delete for me" — drop the message from MY view only; everyone else still sees it. No time limit
  // and no sender restriction (it also clears a tombstone), because this writes `message_hides`
  // rather than touching `messages`. The exact twin of DmThread.hideForMe.
  const hideForMe = async (m) => {
    setItems(prev => prev.filter(x => x.id !== m.id));
    try {
      await messagesApi.hide(m.id);
      setHiddenCount(n => n + 1);
      // UNDO, offered at the only moment the user is still thinking about it. The DB has supported
      // this since the migration shipped (message_hides carries a DELETE policy AND a grant), but the
      // UI never offered it — so "Delete for me" was irreversible in-product. That is the same
      // "built but not wired" shape the hide feature itself sat in for three days.
      showToast('Message hidden for you.', 'info', { label: 'Undo', onClick: () => restoreOne(m.id) });
      // NB no badge refresh here, and that is deliberate — it is where team chat legitimately
      // DIVERGES from DmThread.hideForMe, which does call refreshDms. A hide fires no realtime event
      // (message_hides is unpublished), so nothing self-heals; the question is whether anything
      // needs to. In DMs it does: refreshDms also rebuilds every conversation's PREVIEW and the
      // other threads' unread counts. Team chat has one channel and no list, and a hide is only
      // reachable from inside ChatView — where markChatRead has already pinned the badge to 0 and
      // AppProvider's realtime handler declines to increment it. Recomputing from the server here
      // would do nothing at best, and at worst re-inflate the badge from a cursor whose upsert has
      // not landed yet. So: nothing to do.
    } catch (e) {
      // Reconcile from the server rather than restoring a pre-await snapshot of `items`: that array
      // is stale by the time we'd use it, so it would clobber a message that arrived mid-flight and
      // resurrect a concurrent hide. Same reconcile the sibling remove/edit handlers use.
      // Toast because this failure is otherwise INVISIBLE: remove/edit leave a tombstone or an edit
      // state to look at, but a failed hide just flickers the message out and back.
      reportError(e, 'messages.hide');
      showToast("Couldn't hide that message — it's back in the channel.");
      messagesApi.list(200, currentWorkspaceId).then(setItems).catch(logCaught('messages.reconcile'));
    }
  };

  // ---- Restoring hidden messages -------------------------------------------------------------
  // `hiddenCount` drives the "N hidden" affordance in the header, so a hide is discoverable and
  // reversible LATER too — the undo toast only covers the next few seconds.
  const [hiddenCount, setHiddenCount] = useState(0);
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let on = true;
    messagesApi.hiddenCount(currentWorkspaceId)
      .then(n => { if (on) setHiddenCount(n); })
      .catch(logCaught('messages.hiddenCount'));
    return () => { on = false; };
  }, [currentWorkspaceId]);

  // Undo ONE hide (the toast action). Re-reads the thread rather than splicing the message back at a
  // remembered index: `items` has moved on, and the RPC returns it in the right place by created_at.
  const restoreOne = async (id) => {
    try {
      await messagesApi.unhide(id);
      setHiddenCount(n => Math.max(0, n - 1));
      setItems(await messagesApi.list(200, currentWorkspaceId));
    } catch (e) { reportError(e, 'messages.unhide'); showToast("Couldn't restore that message."); }
  };

  const restoreAllHidden = async () => {
    try {
      await messagesApi.unhideAll(currentWorkspaceId);
      setHiddenCount(0);
      setItems(await messagesApi.list(200, currentWorkspaceId));
    } catch (e) { reportError(e, 'messages.unhideAll'); showToast("Couldn't restore your hidden messages."); }
  };

  // ---- Read receipts: each member's avatar sits under the last message they have read ----------
  // chat_reads is NOT in the realtime publication (nor is dm_reads), so this POLLS — the same 4s +
  // focus + visibilitychange cadence DmThread already proves out.
  // `reads` is TAGGED with the workspace it came from rather than applied blind. ChatView is
  // route-mounted with no workspace key, so a switch need not remount it, and an in-flight SELECT for
  // the OLD workspace could otherwise resolve afterwards and paint the old workspace's members onto
  // the new channel — receiptsByMessage matches cursors to messages on TIMESTAMP alone and has no
  // notion of a workspace, and `people` is not workspace-scoped either, so those strangers would
  // render with real names and faces. Tagging also makes the stale window show NOTHING rather than
  // something wrong, without needing a setState inside an effect to clear it.
  const [reads, setReads] = useState({ ws: null, rows: [] });
  const refreshReads = useCallback(() => {
    if (!currentWorkspaceId) return;
    const ws = currentWorkspaceId;
    chatReadsApi.reads(ws).then(rows => setReads({ ws, rows })).catch(logCaught('chat.reads'));
  }, [currentWorkspaceId]);
  useEffect(() => {
    if (!currentWorkspaceId) return undefined;
    refreshReads();
    const id = setInterval(refreshReads, 4000);
    const onFocus = () => refreshReads();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [currentWorkspaceId, refreshReads]);

  // messageId -> [userId] : for each OTHER member, the newest loaded message at or before their
  // cursor. That is what makes a face "move down" as they read further.
  // Guests never appear here and it costs no client-side check: the chat_reads SELECT policy
  // evaluates the ROW OWNER's team-chat visibility, so a guest — or a member since DEMOTED to
  // guest — is filtered out server-side before these rows are ever returned.
  const receiptsByMessage = useMemo(() => {
    const map = new Map();
    const rows = reads.ws === currentWorkspaceId ? reads.rows : [];
    if (!items.length || !rows.length) return map;
    const stamps = items.map(m => new Date(m.createdAt).getTime());
    rows.forEach(r => {
      if (!r.userId || r.userId === userId) return;         // never render my own face
      const readMs = new Date(r.lastReadAt).getTime();
      if (!Number.isFinite(readMs)) return;
      // Walk from the newest backwards: a cursor is almost always at or near the bottom, so this
      // exits on the first comparison in the common case.
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) { if (Number.isFinite(stamps[i]) && stamps[i] <= readMs) { idx = i; break; } }
      if (idx < 0) return;                                   // their cursor predates this whole window
      const id = items[idx].id;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(r.userId);
    });
    return map;
  }, [items, reads, userId, currentWorkspaceId]);

  const receiptFor = useCallback((m) => {
    const readers = receiptsByMessage.get(m.id);
    if (!readers || !readers.length) return null;
    const shown = readers.slice(0, 6);
    return (
      <div className="mt-1 px-0.5 flex items-center gap-0.5 flex-wrap">
        {/* The faces CANNOT carry the identity on their own: at 14px Avatar's initials fallback
            renders at ~5px, and a title tooltip is mouse-only — so on touch, and for a screen
            reader, "who read this" would be unobtainable. Two affordances instead: an sr-only
            summary naming everyone (including the ones behind the +N), and each face as a real
            PersonButton — focusable, per-person title, opens that profile — which is exactly what
            the header facepile above already does. */}
        <span className="sr-only">{`Read by ${readers.map(nameOf).join(', ')}`}</span>
        {shown.map(rid => (
          <PersonButton key={rid} personId={rid} title={`Read by ${nameOf(rid)}`} className="shrink-0">
            <Avatar name={nameOf(rid)} userId={rid} photoUrl={people[rid]?.avatar_url} size={14} />
          </PersonButton>
        ))}
        {/* aria-hidden: the sr-only summary above already names these people in full. */}
        {readers.length > shown.length && (
          <span aria-hidden="true" className="text-micro text-faint tabular-nums pl-0.5">+{readers.length - shown.length}</span>
        )}
      </div>
    );
  }, [receiptsByMessage, nameOf, people]);

  return (
    <div className="cc-chat flex flex-col h-[calc(100dvh-9rem)] rounded-2xl border border-line bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-line-subtle flex items-center gap-2.5 shrink-0">
        <span className="w-7 h-7 rounded-lg bg-brand/15 border border-brand/25 flex items-center justify-center text-brand-text text-sm font-semibold shrink-0">#</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-primary leading-tight">Team chat</div>
          <div className="text-micro text-faint leading-tight">Everyone in this workspace</div>
        </div>
        {/* Hidden-message escape hatch. Without this, "Delete for me" is a one-way door the moment the
            undo toast expires: the message is gone from every read path (thread, search, unread), so
            there is no way to even discover it still exists. Only rendered when there is something to
            restore, so it costs nothing in the common case. */}
        {hiddenCount > 0 && (
          <button onClick={restoreAllHidden} type="button"
            title={`You have hidden ${hiddenCount} message${hiddenCount === 1 ? '' : 's'} in this channel. Restore them?`}
            className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line bg-fill text-meta text-muted hover:text-primary hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover/70 transition-colors">
            <EyeOff className="w-3 h-3" />
            {hiddenCount} hidden — restore
          </button>
        )}
        {/* Facepile: shows WHO "everyone" actually is. Overlapped and capped at 4 + a "+N"; each face opens
            that person's profile. No ring separator — Avatar's own border does it and stays theme-safe. */}
        {members.length > 0 && (
          <div className="hidden sm:flex items-center shrink-0 pl-2">
            {members.slice(0, 4).map((m, i) => (
              <PersonButton key={m.userId} personId={m.userId} className={cx('rounded-full', i > 0 && '-ml-2')}
                title={`View ${m.displayName || m.email}'s profile`}>
                <Avatar name={m.displayName || m.email} userId={m.userId} photoUrl={m.avatarUrl} size={24} />
              </PersonButton>
            ))}
            {members.length > 4 && (
              <span className="-ml-2 w-6 h-6 rounded-full bg-fill-strong border border-line text-[9px] font-semibold text-muted flex items-center justify-center">
                +{members.length - 4}
              </span>
            )}
          </div>
        )}
      </div>

      <MessageList
        items={items}
        userId={userId}
        nameOf={nameOf}
        // `people` is members.list() (select('*')), so it already carries avatar_url — no extra fetch.
        avatarFor={(id) => people[id]?.avatar_url}
        loading={loading}
        hasMore={hasMore}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onDelete={remove}
        onEdit={edit}
        onHide={hideForMe}
        receiptFor={receiptFor}
        empty={(
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-10">
            <div className="w-12 h-12 rounded-2xl bg-brand/10 border border-brand/20 flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-brand-text/70" />
            </div>
            <div className="text-sm font-medium text-secondary">No messages yet</div>
            <div className="text-note text-faint">Start the conversation with your team 👋</div>
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
      <div className="px-3 py-3 border-b border-line-subtle flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <MessagesSquare className="w-4 h-4 text-muted" />
          <div className="text-sm font-semibold text-primary">Direct messages</div>
        </div>
        <div className="relative">
          <button onClick={() => setPicking(p => !p)} disabled={peers.length === 0}
            className="inline-flex items-center gap-1 text-meta px-2 h-7 rounded-lg bg-fill border border-line hover:bg-fill-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Plus className="w-3 h-3" />New
          </button>
          {picking && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPicking(false)} />
              <div className="absolute right-0 top-9 z-40 w-56 rounded-xl border border-line bg-surface-raised shadow-2xl py-1.5" style={{ animation: 'slideUp .15s ease' }}>
                <div className="px-3 py-1.5 text-micro font-medium uppercase tracking-widest text-faint">Message someone</div>
                {peers.map(m => {
                  return (
                    <button key={m.userId} onClick={() => onPick(m.userId)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-fill hover:text-primary transition-colors">
                      {/* Deliberately NOT a PersonButton: this row's job is "start a DM" and it is already
                          a <button>. A profile button inside it would be invalid DOM and fight the picker. */}
                      <Avatar name={m.displayName || m.email} userId={m.userId} photoUrl={m.avatarUrl} size={20} />
                      <span className="truncate">
                        {m.statusEmoji && <span className="mr-1">{m.statusEmoji}</span>}
                        {m.displayName || m.email}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
      {startErr && <div className="px-3 py-1.5 text-meta text-danger-text/80 border-b border-line-subtle shrink-0">{startErr}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {dmConversations.length === 0 ? (
          <div className="px-4 py-10 text-center text-note text-faint">
            {peers.length === 0 ? 'No one else is in this workspace yet.' : 'No conversations yet. Start one with “New”.'}
          </div>
        ) : dmConversations.map(c => {
          const a = resolveAssignee(c.peerId);
          const selected = c.id === dmActiveConv;
          return (
            /* Two SIBLING buttons, not nested: the row already means "open this conversation", so the
               avatar's "open profile" must be its own control beside it (a <button> inside a <button> is
               invalid DOM). Same restructure Bundle 2 used for the notification rows. */
            <div key={c.id}
              className={cx('w-full flex items-center gap-2.5 px-3 py-2.5 transition-colors',
                selected ? 'bg-fill' : 'hover:bg-fill-subtle')}>
              <PersonButton personId={c.peerId} className="shrink-0" title={a.label === 'Me' ? 'Your profile' : `View ${a.label}'s profile`}>
                <Avatar name={a.known ? (a.label === 'Me' ? 'You' : a.label) : ''} userId={c.peerId} photoUrl={a.avatarUrl} size={32} />
              </PersonButton>
              <button onClick={() => setDmActiveConv(c.id)} className="flex-1 min-w-0 text-left">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-primary truncate">
                    {a.statusEmoji && <span className="mr-1">{a.statusEmoji}</span>}
                    {a.label === 'Me' ? 'You' : a.label}
                  </span>
                  <span className="text-micro text-faint shrink-0">{c.preview ? timeAgo(c.lastAt) : ''}</span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className={cx('text-note truncate', c.unread > 0 ? 'text-secondary' : 'text-faint')}>{preview(c.preview)}</span>
                  {c.unread > 0 && (
                    <span className="shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-danger text-brand-fg text-[9px] font-bold leading-none flex items-center justify-center">{c.unread > 9 ? '9+' : c.unread}</span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="cc-chat h-[calc(100dvh-9rem)] rounded-2xl border border-line bg-surface overflow-hidden flex">
      {/* List: always shown on lg; on small screens shown only when no thread is open */}
      <aside className={cx('w-full lg:w-80 lg:shrink-0 lg:border-r border-line-subtle h-full', active ? 'hidden lg:flex lg:flex-col' : 'flex flex-col')}>
        {ConversationList}
      </aside>
      <section className={cx('flex-1 min-w-0 h-full', active ? 'flex flex-col' : 'hidden lg:flex lg:flex-col')}>
        {active ? (
          <DmThread key={active.id} conversationId={active.id} peerId={active.peerId} onBack={() => setDmActiveConv(null)} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-6">
            <div className="w-12 h-12 rounded-2xl bg-brand/10 border border-brand/20 flex items-center justify-center">
              <MessagesSquare className="w-5 h-5 text-brand-text/70" />
            </div>
            <div className="text-sm font-medium text-secondary">Your conversations</div>
            <div className="text-note text-faint">Pick a conversation, or start a new one.</div>
          </div>
        )}
      </section>
    </div>
  );
}

/** One open 1:1 thread. Keyed by conversationId so it remounts (fresh state) per conversation. */
function DmThread({ conversationId, peerId, onBack }) {
  const { session, currentMember, resolveAssignee, markDmRead, requestUpgrade, refreshDms, currentWorkspaceId, showToast } = useApp();
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
      .catch(logCaught('dms.reads'));
  }, [conversationId, peerId]);

  // Load + subscribe to this thread. (My read cursor is advanced by the latest-message effect below,
  // which runs on open AND on every new message, incoming or outgoing.) Remounts per conversation.
  useEffect(() => {
    let on = true;
    directMessagesApi.listMessages(conversationId, 200)
      .then(list => { if (on) { setItems(list); setHasMore(list.length >= 200); } })
      .catch(e => reportError(e, 'dms.listMessages'))
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
      <div className="mt-0.5 px-1 flex items-center gap-1 text-micro" title={seen ? 'Seen' : 'Sent'}>
        {/* Seen shows the peer's face (the Messenger convention) — it reads faster than a tick and it's
            unambiguous about WHO saw it. Sent keeps the plain tick: nobody has seen it yet. */}
        {seen
          ? <><Avatar name={peer.known ? peerName : ''} userId={peerId} photoUrl={peer.avatarUrl} size={14} /><span className="text-brand-text/80">Seen</span></>
          : <><Check className="w-3 h-3 text-faint" /><span className="text-faint">Sent</span></>}
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
          reportError(e, 'dms.voiceSend');
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
      reportError(e, 'voice.mic');
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
    catch (e) { reportError(e, 'dms.delete'); directMessagesApi.listMessages(conversationId, 200).then(setItems).catch(logCaught('dms.reconcile')); }
  };

  // "Delete for me" — drop the message from MY view only; the peer still sees it. No time limit and
  // no sender restriction (it also clears a tombstone), because this writes dm_message_hides rather
  // than touching dm_messages.
  const hideForMe = async (m) => {
    setItems(prev => prev.filter(x => x.id !== m.id));
    try {
      await directMessagesApi.hide(m.id);
      setHiddenCount(n => n + 1);
      // Same undo affordance as team chat. dm_message_hides has carried a DELETE policy + grant since
      // 20260716000040 and nothing ever called it, so this half of the feature was dead for three days.
      showToast('Message hidden for you.', 'info', { label: 'Undo', onClick: () => restoreOne(m.id) });
      // dm_message_hides is deliberately OUT of the realtime publication, so nothing tells the
      // conversation list that this thread's preview (and possibly its unread badge) just changed.
      // remove/edit self-heal via the dm_messages UPDATE event; a hide has no such event.
      refreshDms?.(currentWorkspaceId);
    } catch (e) {
      // Reconcile from the server rather than restoring a pre-await snapshot of `items`: that array
      // is stale by the time we'd use it, so it would clobber a message that arrived mid-flight and
      // resurrect a concurrent hide. Same reconcile the sibling remove/edit handlers use.
      // Toast because this failure is otherwise INVISIBLE: remove/edit leave a tombstone or an edit
      // state to look at, but a failed hide just flickers the message out and back.
      reportError(e, 'dms.hide');
      showToast("Couldn't hide that message — it's back in the thread.");
      directMessagesApi.listMessages(conversationId, 200).then(setItems).catch(logCaught('dms.reconcile'));
    }
  };

  // ---- Restoring hidden messages (the twin of ChatView's) -------------------------------------
  const [hiddenCount, setHiddenCount] = useState(0);
  useEffect(() => {
    if (!conversationId) return;
    let on = true;
    directMessagesApi.hiddenCount(conversationId)
      .then(n => { if (on) setHiddenCount(n); })
      .catch(logCaught('dms.hiddenCount'));
    return () => { on = false; };
  }, [conversationId]);

  const restoreOne = async (id) => {
    try {
      await directMessagesApi.unhide(id);
      setHiddenCount(n => Math.max(0, n - 1));
      setItems(await directMessagesApi.listMessages(conversationId, 200));
      refreshDms?.(currentWorkspaceId);   // the preview may change back
    } catch (e) { reportError(e, 'dms.unhide'); showToast("Couldn't restore that message."); }
  };

  const restoreAllHidden = async () => {
    try {
      await directMessagesApi.unhideAll(conversationId);
      setHiddenCount(0);
      setItems(await directMessagesApi.listMessages(conversationId, 200));
      refreshDms?.(currentWorkspaceId);
    } catch (e) { reportError(e, 'dms.unhideAll'); showToast("Couldn't restore your hidden messages."); }
  };

  // Edit own DM text in place; the DB trigger enforces the 10-minute window + stamps edited_at.
  const edit = async (m, body) => {
    setItems(prev => prev.map(x => x.id === m.id ? { ...x, body, editedAt: nowISO() } : x));
    try { await directMessagesApi.update(m.id, body); }
    catch (e) { reportError(e, 'dms.edit'); directMessagesApi.listMessages(conversationId, 200).then(setItems).catch(logCaught('dms.reconcile')); }
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
    } catch (e) { reportError(e, 'dms.loadOlder'); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [items, conversationId]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-line-subtle flex items-center gap-2.5 shrink-0">
        <button onClick={onBack} className="lg:hidden text-muted hover:text-secondary -ml-1"><ChevronRight className="w-4 h-4 rotate-180" /></button>
        <PersonButton personId={peerId} className="gap-2.5 min-w-0 flex-1" title={isSelf ? 'Your profile' : `View ${peerName}'s profile`}>
          <MsgAvatar name={peer.known ? peerName : ''} userId={peerId} photoUrl={peer.avatarUrl} size={32} />
          <div className="min-w-0 text-left">
            <div className="text-sm font-semibold text-primary leading-tight truncate">{isSelf ? 'You' : peerName}</div>
            {/* The subtitle was a static string; the peer's live status is far more useful here. */}
            <div className="text-micro text-faint leading-tight truncate">
              {isSelf ? 'Notes to self'
                : (peer.statusText || peer.statusEmoji)
                  ? <>{peer.statusEmoji && <span className="mr-1">{peer.statusEmoji}</span>}{peer.statusText || 'Direct message'}</>
                  : 'Direct message'}
            </div>
          </div>
        </PersonButton>
        {/* Hidden-message escape hatch — the twin of ChatView's. See that one for why a hide needs a
            way back after the undo toast expires. */}
        {hiddenCount > 0 && (
          <button onClick={restoreAllHidden} type="button"
            title={`You have hidden ${hiddenCount} message${hiddenCount === 1 ? '' : 's'} in this thread. Restore them?`}
            className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line bg-fill text-meta text-muted hover:text-primary hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-hover/70 transition-colors">
            <EyeOff className="w-3 h-3" />
            {hiddenCount} hidden — restore
          </button>
        )}
      </div>

      <MessageList
        items={items}
        userId={userId}
        nameOf={nameOf}
        // A thread has exactly two people, so the roster lookup is a ternary — no extra fetch.
        avatarFor={(id) => (id === userId ? currentMember?.avatar_url : peer.avatarUrl)}
        loading={loading}
        hasMore={hasMore}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onDelete={remove}
        onEdit={edit}
        onHide={hideForMe}
        receiptFor={receiptFor}
        empty={(
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 py-10">
            <MsgAvatar name={peer.known ? peerName : ''} userId={peerId} photoUrl={peer.avatarUrl} size={48} />
            <div className="text-sm font-medium text-secondary">{isSelf ? 'Notes to self' : peerName}</div>
            <div className="text-note text-faint">{isSelf ? 'Jot down anything you want to remember.' : 'Say hello 👋'}</div>
          </div>
        )}
      />

      {!isSelf && <TypingStrip label={shownTyping} />}

      {/* meId: the "you, about to speak" composer avatar — ChatView passed it, DMs didn't (shipped inconsistency). */}
      <Composer
        placeholder={isSelf ? 'Write a note to yourself…' : `Message ${peerName}…  (Enter to send)`}
        meId={userId}
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
  // Deliberately dark-only on AuthShell, like the rest of the pre-app funnel. This used to work by
  // accident (the route renders with no app chrome, so the app's light-mode <style> was unmounted).
  // Tokens are global, so the intent is now DECLARED: AuthShell's root carries data-surface="dark",
  // which re-declares the dark palette for its subtree whatever <html data-theme> says.
  return (
    <AuthShell
      icon={FolderKanban}
      heading="Create your workspace"
      tagline="A workspace is where your team's tasks, projects, and chat live. Name it to get started. You'll be its owner."
      footnote={null}
      beforeCard={pendingInvites.length > 0 ? (
        <div className="rounded-2xl border border-success-hover/20 bg-success/[0.06] p-5 shadow-2xl mb-4">
          <div className="text-meta font-medium uppercase tracking-widest text-success-text/70 mb-2">You've been invited</div>
          <div className="space-y-2">
            {pendingInvites.map(inv => (
              <div key={inv.id} className="flex items-center justify-between gap-2">
                <div className="text-sm text-primary truncate">Join <span className="font-semibold">{inv.workspaceName}</span></div>
                <button onClick={() => acceptInvitation(inv.token).catch(err => reportError(err, 'invitations.accept'))}
                  className="shrink-0 h-8 px-3 rounded-lg bg-success hover:bg-success-hover text-brand-fg text-xs font-semibold active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-text">Accept</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      footer={
        <button onClick={() => onSignOut?.()}
          className="mx-auto block text-meta text-faint hover:text-muted transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
          Sign out
        </button>
      }
    >
      {pendingInvites.length > 0 && <div className="text-meta text-faint mb-3 text-center">Or create your own workspace</div>}
      <label className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5 block">Workspace name</label>
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
      .catch(e => reportError(e, 'invitations.list'));
    return () => { alive = false; };
  }, [currentWorkspaceId, canManageMembers, reloadKey]);

  if (!membershipsLoaded) return null;
  if (!canManageMembers) {
    return (
      <div className="space-y-6">
        <ViewHeader title="Members" subtitle="People in this workspace." />
        <div className="text-sm text-muted">Only an owner or admin can manage members and invitations.</div>
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
    catch (e) { reportError(e, 'invitations.revoke'); }
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
            className="w-full mb-3 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-brand-hover/30 bg-brand/10 text-left hover:bg-brand/15 transition-colors">
            <Lock className="w-3.5 h-3.5 text-brand-text shrink-0" />
            <span className="text-note text-brand-text/90 flex-1">You've reached your plan's member limit ({entitlements.limits.seats}). Upgrade to add more.</span>
            <span className="text-meta font-semibold text-brand-text shrink-0">See plans</span>
          </button>
        )}
        <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@example.com"
            className="flex-1 h-9 px-3 rounded-xl bg-fill border border-line text-sm text-primary outline-none focus:border-brand-hover/50 transition-colors" />
          <div className="inline-flex shrink-0 rounded-xl border border-line bg-fill p-0.5" role="radiogroup" aria-label="Invite as role">
            {['member', 'guest'].map(r => (
              <button key={r} type="button" role="radio" aria-checked={inviteRole === r} onClick={() => setInviteRole(r)}
                className={cx('px-3 h-8 rounded-lg text-xs font-medium capitalize transition-colors',
                  inviteRole === r ? 'bg-fill-strong text-primary' : 'text-muted hover:text-secondary')}>
                {r}
              </button>
            ))}
          </div>
          <button type="submit" disabled={busy || !email.trim()}
            className={cx('h-9 px-4 rounded-xl text-brand-fg text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors', (busy || !email.trim()) ? 'bg-brand/40 cursor-not-allowed' : 'bg-brand hover:bg-brand-hover')}>
            <Mail className="w-3.5 h-3.5" />Create invite link
          </button>
        </form>
        <p className="text-meta text-faint mt-2">
          {inviteRole === 'guest'
            ? 'Guests only see tasks assigned to them + direct messages — good for clients or freelancers. You can change their role later.'
            : 'Members get full access to this workspace (tasks, chat, projects). You can change their role later.'}
        </p>
        {err && <p className="text-meta text-danger-text mt-2">{err}</p>}
        {lastLink && (
          <div className="mt-3 p-3 rounded-xl border border-line bg-fill-subtle">
            <div className="text-meta text-muted mb-1.5">{copied ? 'Link copied. ' : ''}Send this to {lastLink.email} — joins as <span className="capitalize text-secondary">{lastLink.role || 'member'}</span>:</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-meta text-secondary">{lastLink.url}</code>
              <button onClick={() => copy(lastLink.url)} className="shrink-0 text-meta px-2 h-7 rounded-lg bg-fill border border-line hover:bg-fill-strong transition-colors">Copy</button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Current members" subtitle={`${members.length} in this workspace`}>
        {roleErr && <p className="text-meta text-danger-text mb-2">{roleErr}</p>}
        <div className="space-y-1.5">
          {members.map(m => {
            const targetRank = ROLE_RANK[m.role] ?? -1;
            const isSelf = m.userId === meId;
            const isLastOwner = m.role === 'owner' && ownerCount <= 1;
            // Who the caller may modify: owner -> anyone (except the last owner & themselves);
            // admin -> members/guests only. The server RPC enforces this regardless of the UI.
            const canModify = !isSelf && !isLastOwner && (myRank >= 3 ? true : (myRank >= 2 ? targetRank < 2 : false));
            return (
              <div key={m.userId} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-fill-subtle">
                <PersonButton personId={m.userId} className="min-w-0 gap-2.5 flex-1" title={isSelf ? 'Your profile' : `View ${m.displayName || m.email}'s profile`}>
                  <Avatar name={m.displayName || m.email} userId={m.userId} photoUrl={m.avatarUrl} size={32} />
                  <div className="min-w-0 text-left">
                    <div className="text-sm text-primary truncate">
                      {m.statusEmoji && <span className="mr-1">{m.statusEmoji}</span>}
                      {m.displayName || m.email}{isSelf && <span className="text-faint"> (you)</span>}
                    </div>
                    {/* status when they've set one, else the email — the profile view carries both anyway */}
                    <div className="text-meta text-faint truncate">{m.statusText || m.email}</div>
                  </div>
                </PersonButton>
                <div className="shrink-0 flex items-center gap-2">
                  {!isSelf && (
                    <button onClick={() => startDm(m.userId).catch(logCaught('dms.start from members'))} title={`Message ${m.displayName || m.email}`}
                      className="text-meta px-2 h-7 rounded-lg bg-fill border border-line hover:bg-fill-strong inline-flex items-center gap-1 transition-colors">
                      <MessagesSquare className="w-3 h-3" />Message
                    </button>
                  )}
                  {canModify ? (
                    <div className="relative">
                      <select value={m.role} onChange={(e) => changeRole(m.userId, e.target.value)} aria-label={`Role for ${m.displayName || m.email}`}
                        className="appearance-none text-meta h-7 rounded-lg bg-fill border border-line text-secondary pl-2.5 pr-6 outline-none focus:border-line-strong hover:bg-fill-strong hover:border-line-strong cursor-pointer transition-colors">
                        {settableRoles.map(r => <option key={r} value={r} className="bg-surface-raised">{ROLE_LABELS[r]}</option>)}
                      </select>
                      <ChevronDown className="w-3 h-3 text-faint absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  ) : (
                    <span title={isLastOwner ? 'The last owner — promote another owner first to change this' : undefined}
                      className="text-micro uppercase tracking-wide text-faint bg-fill border border-line rounded-md px-1.5 h-5 flex items-center">{ROLE_LABELS[m.role] || m.role}</span>
                  )}
                  {canModify && (
                    <button onClick={() => setRemoveTarget(m)} aria-label={`Remove ${m.displayName || m.email}`}
                      className="text-faint hover:text-danger-text hover:bg-fill p-1.5 rounded-lg transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Pending invitations" subtitle={pending.length ? `${pending.length} awaiting acceptance` : 'None yet'}>
        {pending.length === 0 ? (
          <div className="text-meta text-faint">No pending invitations.</div>
        ) : (
          <div className="space-y-1.5">
            {pending.map(i => (
              <div key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-fill-subtle">
                <div className="min-w-0">
                  <div className="text-sm text-primary truncate">{i.email}</div>
                  <div className="text-meta text-faint">invited {timeAgo(i.created_at)}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => copy(inviteUrl(i.token))} className="text-meta px-2 h-7 rounded-lg bg-fill border border-line hover:bg-fill-strong inline-flex items-center gap-1 transition-colors"><Link2 className="w-3 h-3" />Copy link</button>
                  <button onClick={() => revoke(i.id)} aria-label="Revoke invitation" className="text-meta px-2 h-7 rounded-lg text-muted hover:text-danger-text hover:bg-fill inline-flex items-center gap-1 transition-colors"><X className="w-3 h-3" />Revoke</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Redirect the legacy /va-desk path to /my-tasks, preserving the ?ws= workspace query param.
 *  The ROUTE must stay even though the label is long gone — old bookmarks and links still hit it. */
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
      <div data-surface="dark" className="min-h-screen bg-canvas text-primary flex items-center justify-center">
        
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-2xl shadow-brand/15 animate-pulse">
            <Sparkles className="w-6 h-6 text-brand-fg" />
          </div>
          <div className="text-sm text-muted">Loading your workspace…</div>
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
    <div className="min-h-screen flex bg-canvas text-primary" data-theme={theme}>

      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-4 lg:px-6 py-6 pb-24 lg:pb-10">
          <div className="max-w-[1400px] mx-auto animate-[slideUp_.25s_ease]" key={view}>
            <Routes>
              {/* Per-view boundaries: a render throw inside one view shows an inline fallback while the
                  shell (sidebar/top bar/nav) stays alive. Navigating away unmounts the boundary, so the
                  next visit always retries fresh. */}
              <Route path="/" element={<ErrorBoundary name="dashboard"><DashboardView /></ErrorBoundary>} />
              <Route path="/kanban" element={<ErrorBoundary name="kanban"><KanbanView /></ErrorBoundary>} />
              <Route path="/priority-matrix" element={<ErrorBoundary name="matrix"><MatrixView /></ErrorBoundary>} />
              <Route path="/projects" element={<ErrorBoundary name="projects"><ProjectsView /></ErrorBoundary>} />
              <Route path="/schedule" element={<ErrorBoundary name="schedule"><ScheduleView /></ErrorBoundary>} />
              <Route path="/my-tasks" element={<ErrorBoundary name="my-tasks"><MyTasksView /></ErrorBoundary>} />
              <Route path="/va-desk" element={<RedirectToMyTasks />} />
              <Route path="/private" element={<ErrorBoundary name="private"><PrivateView /></ErrorBoundary>} />
              <Route path="/chat" element={<ErrorBoundary name="chat"><ChatView /></ErrorBoundary>} />
              <Route path="/dms" element={<ErrorBoundary name="dms"><DirectMessagesView /></ErrorBoundary>} />
              <Route path="/members" element={<ErrorBoundary name="members"><MembersView /></ErrorBoundary>} />
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
      <ProfileView />
      <PlanPreviewBanner />
    </div>
  );
}
