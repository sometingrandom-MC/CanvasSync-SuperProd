# Canvas Assignments for Super Productivity

Brings your Canvas assignments into Super Productivity as tasks. Each assignment
is scheduled at its due time, has the due date set as its deadline, and goes into
a project named after its course. Works on desktop and Android.

Requires Super Productivity 19.3.1 or newer.

## Setup

1. Download the latest zip from the [`release`](release) folder.
2. In Super Productivity, go to **Settings → Plugins** and upload the zip.
3. Get a Canvas access token: in Canvas, go to **Account → Settings →
   Approved Integrations → New Access Token**, then copy the token.
4. In Super Productivity, open the project you want new assignments to arrive
   in and add the **Canvas** integration. Fill in:
   - **Canvas URL**: the address of your Canvas site, e.g. `https://school.instructure.com`
   - **Access token**: the token from step 3
   - **Courses**: press **Load**, then pick your courses (or leave it empty for
     all current courses)
5. Open **Advanced Config** and set:
   - **Default Super Productivity Project**: the project from step 4
   - **Auto import to default project**: on
   - **Polling trigger**: Always (in background)
6. Save. Within a few seconds you should see "Canvas: Imported N new Assignments".

## How it works

- **Checking for new work:** Canvas is checked when the app starts and every
  10 minutes after that while the app is open.
- **New assignments:** added as tasks scheduled at the due time, with the due
  date as the task's deadline, and moved into a project named after the course.
- **Rescheduling:** move a task to whenever you plan to work on it. The deadline
  stays on the due date.
- **Due date changes:** if a due date changes in Canvas, the task's deadline is
  updated and you get a notice. Your schedule isn't touched.
- **Completing tasks:** finishing a task is up to you; submitting in Canvas
  doesn't tick it off. Finished tasks never get deadline reminders.
- **Deleting tasks:** a deleted task won't come back. To get it back, search for
  it in the Canvas panel and add it again.
- **Adding by hand:** type in the Canvas panel's search box to find any
  assignment, including past or submitted ones, and add it.

By default, only assignments that aren't submitted yet and are due within the
next 60 days are imported. You can change this under **Advanced Config**,
along with an optional deadline reminder.

## Troubleshooting

- **Nothing shows in the Canvas panel:** type something in the search box; the
  panel only lists search results.
- **Nothing gets imported:** check the three settings in step 5. If they're
  set, you may simply have no unsubmitted assignments due in the next 60 days.
- **"Canvas rejected the access token":** the token expired. Create a new one.
- **"Canvas returned a web page instead of data":** the Canvas URL is wrong. Use
  the address shown in your browser on Canvas, without anything after the domain.
