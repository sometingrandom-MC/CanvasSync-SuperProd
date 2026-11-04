// Loads the real plugin entry against a fake SP + fake Canvas and drives it the
// way SP does: backlog poll -> import -> taskCreated hook -> refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSleep } from '../src/canvas-api.ts';
import { ISSUE_TYPE } from '../src/task-sync.ts';
import { FakeHttp, HttpError, makeApi, paged } from './fakes.ts';

setSleep(async () => {});

const DAY = 86_400_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const fake = makeApi({
  projects: [{ id: 'canvas', title: 'Canvas' }],
  tasks: [{ title: 'Old import', notes: '[canvas-sync:3]', dueWithTime: now + DAY, projectId: 'bio-old' }],
});
(globalThis as Record<string, unknown>).PluginAPI = fake.api;
await import('../src/plugin.ts');
const provider = fake.provider!;

const config = { host: 'school.instructure.com', token: 'tok' };

const courses = [
  { id: 10, name: 'Biology', term: { start_at: iso(now - 30 * DAY), end_at: iso(now + 60 * DAY) } },
  { id: 11, name: 'Chemistry', term: { start_at: iso(now - 30 * DAY), end_at: iso(now + 60 * DAY) } },
  { id: 12, name: 'Last Year', end_at: iso(now - 200 * DAY) },
];
const bio = [
  { id: 1, name: 'Lab 1', due_at: iso(now + 2 * DAY), submission: { workflow_state: 'unsubmitted' } },
  { id: 2, name: 'Lab 2', due_at: iso(now + 3 * DAY), submission: { workflow_state: 'submitted' } },
  { id: 3, name: 'Lab 3', due_at: iso(now + 4 * DAY) },
  { id: 4, name: 'Final', due_at: iso(now + 90 * DAY) },
  { id: 5, name: 'Reading', due_at: null },
];

const canvas = () =>
  new FakeHttp()
    .on(/\/api\/v1\/courses$/, paged(courses))
    .on(/\/courses\/10\/assignments$/, paged(bio))
    .on(/\/courses\/11\/assignments$/, () => new HttpError(500))
    .on(/\/courses\/10\/assignments\/1$/, () => bio[0])
    .on(/\/users\/self$/, () => ({ id: 1 }));

test('headers carry the bearer token', () => {
  assert.deepEqual(provider.getHeaders(config), { Authorization: 'Bearer tok' });
  assert.deepEqual(provider.getHeaders({}), {});
});

test('connection test and course picker', async () => {
  assert.equal(await provider.testConnection(config, canvas()), true);
  assert.equal(
    await provider.testConnection(config, new FakeHttp().on(/self/, () => new HttpError(401))),
    false,
  );
  const field = provider.configFields.find((f: { key: string }) => f.key === 'courseIds');
  const options = await field.loadOptions(config, canvas());
  assert.deepEqual(
    options.map((o: { label: string }) => o.label),
    ['Biology', 'Chemistry', 'Last Year (not in session)'],
  );
});

test('backlog poll: filters, skips old-plugin tasks, survives a failing course', async () => {
  const http = canvas();
  const results = await provider.getNewIssuesForBacklog(config, http);
  assert.deepEqual(
    results.map((r: { id: string }) => r.id),
    ['10:1'],
  );
  assert.equal(results[0].title, 'Lab 1');
  assert.equal(results[0].dueWithTime, new Date(bio[0].due_at!).getTime());
  // The out-of-session course is never requested.
  assert.ok(!http.requests.some((r) => r.includes('/courses/12/')));
  assert.ok(fake.snacks.some((s) => /Chemistry/.test(s.msg) && s.type === 'WARNING'));
  // The old plugin's task got its deadline without being moved or rescheduled.
  const old = fake.tasks[0];
  assert.equal(old.deadlineWithTime, new Date(bio[2].due_at!).getTime());
  assert.equal(old.projectId, 'bio-old');
  assert.equal(old.dueWithTime, now + DAY);
});

test('SP import + taskCreated hook finishes the task', async () => {
  const due = new Date(bio[0].due_at!).getTime();
  // What SP's addTaskFromIssue creates for the result above.
  const task = fake.addTask({
    title: 'Lab 1',
    issueType: ISSUE_TYPE,
    issueId: '10:1',
    issueProviderId: 'prov1',
    dueWithTime: due,
    projectId: 'canvas',
  });
  fake.hooks['taskCreated']({ taskId: task.id, task });
  await new Promise((r) => setTimeout(r, 1700));

  const t = fake.tasks.find((x) => x.id === task.id)!;
  assert.equal(t.deadlineWithTime, due);
  assert.equal(t.dueWithTime, due);
  assert.match(t.notes ?? '', /\[canvas-sync:1\]/);
  const bioProject = fake.projects.find((p) => p.title === 'Biology')!;
  assert.equal(t.projectId, bioProject.id);

  // Next poll: nothing new to import (already imported).
  const again = await provider.getNewIssuesForBacklog(config, canvas());
  assert.deepEqual(again, []);
});

test('deleted tasks are not re-imported', async () => {
  fake.tasks.splice(
    fake.tasks.findIndex((t) => t.issueId === '10:1'),
    1,
  );
  const results = await provider.getNewIssuesForBacklog(config, canvas());
  assert.deepEqual(results, []);
});

test('refresh: one request per course, issue fields for the panel', async () => {
  const http = canvas();
  const issues = await provider.getByIds(['10:1', '10:3'], config, http);
  assert.deepEqual(
    issues.map((i: { id: string }) => i.id).sort(),
    ['10:1', '10:3'],
  );
  assert.equal(http.requests.filter((r) => r.includes('/assignments')).length, 1);
  const one = await provider.getById('10:1', config, canvas());
  assert.equal(one.courseName, 'Biology');
  assert.equal(one.state, 'open');
  assert.equal(
    provider.getIssueLink('10:1', config),
    'https://school.instructure.com/courses/10/assignments/1',
  );
});

test('search finds assignments by title or course', async () => {
  const res = await provider.searchIssues('lab 2', config, canvas());
  assert.deepEqual(
    res.map((r: { id: string }) => r.id),
    ['10:2'],
  );
  const byCourse = await provider.searchIssues('biology', config, canvas());
  assert.equal(byCourse.length, 5);
});

test('a wrong token shows one clear message and imports nothing', async () => {
  fake.snacks.length = 0;
  const bad = new FakeHttp().on(/.*/, () => new HttpError(401));
  assert.deepEqual(await provider.getNewIssuesForBacklog(config, bad), []);
  assert.deepEqual(await provider.getNewIssuesForBacklog(config, bad), []);
  const msgs = fake.snacks.filter((s) => /token/.test(s.msg));
  assert.equal(msgs.length, 1, 'repeated polls do not spam');
});
