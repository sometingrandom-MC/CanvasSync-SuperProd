import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Assignment,
  htmlToText,
  withoutTagSyntax,
  isInSession,
  isSubmitted,
  parseIssueId,
  selectCourses,
  skipReason,
  toAssignment,
  toIssue,
  toSearchResult,
} from '../src/assignments.ts';
import { toSettings } from '../src/config.ts';

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 86_400_000;
const settings = toSettings({ host: 'school.instructure.com', token: 't' });

const a = (over: Partial<Assignment> = {}): Assignment => ({
  issueId: '10:1',
  assignmentId: '1',
  courseId: '10',
  courseName: 'Biology',
  title: 'Lab 1',
  dueMs: NOW + 2 * DAY,
  url: 'https://school.instructure.com/courses/10/assignments/1',
  points: 10,
  submitted: false,
  updatedMs: 0,
  description: '',
  ...over,
});

test('issue ids carry course and assignment', () => {
  assert.deepEqual(parseIssueId('10:123'), { courseId: '10', assignmentId: '123' });
  assert.equal(parseIssueId('123'), null);
  assert.equal(parseIssueId('a:b'), null);
});

test('skipReason applies the import filters', () => {
  assert.equal(skipReason(a(), settings, NOW), null);
  assert.equal(skipReason(a({ submitted: true }), settings, NOW), 'submitted');
  assert.equal(skipReason(a({ dueMs: null }), settings, NOW), 'undated');
  assert.equal(skipReason(a({ dueMs: NOW - DAY }), settings, NOW), 'overdue');
  assert.equal(skipReason(a({ dueMs: NOW + 61 * DAY }), settings, NOW), 'tooFar');
  const loose = toSettings({
    host: 'x.edu',
    token: 't',
    includeSubmitted: true,
    includeUndated: true,
    includeOverdue: true,
    daysAhead: '90',
  });
  assert.equal(skipReason(a({ submitted: true }), loose, NOW), null);
  assert.equal(skipReason(a({ dueMs: null }), loose, NOW), null);
  assert.equal(skipReason(a({ dueMs: NOW - DAY }), loose, NOW), null);
  assert.equal(skipReason(a({ dueMs: NOW + 61 * DAY }), loose, NOW), null);
});

test('submission states', () => {
  assert.equal(isSubmitted(null), false);
  assert.equal(isSubmitted({ workflow_state: 'unsubmitted' }), false);
  assert.equal(isSubmitted({ workflow_state: 'graded' }), true);
  assert.equal(isSubmitted({ submitted_at: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isSubmitted({ excused: true }), true);
});

test('course selection: picked courses, else everything in session', () => {
  const courses = [
    { id: 1, name: 'Now', term: { start_at: '2026-08-01T00:00:00Z', end_at: '2026-12-20T00:00:00Z' } },
    { id: 2, name: 'Old', end_at: '2026-05-01T00:00:00Z' },
    { id: 3, name: 'Next', start_at: '2027-01-10T00:00:00Z' },
    { id: 4, name: 'No dates' },
    { id: 5, access_restricted_by_date: true },
  ];
  assert.deepEqual(
    selectCourses(courses, settings, NOW).map((c) => c.id),
    [1, 4],
  );
  const picked = toSettings({ host: 'x.edu', token: 't', courseIds: ['2', '3'] });
  assert.deepEqual(
    selectCourses(courses, picked, NOW).map((c) => c.id),
    [2, 3],
  );
  assert.equal(isInSession(courses[0], NOW), true);
  assert.equal(isInSession(courses[1], NOW), false);
});

test('Canvas assignment -> import result, exact time or whole day', () => {
  const raw = {
    id: 77,
    name: ' Essay #2 ',
    due_at: '2026-11-07T04:59:00Z',
    html_url: 'https://school.instructure.com/courses/10/assignments/77',
    points_possible: 20,
    updated_at: '2026-11-01T00:00:00Z',
    description: '<p>Read <a href="https://x.org/a">chapter 2</a> &amp; write.</p><ul><li>One</li></ul>',
    submission: { workflow_state: 'unsubmitted' },
  };
  const asg = toAssignment(raw, '10', 'English', 'https://school.instructure.com');
  assert.equal(asg.issueId, '10:77');
  assert.equal(asg.title, 'Essay #2');
  assert.equal(asg.dueMs, Date.UTC(2026, 10, 7, 4, 59));

  const exact = toSearchResult(asg, settings);
  assert.equal(exact.id, '10:77');
  assert.equal(exact.title, 'Essay # 2', 'SP sees no #tag on import');
  assert.equal(exact.dueWithTime, asg.dueMs);
  assert.equal(exact.start, undefined);

  const whole = toSearchResult(asg, toSettings({ host: 'x.edu', token: 't', scheduleWholeDay: true }));
  assert.equal(whole.dueWithTime, undefined);
  assert.equal(whole.start, asg.dueMs);

  const undated = toSearchResult({ ...asg, dueMs: null }, settings);
  assert.equal(undated.dueWithTime, undefined);
  assert.equal(undated.start, undefined);

  const issue = toIssue(asg);
  assert.equal(issue.title, 'Essay #2', 'refreshes keep the real title');
  assert.equal(issue.state, 'open');
  assert.equal(issue.lastUpdated, Date.UTC(2026, 10, 1));
  assert.equal(issue.pointsText, '20 pts');
  assert.equal(issue.body, 'Read [chapter 2](https://x.org/a) & write.\n\n- One');
});

test('htmlToText drops scripts and keeps structure', () => {
  assert.equal(htmlToText('<script>x()</script><p>a<br>b</p>'), 'a\nb');
  assert.equal(htmlToText(null), '');
});

test('titles handed to SP for import contain no tag syntax', () => {
  assert.equal(withoutTagSyntax('Homework #3'), 'Homework # 3');
  assert.equal(withoutTagSyntax('#01 Intro, Quiz #2b'), '# 01 Intro, Quiz # 2b');
  assert.equal(withoutTagSyntax('C# basics'), 'C# basics');
  assert.equal(withoutTagSyntax('Lab#4'), 'Lab#4', 'SP ignores # inside a word');
  assert.equal(withoutTagSyntax('Essay # 2'), 'Essay # 2');
});
