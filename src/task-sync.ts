// Everything the plugin does to Super Productivity tasks itself, on top of SP's
// own issue import:
//
//  - after SP imports an assignment: set the deadline, add the notes marker,
//    restore the exact Canvas title, and move the task to its course project;
//  - on every poll: when Canvas changes a due date, move the task's deadline
//    (never its schedule) and say so;
//  - recognise tasks made by the previous Canvas Sync plugin (notes marker) so
//    they are never imported twice, and give them a deadline too.
//
// Tasks are never deleted, and the scheduled date is only ever set by SP on
// import. All work runs through one queue so concurrent hooks and polls can't
// create duplicate projects or overwrite each other's saved state.

import type { PluginAPI, Task } from '../vendor/plugin-api/index.ts';
import type { Assignment } from './assignments.ts';
import { parseIssueId } from './assignments.ts';
import type { Settings } from './config.ts';

export const PLUGIN_ID = 'canvas-sync';
export const ISSUE_TYPE = `plugin:${PLUGIN_ID}`;

/** The deadline fields exist on tasks in SP 19.x but not on the plugin `Task` type. */
export type SpTask = Task & {
  deadlineDay?: string | null;
  deadlineWithTime?: number | null;
  deadlineRemindAt?: number | null;
};

export interface SyncState {
  v: 2;
  /** Canvas course id -> SP project id. Carried over from the old plugin. */
  courseProjects: Record<string, string>;
  /** Assignment id -> last Canvas due date (ms, or null) the task was given. */
  lastDue: Record<string, number | null>;
  /**
   * Assignment ids that already have (or had) a task. They are never
   * auto-imported again, so deleting a task you don't want keeps it gone.
   */
  imported: Record<string, 1>;
}

const emptyState = (): SyncState => ({ v: 2, courseProjects: {}, lastDue: {}, imported: {} });

export const MARKER_RE = /\[canvas-sync:([^\]]+)\]/;
export const markerOf = (assignmentId: string): string => `[canvas-sync:${assignmentId}]`;

/** Assignment id of a task this plugin (old or new) created, else null. */
export const assignmentIdOf = (task: Pick<Task, 'issueType' | 'issueId' | 'notes'>): string | null => {
  if (task.issueType === ISSUE_TYPE && task.issueId) {
    const parsed = parseIssueId(task.issueId);
    if (parsed) return parsed.assignmentId;
  }
  const m = MARKER_RE.exec(task.notes || '');
  return m ? m[1] : null;
};

/**
 * The Canvas integration's id in SP. A plugin isn't told it, so it's read off
 * tasks the integration imported (the most common one, if there are several).
 */
export const canvasProviderId = (tasks: Pick<Task, 'issueType' | 'issueProviderId'>[]): string | null => {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.issueType === ISSUE_TYPE && t.issueProviderId) {
      counts.set(t.issueProviderId, (counts.get(t.issueProviderId) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  for (const [id, n] of counts) if (!best || n > counts.get(best)!) best = id;
  return best;
};

/** Reads saved state, migrating the old plugin's blob (and dropping its token). */
export const parseState = (raw: string | null): { state: SyncState; migrated: boolean } => {
  if (!raw) return { state: emptyState(), migrated: false };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { state: emptyState(), migrated: true };
  }
  if (data && data['v'] === 2) {
    const s = data as unknown as SyncState;
    return {
      state: {
        v: 2,
        courseProjects: { ...(s.courseProjects || {}) },
        lastDue: { ...(s.lastDue || {}) },
        imported: { ...(s.imported || {}) },
      },
      migrated: false,
    };
  }
  // Old plugin format: { baseUrl, token, courseProjects, syncedTasks, ... }.
  const state = emptyState();
  const cp = data?.['courseProjects'];
  if (cp && typeof cp === 'object') {
    for (const [k, v] of Object.entries(cp as Record<string, unknown>)) {
      if (typeof v === 'string') state.courseProjects[k] = v;
    }
  }
  const synced = data?.['syncedTasks'];
  if (synced && typeof synced === 'object') {
    for (const id of Object.keys(synced as Record<string, unknown>)) {
      state.imported[id] = 1;
    }
  }
  return { state, migrated: true };
};

export interface Notice {
  msg: string;
  type?: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO';
}

/** Deadline + reminder fields for a Canvas due date. */
export const deadlineFields = (
  dueMs: number | null,
  settings: Pick<Settings, 'reminderOffsetMs'>,
  isDone: boolean,
  now = Date.now(),
): Pick<SpTask, 'deadlineDay' | 'deadlineWithTime' | 'deadlineRemindAt'> => {
  if (dueMs === null) {
    return { deadlineDay: null, deadlineWithTime: null, deadlineRemindAt: null };
  }
  let remindAt: number | null = null;
  // A finished task never gets a reminder (SP clears it on done; don't re-arm it).
  if (!isDone && settings.reminderOffsetMs !== null) {
    const at = dueMs - settings.reminderOffsetMs;
    if (at > now) remindAt = at;
  }
  return { deadlineDay: null, deadlineWithTime: dueMs, deadlineRemindAt: remindAt };
};

export class TaskSync {
  private queue: Promise<unknown> = Promise.resolve();
  private state: SyncState | null = null;
  /** Latest data for each assignment, from any Canvas fetch this session. */
  readonly known = new Map<string, Assignment>();
  /** Settings from the last provider call, for hook processing. */
  settings: Settings | null = null;

  private readonly api: PluginAPI;
  private readonly now: () => number;

  constructor(api: PluginAPI, now: () => number = Date.now) {
    this.api = api;
    this.now = now;
  }

  /** Serialises `fn` behind all earlier work. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  remember(assignments: Iterable<Assignment>): void {
    for (const a of assignments) this.known.set(a.assignmentId, a);
  }

  /**
   * Reads saved state fresh on every queued run: SP sync may have brought in
   * another device's changes, and saving a stale copy would drop them.
   */
  private async load(): Promise<SyncState> {
    let raw: string | null = null;
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

  private async save(): Promise<void> {
    if (this.state) await this.api.persistDataSynced(JSON.stringify(this.state));
  }

  /**
   * Assignment ids that must not be auto-imported: anything this plugin (old
   * or new) already made a task for, including archived and deleted tasks.
   */
  excludedAssignmentIds(): Promise<Set<string>> {
    return this.run(async () => {
      const state = await this.load();
      const ids = new Set(Object.keys(state.imported));
      const [active, archived] = await Promise.all([
        this.api.getTasks(),
        this.api.getArchivedTasks().catch(() => [] as Task[]),
      ]);
      for (const t of [...active, ...archived]) {
        const id = assignmentIdOf(t);
        if (id) ids.add(id);
      }
      return ids;
    });
  }

  private async projectFor(a: Assignment, state: SyncState): Promise<string> {
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
  private async finish(
    task: SpTask,
    a: Assignment,
    state: SyncState,
    settings: Settings,
    restoreTitle: boolean,
  ): Promise<void> {
    const updates: Partial<SpTask> = {};
    const marker = markerOf(a.assignmentId);
    if (!(task.notes || '').includes(marker)) {
      updates.notes = task.notes ? `${task.notes}\n\n${marker}` : marker;
    }
    // SP parses short syntax (#tag, @date, 1h) out of imported titles. Setting
    // the title together with another field (notes) skips that parsing.
    if (restoreTitle && task.title !== a.title) {
      updates.title = a.title;
      if (updates.notes === undefined) updates.notes = task.notes || '';
    }
    if (!task.deadlineWithTime && !task.deadlineDay && a.dueMs !== null) {
      Object.assign(updates, deadlineFields(a.dueMs, settings, task.isDone, this.now()));
    }
    if (Object.keys(updates).length) {
      await this.api.updateTask(task.id, updates as Partial<Task>);
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
  processNewTask(taskId: string, delayMs = 1500): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(() =>
      this.run(async () => {
        const settings = this.settings;
        const tasks = (await this.api.getTasks()) as SpTask[];
        const task = tasks.find((t) => t.id === taskId);
        if (!task || task.issueType !== ISSUE_TYPE || !task.issueId) return;
        const parsed = parseIssueId(task.issueId);
        const a = parsed && this.known.get(parsed.assignmentId);
        if (!a || !settings) {
          // No fresh data in this session (e.g. imported on another device):
          // the next poll's reconcile pass finishes the task.
          return;
        }
        // Already finished by a poll that ran first. Checked per task, not per
        // assignment: re-adding an assignment (after deleting its task, or
        // alongside an old-plugin task) is a new task that needs finishing.
        if ((task.notes || '').includes(markerOf(a.assignmentId))) return;
        const state = await this.load();
        await this.finish(task, a, state, settings, true);
        await this.save();
      }),
    );
  }

  /**
   * Applies fresh Canvas data to existing tasks. Only deadlines change, and
   * only when Canvas changed the due date (or the task never had one).
   * Returns notices for the user.
   */
  reconcile(fresh: Assignment[], settings: Settings): Promise<Notice[]> {
    this.settings = settings;
    this.remember(fresh);
    return this.run(async () => {
      const state = await this.load();
      const byId = new Map(fresh.map((a) => [a.assignmentId, a]));
      const tasks = (await this.api.getTasks()) as SpTask[];
      const moved: string[] = [];
      let linked = 0;
      let dirty = false;
      const now = this.now();
      const providerId = canvasProviderId(tasks);
      const linkedAids = new Set(
        tasks.filter((t) => t.issueType === ISSUE_TYPE).map((t) => assignmentIdOf(t)),
      );

      for (const task of tasks) {
        const aid = assignmentIdOf(task);
        const a = aid ? byId.get(aid) : undefined;
        if (!aid || !a) continue;

        const importedHere = task.issueType === ISSUE_TYPE;
        // Convert an unfinished old-plugin task into a Canvas-linked task, in
        // place: schedule, time tracked, notes and project are kept. Needs
        // the integration's id, learned from a task it imported.
        if (
          task.issueType !== ISSUE_TYPE &&
          !task.isDone &&
          !task.parentId &&
          providerId &&
          !linkedAids.has(aid)
        ) {
          const link: Partial<SpTask> = {
            issueId: a.issueId,
            issueType: ISSUE_TYPE,
            issueProviderId: providerId,
            issueWasUpdated: false,
            issueLastUpdated: a.updatedMs,
          };
          await this.api.updateTask(task.id, link as Partial<Task>);
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

        if (prev === undefined) {
          // First time this task is seen. An imported task whose hook didn't
          // run (app closed right after import, or imported on another
          // device) is finished now. An old-plugin task only gets a missing
          // deadline. A deadline the user set is left alone either way.
          if (importedHere) {
            await this.finish(task, a, state, settings, false);
          } else if (!hasDeadline && a.dueMs !== null) {
            await this.api.updateTask(
              task.id,
              deadlineFields(a.dueMs, settings, task.isDone, now) as Partial<Task>,
            );
          }
          state.lastDue[aid] = a.dueMs;
          dirty = true;
          continue;
        }

        if (prev !== a.dueMs) {
          // Canvas moved (or removed) the due date. Move the deadline with it,
          // keep the schedule. Done tasks get the new date but no reminder.
          await this.api.updateTask(
            task.id,
            deadlineFields(a.dueMs, settings, task.isDone, now) as Partial<Task>,
          );
          state.lastDue[aid] = a.dueMs;
          dirty = true;
          if (!task.isDone) moved.push(a.title);
        }
      }

      if (dirty) await this.save();
      const notices: Notice[] = [];
      if (linked) {
        notices.push({
          type: 'SUCCESS',
          msg: `Canvas: linked ${linked} unfinished task${linked === 1 ? '' : 's'} from the old Canvas plugin to this integration.`,
        });
      }
      if (moved.length) {
        const list =
          moved.slice(0, 3).join(', ') + (moved.length > 3 ? ` +${moved.length - 3} more` : '');
        notices.push({
          type: 'INFO',
          msg: `Canvas changed the due date of ${moved.length === 1 ? '' : `${moved.length} assignments: `}${list}. The deadline was updated; your schedule was not changed.`,
        });
      }
      return notices;
    });
  }
}
