# Canvas Assignments for Super Productivity

A Super Productivity plugin that imports your Canvas LMS assignments as tasks.
It replaces the old "Canvas Assignment Sync" plugin (`mumkyy/super-productivity-canvas`)
and keeps the tasks you already have.

- **No proxy.** The URL you enter is used as-is, `http://` or `https://`.
  Requests go through Super Productivity itself, so there is no CORS problem
  and no Node script.
- **Desktop and Android.** It uses SP's built-in integration system, the same
  one behind the GitHub, Jira and Gitea integrations.
- **Scheduled date and deadline are separate.** Each assignment is scheduled at
  its due time, and the due time is also set as the task's **deadline**.
  Reschedule the task to whenever you want to work on it and the deadline stays.
- **No sync timeouts.** Every Canvas request has its own timeout and retries
  with backoff on rate limits, server errors and slow responses. If one course
  fails, the others still import.

Requires **Super Productivity 19.3.1 or newer.**

## Install, or upgrade from the old plugin

1. Download `release/canvas-sync-2.0.2.zip`, or use the `dist/` folder.
2. In Super Productivity, open **Settings → Plugins** and upload the zip
   (or load the `dist/` folder).
3. **If you have the old Canvas plugin: don't remove it first.** Load this one
   over it. Both use the plugin ID `canvas-sync`, so it keeps the old plugin's
   saved data (your course → project mapping). Removing a plugin deletes its data.
   Your tasks are safe either way: tasks the old plugin made are recognised by
   the `[canvas-sync:<id>]` line in their notes and are never imported twice.
4. Add the integration. Pick a project for new assignments to land in (e.g.
   create one called *Canvas*). In that project's integration settings, or
   from the issue panel, add **Canvas** and fill in:
   - **Canvas URL**: e.g. `https://school.instructure.com`
   - **Access token**: Canvas → Account → Settings → Approved Integrations →
     *New Access Token*
   - **Courses**: press *Load*, then pick courses. Leave it empty to import
     every course currently in session.
   - Keep **Auto-import to backlog** on. That's what imports new assignments.

SP checks Canvas every 10 minutes and imports anything new. You can also search
assignments in the issue panel and add them by hand.

## What happens to your tasks

| Situation | What the plugin does |
| --- | --- |
| New assignment | Imported, scheduled at the due time, deadline = due time, moved into a project named after the course. |
| You reschedule a task | Nothing. Your schedule is never changed again; SP doesn't re-pull dates either. |
| Canvas changes a due date | The **deadline** moves and you get a notice. The schedule stays where you put it. |
| You complete a task | No deadline reminder fires. A due-date change later doesn't bring the reminder back. |
| You delete a task | It stays deleted. Find it with the issue-panel search to bring it back. |
| Task from the old plugin | Not re-imported. Gets a deadline if it has none. If it's **unfinished**, it's linked to the integration in place (Canvas details in the panel, refreshed like imported tasks) once the integration has imported at least one task. Schedule, project, notes and tracked time are kept. Finished ones are left as they are. |
| You set your own deadline | Left alone, until Canvas itself changes the due date. |
| You submit in Canvas | The task is not ticked off automatically. Done is up to you. |

## Options

| Option | Default | |
| --- | --- | --- |
| Courses | in-session courses | Pick specific courses, or leave empty. |
| Import assignments due within (days) | 60 | Assignments due further out are imported later. |
| Deadline reminder | None | At the due time, or 15 min / 1 h / 3 h / 1 day before. Never for finished tasks. |
| Also import past-due assignments | off | *Advanced.* |
| Also import assignments without a due date | off | *Advanced.* Added unscheduled. |
| Also import submitted assignments | off | *Advanced.* |
| Schedule on the due day instead of the exact time | off | *Advanced.* The deadline still keeps the exact time. |
| Keep tasks in this integration's project | off | *Advanced.* Turns off one project per course. |

## Good to know

- **Where data goes.** The token is sent only to the Canvas URL you entered. It
  is stored in the integration settings, like every other SP integration's
  token. The plugin's own saved data holds only course→project ids and due
  dates. The old plugin kept your token there; that copy is removed on first run.
- **Titles.** When SP imports a task it reads `#tag`, `@date` and `1h` out of
  the title. The plugin puts the exact Canvas title back right after import.
  If a title contained `#something`, SP may also have created that tag.
- **Several devices.** If two devices both have the app open with auto-import
  on, they can each import the same new assignment before SP syncs between
  them. That's general SP integration behaviour. If it happens, delete one copy.
- **Title updates.** When an assignment is edited in Canvas, SP updates the
  task title from Canvas on its next refresh.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Canvas rejected the access token (401)* | The token expired or was revoked. Make a new one. |
| *Canvas returned a web page instead of data* | The URL isn't your Canvas site. Use the address in your browser when you're on Canvas, without the path. |
| *Not found on Canvas (404)* | Check the URL. |
| *Canvas rate limit hit* | Nothing to do: it retries, and catches up on the next poll. |
| *Couldn't load &lt;course&gt;* | That course failed after retries. The others were imported. |

For details, open DevTools (Ctrl+Shift+I) and filter the console by `[Canvas]`.

## Development

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs typecheck, tests and the build. The build writes `dist/`
and `release/canvas-sync-<version>.zip`.

- `src/plugin.ts`: registers the Canvas integration with SP, and the hook that finishes imported tasks
- `src/canvas-api.ts`: Canvas client: retries, backoff, pagination, limited concurrency
- `src/assignments.ts`: Canvas data → assignments, import filters, SP issue/search shapes
- `src/task-sync.ts`: deadlines, project per course, migration from the old plugin
- `src/config.ts`: settings parsing and defaults
- `vendor/plugin-api/`: SP plugin API types from v19.3.1 (MIT, © Johannes Millan)
- `test/`: Node test runner tests, using fakes modelled on SP 19.3.1's behaviour
