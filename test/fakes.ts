// In-memory stand-ins for Super Productivity's HTTP helper and PluginAPI,
// modelled on how SP v19.3.1 behaves for the calls this plugin makes.

import type { PluginHttp, PluginHttpOptions } from '../vendor/plugin-api/index.ts';
import type { SpTask } from '../src/task-sync.ts';

type Handler = (url: URL) => unknown;

export class HttpError extends Error {
  status: number;
  error: unknown;
  constructor(status: number, error: unknown = '') {
    super(`Http failure response: ${status}`);
    this.status = status;
    this.error = error;
  }
}

/** Fake `PluginHttp`: routes by path, records every request. */
export class FakeHttp implements PluginHttp {
  routes: Array<[RegExp, Handler]> = [];
  requests: string[] = [];

  on(pathRe: RegExp, handler: Handler): this {
    this.routes.push([pathRe, handler]);
    return this;
  }

  async get<T>(url: string, options?: PluginHttpOptions): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(options?.params ?? {})) u.searchParams.set(k, v);
    this.requests.push(u.pathname + u.search);
    for (const [re, handler] of this.routes) {
      if (re.test(u.pathname)) {
        const res = handler(u);
        if (res instanceof Error) throw res;
        return res as T;
      }
    }
    throw new HttpError(404, 'not found');
  }
  post<T>(): Promise<T> {
    throw new Error('not used');
  }
  put<T>(): Promise<T> {
    throw new Error('not used');
  }
  patch<T>(): Promise<T> {
    throw new Error('not used');
  }
  delete<T>(): Promise<T> {
    throw new Error('not used');
  }
  request<T>(): Promise<T> {
    throw new Error('not used');
  }
}

/** Serves a list endpoint with numbered pages like Canvas does. */
export const paged =
  <T>(items: T[]) =>
  (u: URL): T[] => {
    const per = Number(u.searchParams.get('per_page') || 10);
    const page = Number(u.searchParams.get('page') || 1);
    return items.slice((page - 1) * per, page * per);
  };

export interface FakeProject {
  id: string;
  title: string;
  isArchived?: boolean;
}

/** Fake PluginAPI holding tasks, projects and synced data in memory. */
export const makeApi = (init: {
  tasks?: Partial<SpTask>[];
  archived?: Partial<SpTask>[];
  projects?: FakeProject[];
  synced?: string | null;
} = {}) => {
  const base = (): SpTask =>
    ({
      id: '',
      title: 'Task',
      notes: '',
      timeEstimate: 0,
      timeSpent: 0,
      isDone: false,
      projectId: 'inbox',
      tagIds: [],
      created: 0,
      subTaskIds: [],
    }) as SpTask;
  const tasks: SpTask[] = (init.tasks ?? []).map((t, i) => ({ ...base(), id: `t${i}`, ...t }));
  const archived = (init.archived ?? []) as SpTask[];
  const projects: FakeProject[] = init.projects ?? [{ id: 'inbox', title: 'Inbox' }];
  const updates: Array<{ id: string; changes: Record<string, unknown> }> = [];
  const snacks: Array<{ msg: string; type?: string }> = [];
  const hooks: Record<string, (p: unknown) => void> = {};
  let synced: string | null = init.synced ?? null;
  let projectSeq = 0;
  let provider: Record<string, any> | null = null;

  const api = {
    Hooks: { TASK_CREATED: 'taskCreated' },
    log: { err: () => {}, log: () => {}, info: () => {}, warn: () => {}, debug: () => {}, critical: () => {}, normal: () => {}, verbose: () => {} },
    async getTasks() {
      return tasks.map((t) => ({ ...t }));
    },
    async getArchivedTasks() {
      return archived.map((t) => ({ ...t }));
    },
    async getAllProjects() {
      // Simulate the bridge's async hop so races would show up.
      await new Promise((r) => setTimeout(r, 1));
      return projects.map((p) => ({ ...p }));
    },
    async addProject(p: { title: string }) {
      await new Promise((r) => setTimeout(r, 1));
      const id = `p${++projectSeq}`;
      projects.push({ id, title: p.title });
      return id;
    },
    async updateTask(id: string, changes: Record<string, unknown>) {
      updates.push({ id, changes });
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error(`Task ${id} not found`);
      Object.assign(t, changes);
    },
    async loadSyncedData() {
      return synced;
    },
    async persistDataSynced(s: string) {
      synced = s;
    },
    showSnack(s: { msg: string; type?: string }) {
      snacks.push(s);
    },
    registerIssueProvider(def: Record<string, any>) {
      provider = def;
    },
    registerHook(name: string, fn: (p: unknown) => void) {
      hooks[name] = fn;
    },
  };

  return {
    api,
    tasks,
    projects,
    updates,
    snacks,
    hooks,
    get synced() {
      return synced;
    },
    get provider() {
      return provider;
    },
    addTask(t: Partial<SpTask>) {
      const task = { ...base(), id: `n${tasks.length}`, ...t } as SpTask;
      tasks.push(task);
      return task;
    },
  };
};
