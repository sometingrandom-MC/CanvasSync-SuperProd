// Canvas Assignments v2.0.2 for Super Productivity. Built from src/ — edit there.
"use strict";
(() => {
  // src/assignments.ts
  var makeIssueId = (courseId, assignmentId) => `${courseId}:${assignmentId}`;
  var parseIssueId = (issueId) => {
    const m = /^(\d+):(\d+)$/.exec(String(issueId));
    return m ? { courseId: m[1], assignmentId: m[2] } : null;
  };
  var toMs = (iso) => {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  var isSubmitted = (s) => {
    if (!s) return false;
    if (s.excused) return true;
    if (s.submitted_at) return true;
    return ["submitted", "graded", "pending_review", "complete"].includes(
      s.workflow_state ?? ""
    );
  };
  var courseName = (c) => (c.name || c.course_code || `Course ${c.id}`).trim();
  var isInSession = (c, now = Date.now()) => {
    if (c.access_restricted_by_date) return false;
    const start = toMs(c.start_at) ?? toMs(c.term?.start_at);
    const end = toMs(c.end_at) ?? toMs(c.term?.end_at);
    if (start !== null && now < start) return false;
    if (end !== null && now > end) return false;
    return true;
  };
  var selectCourses = (courses, settings, now = Date.now()) => {
    const usable = courses.filter((c) => c && c.id != null && !c.access_restricted_by_date);
    if (settings.courseIds.length) {
      const picked = new Set(settings.courseIds);
      return usable.filter((c) => picked.has(String(c.id)));
    }
    return usable.filter((c) => isInSession(c, now));
  };
  var htmlToText = (html) => {
    if (!html) return "";
    return html.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").replace(/<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const label = String(text).replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `[${label}](${href})` : href;
    }).replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\s*li[^>]*>/gi, "\n- ").replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr|table|blockquote)\s*>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  var toAssignment = (a, courseId, courseTitle, baseUrl) => {
    const assignmentId = String(a.id);
    return {
      issueId: makeIssueId(courseId, assignmentId),
      assignmentId,
      courseId,
      courseName: courseTitle,
      title: (a.name || "Assignment").trim(),
      dueMs: toMs(a.due_at),
      url: a.html_url || `${baseUrl}/courses/${courseId}/assignments/${assignmentId}`,
      points: typeof a.points_possible === "number" ? a.points_possible : null,
      submitted: isSubmitted(a.submission),
      updatedMs: toMs(a.updated_at) ?? 0,
      description: htmlToText(a.description)
    };
  };
  var skipReason = (a, settings, now = Date.now()) => {
    if (a.submitted && !settings.includeSubmitted) return "submitted";
    if (a.dueMs === null) return settings.includeUndated ? null : "undated";
    if (a.dueMs < now && !settings.includeOverdue) return "overdue";
    if (a.dueMs > now + settings.daysAhead * 864e5) return "tooFar";
    return null;
  };
  var formatDue = (ms) => ms === null ? "No due date" : new Date(ms).toLocaleString(void 0, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  var stateOf = (a) => a.submitted ? "submitted" : "open";
  var toSearchResult = (a, settings) => {
    const schedule = a.dueMs === null ? {} : settings.scheduleWholeDay ? { start: a.dueMs, isAllDay: true } : { dueWithTime: a.dueMs };
    return {
      id: a.issueId,
      title: a.title,
      url: a.url,
      status: stateOf(a),
      description: a.description,
      ...schedule,
      courseName: a.courseName,
      dueText: formatDue(a.dueMs)
    };
  };
  var toIssue = (a) => ({
    id: a.issueId,
    title: a.title,
    body: a.description,
    url: a.url,
    state: stateOf(a),
    lastUpdated: a.updatedMs,
    courseName: a.courseName,
    dueText: formatDue(a.dueMs),
    pointsText: a.points === null ? "" : `${a.points} pts`,
    summary: a.title
  });

  // src/canvas-api.ts
  var REQUEST_TIMEOUT_MS = 45e3;
  var PER_PAGE = 100;
  var MAX_PAGES = 20;
  var MAX_ATTEMPTS = 3;
  var COURSE_CONCURRENCY = 3;
  var RETRYABLE_STATUS = /* @__PURE__ */ new Set([0, 408, 425, 429, 500, 502, 503, 504]);
  var sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var errorStatus = (err) => {
    const status = err?.status;
    return typeof status === "number" ? status : void 0;
  };
  var errorText = (err) => {
    if (!err) return "";
    const e = err;
    const parts = [];
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.error === "string") parts.push(e.error);
    else if (e.error) {
      try {
        parts.push(JSON.stringify(e.error));
      } catch {
      }
    }
    return parts.join(" ");
  };
  var isRateLimited = (err) => errorStatus(err) === 403 && /rate limit/i.test(errorText(err));
  var isRetryable = (err) => {
    const status = errorStatus(err);
    if (status === void 0) {
      return true;
    }
    return RETRYABLE_STATUS.has(status) || isRateLimited(err);
  };
  var describeError = (err) => {
    const status = errorStatus(err);
    if (status === 200) {
      return "Canvas returned a web page instead of data. Check the Canvas URL.";
    }
    if (status === 401) return "Canvas rejected the access token (401). Generate a new token.";
    if (isRateLimited(err)) return "Canvas rate limit hit (403). It will retry on the next poll.";
    if (status === 403) return "Canvas denied access (403).";
    if (status === 404) return "Not found on Canvas (404). Check the Canvas URL.";
    if (status !== void 0 && status >= 500) return `Canvas server error (${status}).`;
    if (status === 0 || status === void 0) {
      const text = errorText(err);
      if (/timeout/i.test(text)) return "Canvas did not answer in time.";
      return `Could not reach Canvas${text ? `: ${text}` : "."}`;
    }
    return `Canvas request failed (${status}).`;
  };
  var CanvasClient = class {
    constructor(http, settings) {
      this.http = http;
      this.settings = settings;
    }
    url(path) {
      return `${this.settings.baseUrl}/api/v1${path}`;
    }
    /** GET with retry + exponential backoff on throttling, 5xx and timeouts. */
    async get(path, params) {
      let lastErr;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await this.http.get(this.url(path), {
            params,
            timeout: REQUEST_TIMEOUT_MS
          });
          if (typeof res === "string") {
            throw Object.assign(
              new Error("Canvas returned a web page instead of data. Check the Canvas URL."),
              { status: 200 }
            );
          }
          return res;
        } catch (err) {
          lastErr = err;
          if (attempt === MAX_ATTEMPTS || !isRetryable(err)) {
            break;
          }
          const base = isRateLimited(err) || errorStatus(err) === 429 ? 4e3 : 1e3;
          await sleepImpl(base * 2 ** (attempt - 1));
        }
      }
      throw lastErr;
    }
    /** Fetches every page of a list endpoint using `page=N`. */
    async getAll(path, params = {}) {
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const items = await this.get(path, {
          ...params,
          per_page: String(PER_PAGE),
          page: String(page)
        });
        if (!Array.isArray(items) || items.length === 0) {
          break;
        }
        let added = 0;
        for (const item of items) {
          const key = String(item.id);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(item);
            added++;
          }
        }
        if (items.length < PER_PAGE || added === 0) {
          break;
        }
      }
      return out;
    }
    getSelf() {
      return this.get("/users/self");
    }
    getActiveCourses() {
      return this.getAll("/courses", {
        enrollment_state: "active",
        "include[]": "term"
      });
    }
    getAssignments(courseId) {
      return this.getAll(
        `/courses/${encodeURIComponent(courseId)}/assignments`,
        { "include[]": "submission", order_by: "due_at" }
      );
    }
    getAssignment(courseId, assignmentId) {
      return this.get(
        `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`,
        { "include[]": "submission" }
      );
    }
  };
  var mapLimit = async (items, limit, fn) => {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  };

  // src/config.ts
  var DEFAULT_DAYS_AHEAD = 60;
  var REMINDER_OFFSETS = {
    none: null,
    atDue: 0,
    "15m": 15 * 6e4,
    "1h": 60 * 6e4,
    "3h": 3 * 60 * 6e4,
    "1d": 24 * 60 * 6e4
  };
  var normaliseBaseUrl = (input) => {
    const raw = (input ?? "").trim();
    if (!raw) {
      throw new Error("Canvas URL is not configured.");
    }
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`"${raw}" is not a valid Canvas URL.`);
    }
    return `${url.protocol}//${url.host}`;
  };
  var toSettings = (config) => {
    const cfg = config;
    const token = (cfg.token ?? "").trim();
    if (!token) {
      throw new Error("Canvas access token is not configured.");
    }
    const days = parseInt(String(cfg.daysAhead ?? ""), 10);
    const courseIds = Array.isArray(cfg.courseIds) ? cfg.courseIds : typeof cfg.courseIds === "string" && cfg.courseIds ? [cfg.courseIds] : [];
    return {
      baseUrl: normaliseBaseUrl(cfg.host),
      token,
      courseIds: courseIds.map(String).filter(Boolean),
      daysAhead: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS_AHEAD,
      includeOverdue: !!cfg.includeOverdue,
      includeUndated: !!cfg.includeUndated,
      includeSubmitted: !!cfg.includeSubmitted,
      scheduleWholeDay: !!cfg.scheduleWholeDay,
      projectPerCourse: !cfg.keepInDefaultProject,
      reminderOffsetMs: REMINDER_OFFSETS[cfg.deadlineReminder ?? "none"] ?? null
    };
  };

  // src/task-sync.ts
  var PLUGIN_ID = "canvas-sync";
  var ISSUE_TYPE = `plugin:${PLUGIN_ID}`;
  var emptyState = () => ({ v: 2, courseProjects: {}, lastDue: {}, imported: {} });
  var MARKER_RE = /\[canvas-sync:([^\]]+)\]/;
  var markerOf = (assignmentId) => `[canvas-sync:${assignmentId}]`;
  var assignmentIdOf = (task) => {
    if (task.issueType === ISSUE_TYPE && task.issueId) {
      const parsed = parseIssueId(task.issueId);
      if (parsed) return parsed.assignmentId;
    }
    const m = MARKER_RE.exec(task.notes || "");
    return m ? m[1] : null;
  };
  var canvasProviderId = (tasks) => {
    const counts = /* @__PURE__ */ new Map();
    for (const t of tasks) {
      if (t.issueType === ISSUE_TYPE && t.issueProviderId) {
        counts.set(t.issueProviderId, (counts.get(t.issueProviderId) ?? 0) + 1);
      }
    }
    let best = null;
    for (const [id, n] of counts) if (!best || n > counts.get(best)) best = id;
    return best;
  };
  var parseState = (raw) => {
    if (!raw) return { state: emptyState(), migrated: false };
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { state: emptyState(), migrated: true };
    }
    if (data && data["v"] === 2) {
      const s = data;
      return {
        state: {
          v: 2,
          courseProjects: { ...s.courseProjects || {} },
          lastDue: { ...s.lastDue || {} },
          imported: { ...s.imported || {} }
        },
        migrated: false
      };
    }
    const state = emptyState();
    const cp = data?.["courseProjects"];
    if (cp && typeof cp === "object") {
      for (const [k, v] of Object.entries(cp)) {
        if (typeof v === "string") state.courseProjects[k] = v;
      }
    }
    const synced = data?.["syncedTasks"];
    if (synced && typeof synced === "object") {
      for (const id of Object.keys(synced)) {
        state.imported[id] = 1;
      }
    }
    return { state, migrated: true };
  };
  var deadlineFields = (dueMs, settings, isDone, now = Date.now()) => {
    if (dueMs === null) {
      return { deadlineDay: null, deadlineWithTime: null, deadlineRemindAt: null };
    }
    let remindAt = null;
    if (!isDone && settings.reminderOffsetMs !== null) {
      const at = dueMs - settings.reminderOffsetMs;
      if (at > now) remindAt = at;
    }
    return { deadlineDay: null, deadlineWithTime: dueMs, deadlineRemindAt: remindAt };
  };
  var TaskSync = class {
    constructor(api, now = Date.now) {
      this.queue = Promise.resolve();
      this.state = null;
      /** Latest data for each assignment, from any Canvas fetch this session. */
      this.known = /* @__PURE__ */ new Map();
      /** Settings from the last provider call, for hook processing. */
      this.settings = null;
      this.api = api;
      this.now = now;
    }
    /** Serialises `fn` behind all earlier work. */
    run(fn) {
      const next = this.queue.then(fn, fn);
      this.queue = next.catch(() => void 0);
      return next;
    }
    remember(assignments) {
      for (const a of assignments) this.known.set(a.assignmentId, a);
    }
    /**
     * Reads saved state fresh on every queued run: SP sync may have brought in
     * another device's changes, and saving a stale copy would drop them.
     */
    async load() {
      let raw = null;
      try {
        raw = await this.api.loadSyncedData();
      } catch {
        raw = null;
      }
      const { state, migrated } = parseState(raw);
      this.state = state;
      if (migrated) await this.save();
      return state;
    }
    async save() {
      if (this.state) await this.api.persistDataSynced(JSON.stringify(this.state));
    }
    /**
     * Assignment ids that must not be auto-imported: anything this plugin (old
     * or new) already made a task for, including archived and deleted tasks.
     */
    excludedAssignmentIds() {
      return this.run(async () => {
        const state = await this.load();
        const ids = new Set(Object.keys(state.imported));
        const [active, archived] = await Promise.all([
          this.api.getTasks(),
          this.api.getArchivedTasks().catch(() => [])
        ]);
        for (const t of [...active, ...archived]) {
          const id = assignmentIdOf(t);
          if (id) ids.add(id);
        }
        return ids;
      });
    }
    async projectFor(a, state) {
      const projects = await this.api.getAllProjects();
      const existing = state.courseProjects[a.courseId];
      if (existing && projects.some((p) => p.id === existing && !p.isArchived)) {
        return existing;
      }
      const byTitle = projects.find((p) => p.title === a.courseName && !p.isArchived);
      const id = byTitle ? byTitle.id : await this.api.addProject({ title: a.courseName });
      state.courseProjects[a.courseId] = id;
      return id;
    }
    /**
     * Finishes a task SP imported: notes marker, deadline (if it has none),
     * course project, and optionally the exact Canvas title.
     */
    async finish(task, a, state, settings, restoreTitle) {
      const updates = {};
      const marker = markerOf(a.assignmentId);
      if (!(task.notes || "").includes(marker)) {
        updates.notes = task.notes ? `${task.notes}

${marker}` : marker;
      }
      if (restoreTitle && task.title !== a.title) {
        updates.title = a.title;
        if (updates.notes === void 0) updates.notes = task.notes || "";
      }
      if (!task.deadlineWithTime && !task.deadlineDay && a.dueMs !== null) {
        Object.assign(updates, deadlineFields(a.dueMs, settings, task.isDone, this.now()));
      }
      if (Object.keys(updates).length) {
        await this.api.updateTask(task.id, updates);
      }
      if (settings.projectPerCourse && !task.parentId) {
        const projectId = await this.projectFor(a, state);
        if (task.projectId !== projectId) {
          await this.api.updateTask(task.id, { projectId });
        }
      }
      state.imported[a.assignmentId] = 1;
      state.lastDue[a.assignmentId] = a.dueMs;
    }
    /**
     * Runs `finish` for a task SP just imported (from the taskCreated hook),
     * after giving SP's own post-import steps time to settle.
     */
    processNewTask(taskId, delayMs = 1500) {
      return new Promise((resolve) => setTimeout(resolve, delayMs)).then(
        () => this.run(async () => {
          const settings = this.settings;
          const tasks = await this.api.getTasks();
          const task = tasks.find((t) => t.id === taskId);
          if (!task || task.issueType !== ISSUE_TYPE || !task.issueId) return;
          const parsed = parseIssueId(task.issueId);
          const a = parsed && this.known.get(parsed.assignmentId);
          if (!a || !settings) {
            return;
          }
          if ((task.notes || "").includes(markerOf(a.assignmentId))) return;
          const state = await this.load();
          await this.finish(task, a, state, settings, true);
          await this.save();
        })
      );
    }
    /**
     * Applies fresh Canvas data to existing tasks. Only deadlines change, and
     * only when Canvas changed the due date (or the task never had one).
     * Returns notices for the user.
     */
    reconcile(fresh, settings) {
      this.settings = settings;
      this.remember(fresh);
      return this.run(async () => {
        const state = await this.load();
        const byId = new Map(fresh.map((a) => [a.assignmentId, a]));
        const tasks = await this.api.getTasks();
        const moved = [];
        let linked = 0;
        let dirty = false;
        const now = this.now();
        const providerId = canvasProviderId(tasks);
        const linkedAids = new Set(
          tasks.filter((t) => t.issueType === ISSUE_TYPE).map((t) => assignmentIdOf(t))
        );
        for (const task of tasks) {
          const aid = assignmentIdOf(task);
          const a = aid ? byId.get(aid) : void 0;
          if (!aid || !a) continue;
          const importedHere = task.issueType === ISSUE_TYPE;
          if (task.issueType !== ISSUE_TYPE && !task.isDone && !task.parentId && providerId && !linkedAids.has(aid)) {
            const link = {
              issueId: a.issueId,
              issueType: ISSUE_TYPE,
              issueProviderId: providerId,
              issueWasUpdated: false,
              issueLastUpdated: a.updatedMs
            };
            await this.api.updateTask(task.id, link);
            Object.assign(task, link);
            linkedAids.add(aid);
            linked++;
          }
          if (!state.imported[aid]) {
            state.imported[aid] = 1;
            dirty = true;
          }
          const hasDeadline = !!(task.deadlineWithTime || task.deadlineDay);
          const prev = state.lastDue[aid];
          if (prev === void 0) {
            if (importedHere) {
              await this.finish(task, a, state, settings, false);
            } else if (!hasDeadline && a.dueMs !== null) {
              await this.api.updateTask(
                task.id,
                deadlineFields(a.dueMs, settings, task.isDone, now)
              );
            }
            state.lastDue[aid] = a.dueMs;
            dirty = true;
            continue;
          }
          if (prev !== a.dueMs) {
            await this.api.updateTask(
              task.id,
              deadlineFields(a.dueMs, settings, task.isDone, now)
            );
            state.lastDue[aid] = a.dueMs;
            dirty = true;
            if (!task.isDone) moved.push(a.title);
          }
        }
        if (dirty) await this.save();
        const notices = [];
        if (linked) {
          notices.push({
            type: "SUCCESS",
            msg: `Canvas: linked ${linked} unfinished task${linked === 1 ? "" : "s"} from the old Canvas plugin to this integration.`
          });
        }
        if (moved.length) {
          const list = moved.slice(0, 3).join(", ") + (moved.length > 3 ? ` +${moved.length - 3} more` : "");
          notices.push({
            type: "INFO",
            msg: `Canvas changed the due date of ${moved.length === 1 ? "" : `${moved.length} assignments: `}${list}. The deadline was updated; your schedule was not changed.`
          });
        }
        return notices;
      });
    }
  };

  // src/plugin.ts
  var sync = new TaskSync(PluginAPI);
  var lastShown = /* @__PURE__ */ new Map();
  var notify = (n) => {
    const now = Date.now();
    if ((lastShown.get(n.msg) ?? 0) > now - 60 * 6e4) return;
    lastShown.set(n.msg, now);
    try {
      PluginAPI.showSnack({ msg: n.msg, type: n.type ?? "INFO", ico: "school" });
    } catch {
    }
  };
  var log = (...args) => {
    try {
      PluginAPI.log.err("[Canvas]", ...args);
    } catch {
    }
  };
  var fetchCourseAssignments = async (client, courses, settings) => {
    const failedCourses = [];
    let firstError;
    const lists = await mapLimit(courses, COURSE_CONCURRENCY, async (c) => {
      const id = String(c.id);
      try {
        const raw = await client.getAssignments(id);
        return raw.map((a) => toAssignment(a, id, courseName(c), settings.baseUrl));
      } catch (err) {
        failedCourses.push(courseName(c));
        firstError ?? (firstError = err);
        return [];
      }
    });
    const assignments = lists.flat();
    sync.remember(assignments);
    return { assignments, failedCourses, firstError };
  };
  var fetchSelected = async (http, settings) => {
    const client = new CanvasClient(http, settings);
    const courses = selectCourses(await client.getActiveCourses(), settings);
    return fetchCourseAssignments(client, courses, settings);
  };
  var courseNameCache = null;
  var courseNames = async (client) => {
    if (!courseNameCache) {
      const courses = await client.getActiveCourses();
      courseNameCache = new Map(courses.map((c) => [String(c.id), courseName(c)]));
    }
    return courseNameCache;
  };
  var settingsOf = (config) => {
    const settings = toSettings(config);
    sync.settings = settings;
    return settings;
  };
  PluginAPI.registerIssueProvider({
    configFields: [
      {
        key: "host",
        type: "input",
        label: "Canvas URL",
        description: "Your Canvas address, e.g. https://school.instructure.com",
        required: true
      },
      {
        key: "token",
        type: "password",
        label: "Access token",
        description: "Canvas \u2192 Account \u2192 Settings \u2192 Approved Integrations \u2192 New Access Token",
        required: true
      },
      {
        key: "tokenHelp",
        type: "link",
        label: "How to create a Canvas access token",
        url: "https://community.canvaslms.com/t5/Canvas-Basics-Guide/How-do-I-manage-API-access-tokens-in-my-user-account/ta-p/615312"
      },
      {
        key: "courseIds",
        type: "multiSelect",
        label: "Courses",
        description: "Load your courses, then pick the ones to import. Leave empty to import every course currently in session.",
        async loadOptions(config, http) {
          const client = new CanvasClient(http, settingsOf(config));
          const courses = await client.getActiveCourses();
          return courses.filter((c) => !c.access_restricted_by_date).sort((a, b) => Number(isInSession(b)) - Number(isInSession(a))).map((c) => ({
            value: String(c.id),
            label: isInSession(c) ? courseName(c) : `${courseName(c)} (not in session)`
          }));
        }
      },
      {
        key: "daysAhead",
        type: "input",
        label: "Import assignments due within (days)",
        description: "Default 60.",
        pattern: "^\\d*$"
      },
      {
        key: "deadlineReminder",
        type: "select",
        label: "Deadline reminder",
        description: "Never shown for tasks you have already completed.",
        options: [
          { value: "none", label: "None" },
          { value: "atDue", label: "At the due time" },
          { value: "15m", label: "15 minutes before" },
          { value: "1h", label: "1 hour before" },
          { value: "3h", label: "3 hours before" },
          { value: "1d", label: "1 day before" }
        ]
      },
      {
        key: "includeOverdue",
        type: "checkbox",
        label: "Also import assignments that are already past due",
        advanced: true
      },
      {
        key: "includeUndated",
        type: "checkbox",
        label: "Also import assignments without a due date (unscheduled)",
        advanced: true
      },
      {
        key: "includeSubmitted",
        type: "checkbox",
        label: "Also import assignments you have already submitted",
        advanced: true
      },
      {
        key: "scheduleWholeDay",
        type: "checkbox",
        label: "Schedule on the due day instead of at the exact due time",
        description: "The deadline always keeps the exact due time.",
        advanced: true
      },
      {
        key: "keepInDefaultProject",
        type: "checkbox",
        label: "Keep tasks in this integration's project (no project per course)",
        advanced: true
      }
    ],
    getHeaders(config) {
      const token = String(config.token ?? "").trim();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    async testConnection(config, http) {
      try {
        await new CanvasClient(http, settingsOf(config)).getSelf();
        return true;
      } catch (err) {
        log("connection test failed", describeError(err));
        return false;
      }
    },
    async getNewIssuesForBacklog(config, http) {
      let settings;
      try {
        settings = settingsOf(config);
      } catch (err) {
        notify({ type: "WARNING", msg: `Canvas: ${err.message}` });
        return [];
      }
      let result;
      try {
        result = await fetchSelected(http, settings);
      } catch (err) {
        notify({ type: "ERROR", msg: `Canvas: ${describeError(err)}` });
        return [];
      }
      if (result.failedCourses.length) {
        notify({
          type: "WARNING",
          msg: `Canvas: couldn't load ${result.failedCourses.join(", ")} (${describeError(result.firstError)}). Other courses were imported.`
        });
      }
      try {
        (await sync.reconcile(result.assignments, settings)).forEach(notify);
      } catch (err) {
        log("updating deadlines failed", err);
      }
      const excluded = await sync.excludedAssignmentIds();
      const now = Date.now();
      return result.assignments.filter((a) => !excluded.has(a.assignmentId) && skipReason(a, settings, now) === null).map((a) => toSearchResult(a, settings));
    },
    async searchIssues(searchTerm, config, http) {
      const settings = settingsOf(config);
      const { assignments } = await fetchSelected(http, settings);
      const term = searchTerm.trim().toLowerCase();
      const now = Date.now();
      return assignments.filter(
        (a) => term ? a.title.toLowerCase().includes(term) || a.courseName.toLowerCase().includes(term) : a.dueMs === null || a.dueMs >= now
      ).sort((a, b) => (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)).slice(0, 50).map((a) => toSearchResult(a, settings));
    },
    async getById(issueId, config, http) {
      const settings = settingsOf(config);
      const ids = parseIssueId(issueId);
      if (!ids) throw new Error(`Unknown Canvas assignment id "${issueId}"`);
      const client = new CanvasClient(http, settings);
      const raw = await client.getAssignment(ids.courseId, ids.assignmentId);
      const name = sync.known.get(ids.assignmentId)?.courseName ?? (await courseNames(client).catch(() => /* @__PURE__ */ new Map())).get(ids.courseId) ?? `Course ${ids.courseId}`;
      const a = toAssignment(raw, ids.courseId, name, settings.baseUrl);
      sync.remember([a]);
      return toIssue(a);
    },
    /** Batch refresh: one assignment list per course instead of one call per task. */
    async getByIds(issueIds, config, http) {
      const settings = settingsOf(config);
      const client = new CanvasClient(http, settings);
      const wanted = new Set(issueIds);
      const courseIds = [
        ...new Set(issueIds.map((id) => parseIssueId(id)?.courseId).filter((c) => !!c))
      ];
      const names = await courseNames(client).catch(() => /* @__PURE__ */ new Map());
      const courses = courseIds.map((id) => ({ id, name: names.get(id) }));
      const { assignments } = await fetchCourseAssignments(client, courses, settings);
      const found = assignments.filter((a) => wanted.has(a.issueId));
      try {
        (await sync.reconcile(found, settings)).forEach(notify);
      } catch (err) {
        log("updating deadlines failed", err);
      }
      return found.map(toIssue);
    },
    getIssueLink(issueId, config) {
      const ids = parseIssueId(issueId);
      let base = "";
      try {
        base = normaliseBaseUrl(config.host);
      } catch {
      }
      return ids ? `${base}/courses/${ids.courseId}/assignments/${ids.assignmentId}` : base;
    },
    issueDisplay: [
      { field: "summary", label: "Assignment", type: "link", linkField: "url" },
      { field: "courseName", label: "Course", type: "text" },
      { field: "dueText", label: "Due", type: "text" },
      { field: "pointsText", label: "Points", type: "text", hideEmpty: true },
      { field: "state", label: "Status", type: "text" },
      { field: "body", label: "Description", type: "markdown", hideEmpty: true }
    ],
    // Submitting in Canvas never ticks a task off (or reopens it): done stays yours.
    doneStates: []
  });
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_CREATED, (payload) => {
    const task = payload ?? {};
    if (task.taskId && task.task?.issueType === ISSUE_TYPE) {
      sync.processNewTask(task.taskId).catch((err) => log("finishing imported task failed", err));
    }
  });
})();
