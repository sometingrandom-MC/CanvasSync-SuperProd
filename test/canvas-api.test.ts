import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, describeError, isRetryable, mapLimit, setSleep } from '../src/canvas-api.ts';
import { normaliseBaseUrl, toSettings } from '../src/config.ts';
import { FakeHttp, HttpError, paged } from './fakes.ts';

const sleeps: number[] = [];
setSleep(async (ms) => {
  sleeps.push(ms);
});

const settings = toSettings({ host: 'https://school.instructure.com', token: 'tok' });

test('normaliseBaseUrl accepts bare hosts, full URLs and pasted page URLs', () => {
  assert.equal(normaliseBaseUrl('school.instructure.com'), 'https://school.instructure.com');
  assert.equal(normaliseBaseUrl(' https://canvas.uni.edu/ '), 'https://canvas.uni.edu');
  assert.equal(normaliseBaseUrl('https://canvas.uni.edu/courses/12/assignments'), 'https://canvas.uni.edu');
  assert.equal(normaliseBaseUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.throws(() => normaliseBaseUrl(''), /not configured/);
});

test('toSettings applies defaults for untouched fields', () => {
  const s = toSettings({ host: 'x.edu', token: ' t ' });
  assert.equal(s.token, 't');
  assert.equal(s.daysAhead, 60);
  assert.deepEqual(s.courseIds, []);
  assert.equal(s.projectPerCourse, true);
  assert.equal(s.scheduleWholeDay, false);
  assert.equal(s.reminderOffsetMs, null);
  assert.equal(toSettings({ host: 'x.edu', token: 't', deadlineReminder: '1h' }).reminderOffsetMs, 3_600_000);
  assert.deepEqual(toSettings({ host: 'x.edu', token: 't', courseIds: '7' }).courseIds, ['7']);
  assert.throws(() => toSettings({ host: 'x.edu' }), /token/);
});

test('getAll follows numbered pages until a short page', async () => {
  const items = Array.from({ length: 230 }, (_, i) => ({ id: i + 1 }));
  const http = new FakeHttp().on(/\/courses$/, paged(items));
  const out = await new CanvasClient(http, settings).getActiveCourses();
  assert.equal(out.length, 230);
  assert.equal(http.requests.length, 3);
  assert.match(http.requests[0], /^\/api\/v1\/courses\?/);
  assert.match(http.requests[0], /per_page=100/);
  assert.match(http.requests[0], /include%5B%5D=term/);
  assert.match(http.requests[0], /enrollment_state=active/);
});

test('getAll stops when an endpoint ignores the page parameter', async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const http = new FakeHttp().on(/\/courses$/, () => page);
  const out = await new CanvasClient(http, settings).getActiveCourses();
  assert.equal(out.length, 100);
  assert.equal(http.requests.length, 2);
});

test('retries timeouts, 5xx and rate limits with backoff, then succeeds', async () => {
  sleeps.length = 0;
  const errors: unknown[] = [
    Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' }),
    new HttpError(403, '{"errors":[{"message":"403 Forbidden (Rate Limit Exceeded)"}]}'),
  ];
  const http = new FakeHttp().on(/\/users\/self$/, () => errors.shift() ?? { id: 1 });
  const me = await new CanvasClient(http, settings).getSelf();
  assert.deepEqual(me, { id: 1 });
  assert.equal(http.requests.length, 3);
  assert.deepEqual(sleeps, [1000, 8000]);
});

test('does not retry a rejected token', async () => {
  const http = new FakeHttp().on(/\/users\/self$/, () => new HttpError(401));
  await assert.rejects(new CanvasClient(http, settings).getSelf(), (e: unknown) => {
    assert.match(describeError(e), /token/);
    return true;
  });
  assert.equal(http.requests.length, 1);
});

test('gives up after three attempts', async () => {
  const http = new FakeHttp().on(/\/users\/self$/, () => new HttpError(503));
  await assert.rejects(new CanvasClient(http, settings).getSelf());
  assert.equal(http.requests.length, 3);
});

test('an HTML page instead of JSON is reported as a wrong URL', async () => {
  const http = new FakeHttp().on(/\/users\/self$/, () => '<html>Log in</html>');
  await assert.rejects(new CanvasClient(http, settings).getSelf(), (e: unknown) => {
    assert.match(describeError(e), /web page/);
    return true;
  });
  assert.equal(http.requests.length, 1);
  assert.match(describeError(new HttpError(200, 'parse error')), /web page/);
});

test('isRetryable classifies errors', () => {
  assert.equal(isRetryable(new HttpError(429)), true);
  assert.equal(isRetryable(new HttpError(502)), true);
  assert.equal(isRetryable(new HttpError(0)), true);
  assert.equal(isRetryable(new HttpError(403, 'Forbidden')), false);
  assert.equal(isRetryable(new HttpError(404)), false);
  assert.equal(isRetryable(new Error('network down')), true);
});

test('mapLimit keeps order and caps concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 - (n % 3)));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(peak, 3);
});
