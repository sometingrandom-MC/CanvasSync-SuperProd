import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Assignment } from '../src/assignments.ts';
import { toSettings } from '../src/config.ts';
import { deadlineFields, ISSUE_TYPE, parseState, TaskSync } from '../src/task-sync.ts';
import { makeApi } from './fakes.ts';

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 86_400_000;
const settings = toSettings({ host: 'x.edu', token: 't' });
const withReminder = toSettings({ host: 'x.edu', token: 't', deadlineReminder: '1h' });

const asg = (id: string, over: Partial<Assignment> = {}): Assignment => ({
  issueId: `10:${id}`,
  assignmentId: id,
  courseId: '10',
  courseName: 'Biology',
  title: `Lab ${id}`,
  dueMs: NOW + 2 * DAY,
  url: '',
  points: null,
  submitted: false,
  updatedMs: 0,
  description: '',
  ...over,
});

const OLD_BLOB = JSON.stringify({
  baseUrl: 'https://school.instructure.com',
  token: 'SECRET',
  courseProjects: { '10': 'bio' },
  syncedTasks: { '1': 'old1', '2': 'old2' },
  selectedCourseIds: ['10'],
});

test('old plugin data is migrated and its token dropped', async () => {
  const { state, migrated } = parseState(OLD_BLOB);
  assert.equal(migrated, true);
  assert.deepEqual(state.courseProjects, { '10': 'bio' });
  assert.deepEqual(state.imported, { '1': 1, '2': 1 });

  const fake = makeApi({ synced: OLD_BLOB });
  const sync = new TaskSync(fake.api as never, () => NOW);
  await sync.excludedAssignmentIds();
  assert.ok(fake.synced);
  assert.doesNotMatch(fake.synced!, /SECRET/);
  assert.equal(JSON.parse(fake.synced!).v, 2);
});

test('excluded ids include old marker tasks, active and archived', async () => {
  const fake = makeApi({
    tasks: [{ notes: 'my notes\n\n[canvas-sync:5]' }, { issueType: ISSUE_TYPE, issueId: '10:6' }],
    archived: [{ notes: '[canvas-sync:7]' }],
    synced: JSON.stringify({ v: 2, courseProjects: {}, lastDue: {}, imported: { '8': 1 } }),
  });
  const ids = await new TaskSync(fake.api as never).excludedAssignmentIds();
  assert.deepEqual([...ids].sort(), ['5', '6', '7', '8']);
});

test('deadline fields never arm a reminder for done tasks or past times', () => {
  const due = NOW + DAY;
  assert.deepEqual(deadlineFields(due, withReminder, false, NOW), {
    deadlineDay: null,
    deadlineWithTime: due,
    deadlineRemindAt: due - 3_600_000,
  });
  assert.equal(deadlineFields(due, withReminder, true, NOW).deadlineRemindAt, null);
  assert.equal(deadlineFields(NOW + 1000, withReminder, false, NOW).deadlineRemindAt, null);
  assert.equal(deadlineFields(due, settings, false, NOW).deadlineRemindAt, null);
  assert.deepEqual(deadlineFields(null, settings, false, NOW), {
    deadlineDay: null,
    deadlineWithTime: null,
    deadlineRemindAt: null,
  });
});

test('a newly imported task gets deadline, exact title, marker and course project', async () => {
  const a = asg('1', { title: 'Essay #2 @home 1h' });
  const fake = makeApi({ projects: [{ id: 'inbox', title: 'Inbox' }] });
  const task = fake.addTask({
    issueType: ISSUE_TYPE,
    issueId: a.issueId,
    // SP's short syntax parsed bits out of the title on import:
    title: 'Essay',
    dueWithTime: a.dueMs,
    projectId: 'inbox',
  });
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = withReminder;
  sync.remember([a]);
  await sync.processNewTask(task.id, 0);

  const t = fake.tasks.find((x) => x.id === task.id)!;
  assert.equal(t.title, 'Essay #2 @home 1h');
  assert.match(t.notes ?? '', /\[canvas-sync:1\]/);
  assert.equal(t.deadlineWithTime, a.dueMs);
  assert.equal(t.deadlineRemindAt, a.dueMs! - 3_600_000);
  assert.equal(t.dueWithTime, a.dueMs, 'schedule untouched');
  const bio = fake.projects.find((p) => p.title === 'Biology')!;
  assert.ok(bio);
  assert.equal(t.projectId, bio.id);

  // The title must never be the only changed field (SP would re-parse it).
  const titleUpdate = fake.updates.find((u) => 'title' in u.changes)!;
  assert.ok(Object.keys(titleUpdate.changes).length > 1);

  const state = JSON.parse(fake.synced!);
  assert.equal(state.imported['1'], 1);
  assert.equal(state.lastDue['1'], a.dueMs);
  assert.equal(state.courseProjects['10'], bio.id);
});

test('the exact title comes back after a #-safe import', async () => {
  const a = asg('1', { title: 'Homework #3' });
  const fake = makeApi();
  // SP created the task from the import title, which had "# 3".
  const task = fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: 'Homework # 3' });
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = settings;
  sync.remember([a]);
  await sync.processNewTask(task.id, 0);
  const update = fake.updates.find((u) => 'title' in u.changes)!;
  assert.equal(update.changes.title, 'Homework #3');
  assert.ok(Object.keys(update.changes).length > 1, 'not re-parsed by SP');
});

test('several imports from one new course create one project', async () => {
  const fake = makeApi();
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = settings;
  const list = ['1', '2', '3'].map((id) => asg(id));
  sync.remember(list);
  const tasks = list.map((a) => fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: a.title }));
  await Promise.all(tasks.map((t) => sync.processNewTask(t.id, 0)));
  assert.equal(fake.projects.filter((p) => p.title === 'Biology').length, 1);
  assert.ok(fake.tasks.every((t) => t.projectId !== 'inbox'));
});

test('an existing same-named project (old plugin) is reused', async () => {
  const fake = makeApi({ projects: [{ id: 'inbox', title: 'Inbox' }, { id: 'bio', title: 'Biology' }] });
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = settings;
  const a = asg('1');
  sync.remember([a]);
  const t = fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: a.title });
  await sync.processNewTask(t.id, 0);
  assert.equal(fake.tasks.find((x) => x.id === t.id)!.projectId, 'bio');
  assert.equal(fake.projects.length, 2);
});

test('keepInDefaultProject leaves the task where SP put it', async () => {
  const fake = makeApi();
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = toSettings({ host: 'x.edu', token: 't', keepInDefaultProject: true });
  const a = asg('1');
  sync.remember([a]);
  const t = fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: a.title });
  await sync.processNewTask(t.id, 0);
  assert.equal(fake.tasks.find((x) => x.id === t.id)!.projectId, 'inbox');
  assert.equal(fake.projects.length, 1);
});

test('other tasks are ignored by the hook', async () => {
  const fake = makeApi({ tasks: [{ title: 'Groceries' }] });
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = settings;
  await sync.processNewTask('t0', 0);
  assert.equal(fake.updates.length, 0);
});

test('old plugin tasks get a deadline on first sight; schedule and own deadlines untouched', async () => {
  const a1 = asg('1');
  const a2 = asg('2');
  const userDeadline = NOW + 5 * DAY;
  const fake = makeApi({
    tasks: [
      { notes: '[canvas-sync:1]', dueWithTime: NOW + 1 * DAY, projectId: 'bio' },
      { notes: '[canvas-sync:2]', deadlineWithTime: userDeadline },
    ],
    synced: OLD_BLOB,
  });
  const sync = new TaskSync(fake.api as never, () => NOW);
  const notices = await sync.reconcile([a1, a2], settings);
  assert.deepEqual(notices, []);
  assert.equal(fake.tasks[0].deadlineWithTime, a1.dueMs);
  assert.equal(fake.tasks[0].dueWithTime, NOW + 1 * DAY, 'rescheduled date kept');
  assert.equal(fake.tasks[0].projectId, 'bio', 'not moved');
  assert.equal(fake.tasks[1].deadlineWithTime, userDeadline, 'user deadline kept');
  assert.equal(fake.updates.length, 1);
});

test('a due date changed in Canvas moves the deadline, not the schedule', async () => {
  const oldDue = NOW + 2 * DAY;
  const newDue = NOW + 4 * DAY;
  const fake = makeApi({
    tasks: [
      {
        issueType: ISSUE_TYPE,
        issueId: '10:1',
        title: 'Lab 1',
        dueWithTime: NOW + DAY,
        deadlineWithTime: oldDue,
      },
      {
        issueType: ISSUE_TYPE,
        issueId: '10:2',
        title: 'Lab 2',
        isDone: true,
        deadlineWithTime: oldDue,
      },
      { issueType: ISSUE_TYPE, issueId: '10:3', title: 'Lab 3', deadlineWithTime: oldDue },
    ],
    synced: JSON.stringify({
      v: 2,
      courseProjects: {},
      lastDue: { '1': oldDue, '2': oldDue, '3': oldDue },
      imported: { '1': 1, '2': 1, '3': 1 },
    }),
  });
  const sync = new TaskSync(fake.api as never, () => NOW);
  const notices = await sync.reconcile(
    [asg('1', { dueMs: newDue }), asg('2', { dueMs: newDue }), asg('3', { dueMs: oldDue })],
    withReminder,
  );
  const [t1, t2, t3] = fake.tasks;
  assert.equal(t1.deadlineWithTime, newDue);
  assert.equal(t1.deadlineRemindAt, newDue - 3_600_000);
  assert.equal(t1.dueWithTime, NOW + DAY, 'schedule untouched');
  assert.equal(t2.deadlineWithTime, newDue);
  assert.equal(t2.deadlineRemindAt, null, 'done task: no reminder');
  assert.equal(t3.deadlineWithTime, oldDue);
  assert.equal(fake.updates.length, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0].msg, /Lab 1/);
  assert.doesNotMatch(notices[0].msg, /Lab 2/);
  assert.equal(JSON.parse(fake.synced!).lastDue['1'], newDue);

  // Running again with the same data changes nothing.
  const again = await sync.reconcile([asg('1', { dueMs: newDue })], withReminder);
  assert.deepEqual(again, []);
  assert.equal(fake.updates.length, 2);
});

test('an imported task whose hook never ran is finished by the next poll', async () => {
  const a = asg('9');
  const fake = makeApi({
    tasks: [{ issueType: ISSUE_TYPE, issueId: a.issueId, title: 'Renamed by me', projectId: 'inbox' }],
  });
  const sync = new TaskSync(fake.api as never, () => NOW);
  await sync.reconcile([a], settings);
  const t = fake.tasks[0];
  assert.equal(t.deadlineWithTime, a.dueMs);
  assert.match(t.notes ?? '', /\[canvas-sync:9\]/);
  assert.equal(t.title, 'Renamed by me', 'title only restored right after import');
  assert.equal(t.projectId, fake.projects.find((p) => p.title === 'Biology')!.id);

  // A late hook for the same task does nothing more.
  const before = fake.updates.length;
  sync.settings = settings;
  await sync.processNewTask(t.id, 0);
  assert.equal(fake.updates.length, before);
});

test('re-adding an assignment by hand is finished again', async () => {
  const a = asg('1');
  const fake = makeApi();
  const sync = new TaskSync(fake.api as never, () => NOW);
  sync.settings = settings;
  sync.remember([a]);
  const first = fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: a.title });
  await sync.processNewTask(first.id, 0);
  const bioId = fake.projects.find((p) => p.title === 'Biology')!.id;
  assert.equal(fake.tasks.find((t) => t.id === first.id)!.projectId, bioId);

  // Delete it, then add the same assignment again from the issue panel.
  fake.tasks.splice(fake.tasks.indexOf(fake.tasks.find((t) => t.id === first.id)!), 1);
  const again = fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: a.title });
  await sync.processNewTask(again.id, 0);
  const t = fake.tasks.find((x) => x.id === again.id)!;
  assert.equal(t.projectId, bioId);
  assert.equal(t.deadlineWithTime, a.dueMs);
  assert.match(t.notes ?? '', /\[canvas-sync:1\]/);
});

test('adding an assignment that also has an old-plugin task is finished', async () => {
  const a = asg('3');
  const fake = makeApi({ tasks: [{ notes: '[canvas-sync:3]', projectId: 'old' }] });
  const sync = new TaskSync(fake.api as never, () => NOW);
  await sync.reconcile([a], settings); // records the old task's due date
  const t = fake.addTask({ issueType: ISSUE_TYPE, issueId: a.issueId, title: a.title });
  await sync.processNewTask(t.id, 0);
  assert.equal(
    fake.tasks.find((x) => x.id === t.id)!.projectId,
    fake.projects.find((p) => p.title === 'Biology')!.id,
  );
});

test('unfinished old-plugin tasks are linked in place; finished ones are not', async () => {
  const sched = NOW + DAY;
  const fake = makeApi({
    tasks: [
      // A task the new integration imported tells us its provider id.
      { issueType: ISSUE_TYPE, issueId: '10:1', issueProviderId: 'prov1', notes: '[canvas-sync:1]' },
      // Old plugin, unfinished, rescheduled and moved by the user.
      { title: 'Lab 2', notes: 'my notes\n[canvas-sync:2]', dueWithTime: sched, projectId: 'mine', timeSpent: 600000 },
      // Old plugin, finished.
      { title: 'Lab 3', notes: '[canvas-sync:3]', isDone: true, projectId: 'mine' },
      // Old plugin, but its assignment already has a linked task.
      { title: 'Lab 1 (old)', notes: '[canvas-sync:1]', projectId: 'mine' },
    ],
  });
  const sync = new TaskSync(fake.api as never, () => NOW);
  const notices = await sync.reconcile(
    [asg('1'), asg('2', { updatedMs: 1234 }), asg('3')],
    settings,
  );
  const [, t2, t3, t4] = fake.tasks;
  assert.equal(t2.issueType, ISSUE_TYPE);
  assert.equal(t2.issueId, '10:2');
  assert.equal(t2.issueProviderId, 'prov1');
  assert.equal(t2.issueLastUpdated, 1234);
  assert.equal(t2.issueWasUpdated, false);
  assert.equal(t2.dueWithTime, sched, 'schedule kept');
  assert.equal(t2.projectId, 'mine', 'not moved');
  assert.equal(t2.timeSpent, 600000);
  assert.equal(t2.title, 'Lab 2');
  assert.equal(t2.deadlineWithTime, asg('2').dueMs);
  assert.equal(t3.issueType, undefined, 'finished task left alone');
  assert.equal(t4.issueType, undefined, 'no second linked task per assignment');
  assert.ok(notices.some((n) => /linked 1 unfinished task/.test(n.msg)));

  // Second pass: nothing more to link.
  const again = await sync.reconcile([asg('1'), asg('2', { updatedMs: 1234 }), asg('3')], settings);
  assert.ok(!again.some((n) => /linked/.test(n.msg)));
});

test('old tasks wait until the integration has imported something', async () => {
  const fake = makeApi({ tasks: [{ notes: '[canvas-sync:2]' }] });
  await new TaskSync(fake.api as never, () => NOW).reconcile([asg('2')], settings);
  assert.equal(fake.tasks[0].issueType, undefined);
});

test('a removed due date clears the deadline', async () => {
  const fake = makeApi({
    tasks: [{ issueType: ISSUE_TYPE, issueId: '10:1', deadlineWithTime: NOW + DAY }],
    synced: JSON.stringify({ v: 2, courseProjects: {}, lastDue: { '1': NOW + DAY }, imported: {} }),
  });
  await new TaskSync(fake.api as never, () => NOW).reconcile([asg('1', { dueMs: null })], settings);
  assert.equal(fake.tasks[0].deadlineWithTime, null);
  assert.equal(fake.tasks[0].deadlineDay, null);
});
