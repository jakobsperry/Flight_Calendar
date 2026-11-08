# Accounts and sharing experiment

This branch is an isolated design experiment. The public viewer on `main` is unchanged.

## Desired behavior

- Register using a unique username and password; no email address or email verification.
- Stay signed in on a trusted iPhone across browser restarts.
- Each user owns one or more calendars.
- Calendar owners can grant **view-only** access to another registered username and revoke it.
- Only the owner can edit flight data. Sharing does not automatically send Google Calendar invitations.
- Users can sign out and invalidate all active sessions.

## Implementation architecture

**Frontend:** existing calendar UI, plus login/register and calendar selector.

**Backend:** Cloudflare Worker (or equivalent server runtime), deployed separately from GitHub Pages.

**Database:** Cloudflare D1 (SQLite) or equivalent managed database. Tables:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL
);
CREATE TABLE calendar_access (
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('viewer')),
  PRIMARY KEY(calendar_id,user_id)
);
CREATE TABLE flights (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  date TEXT NOT NULL,
  flight_json TEXT NOT NULL
);
```

**Authentication:** Passwords must be salted and hashed server-side using Argon2id or a sufficiently configured PBKDF2/scrypt implementation; never store plaintext passwords. Create a cryptographically random opaque session token. Store only its hash in the database and send the token in an `HttpOnly; Secure; SameSite=Lax` cookie. Use a 30-day rolling session expiration with server-side revocation. Rate-limit registration and login attempts. Restrict cross-origin access to the deployed frontend origin, and use CSRF protection for state-changing requests.

**API proposal:**
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /calendars`
- `GET /calendars/:id/flights` (requires ownership or access grant)
- `POST /calendars/:id/shares` (owner only; username and viewer role)
- `DELETE /calendars/:id/shares/:userId` (owner only)
- `PUT /calendars/:id/flights` (owner only)

## Security and deployment constraints

**Do not publish private flight data in `flights.json` on a public GitHub Pages deployment.** Even if the UI shows a login form, publicly served JSON remains accessible to anyone. Migrate the data to the authenticated backend before enabling private sharing.

No email verification means no email-based password recovery. Recovery must be an explicit owner/admin process or use one-time recovery codes generated during registration. Usernames alone must not be treated as proof of identity.

This is a plan, **not a working authentication system**. Before testing with real passwords, deploy and audit the backend, database migrations, session handling, and authorization checks.

## Rollout

1. Provision backend and D1 database.
2. Implement authentication, secure sessions, and per-calendar authorization.
3. Migrate existing flight data out of public GitHub Pages JSON.
4. Implement login and calendar-sharing UI on this branch.
5. Test account persistence, unauthorized access, revoked sharing, and logout.
6. Deploy to a separate staging URL. Merge only after approval.
