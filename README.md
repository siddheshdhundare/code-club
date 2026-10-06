# CodeBomb — Round 3 Website

An existing Express/JSON-backed coding competition website with separate SY/C++ and TY/Java challenges, real Judge0 execution, student security signals, and admin monitoring.

## Setup

1. Install Node.js 18 or newer.
2. In this project folder, run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set private `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` values in `.env`.
5. Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `.env`. The publishable key is used by a server-side client; never put a Supabase secret/service-role key in the project.
6. Configure `JUDGE0_URL` for a working Judge0 instance. If required by that instance, set `JUDGE0_AUTH_TOKEN` and/or `JUDGE0_AUTH_USER`. These credentials are used only by the backend.
7. Run `npm start`.
8. Open the student website at `http://localhost:3000` and the Admin Panel at `http://localhost:3000/admin`.

`GET /api/health/supabase` checks read access to the required Supabase tables without returning table data. Student and competition records are still stored in `data/db.json`; moving them into Supabase requires matching table columns and restrictive Row Level Security policies.

## Create and run a competition

1. Sign in to the Admin Panel.
2. Create a competition and select its year: **SY** (C++) or **TY** (Java). Each competition has its own ID, code, problem, participants, results, and timer. It is saved as **NOT_STARTED** without starting its timer.
3. Select the competition and click **Generate Code**. Its unique five-digit code does not activate it; status remains NOT_STARTED.
4. Select that year-specific competition in **Manage Problems**. Add its problem statement, input/output formats, constraints, sample input/output, and at least one hidden test. Add more hidden tests with **Add Test Case**.
5. Click that competition's **START COMPETITION** only after its problem and code are ready. The server stores `startTime` and `endTime = startTime + duration`. Starting SY does not affect TY; active problems are locked.
6. Give participants the code for their year. A student entering a NOT_STARTED code is told it has not started. After joining, the year is fixed by that competition; the backend rejects a mismatched year. SY receives only its SY problem/C++ tests, and TY only its TY problem/Java tests.
7. Each competition's timer is based on its persisted `endTime` and continues across refreshes and server restarts. The server independently marks each competition ENDED at expiry; an admin can end either competition early without affecting the other.

To change a problem, select its **NOT_STARTED** competition, edit its assigned year's fields, and use **Update Problem**. Problem edits lock once started. Ended competitions cannot be restarted; create a new year-specific competition for another round. **Clear / Reset Fields** clears only the editor after confirmation. The year-specific **Clear Problem** action removes that competition's single problem after confirmation.

## Judging and data

Submissions go to the server, which chooses the language and year from the authenticated student session. Judge0 compiles and executes the code against that competition's server-side hidden tests. The server compares actual stdout to expected output after normalizing CRLF line endings and trimming leading/trailing whitespace; it does not inspect the algorithm or source-code pattern. Judge0 compilation, runtime, time-limit, and memory-limit statuses are retained. Student responses contain result summaries, not hidden inputs or expected outputs; authorized admin details include the full per-test information.

Competitions, problems, participants, submissions, and violations are persisted in the existing `data/db.json` store. Submissions are appended to the history rather than replacing earlier records. Browser focus, visibility, copy/cut, context-menu, and developer-shortcut events are logged as monitoring signals, not definitive proof of cheating. The Admin Panel refreshes monitoring data automatically and supports competition, year, language, and result filtering.

## Production notes

- Do not use example credentials for a real event; use HTTPS in production.
- Keep Judge0 credentials and any optional Groq credentials out of frontend files. Groq is not used to determine correctness.
- JSON storage is suitable for a single local server; use a transactional database if deploying multiple server instances or handling significant concurrent write volume.
- Use a reliable Judge0 instance and review its resource limits and availability before the event.
