# Experimental live flight status

Applies only to `experiment/accounts-sharing`, Worker `flight-calendar-test`, and D1 `flight-calendar-experiment` (`73eef509-5263-42a3-a3a4-8a798c550e51`). Do not deploy these files to production.

## Operation

- Cron `*/5 * * * *` checks for flights within six hours before departure. Each flight number plus local departure date can make one provider request per 60 minutes. The first refresh can occur up to five minutes after the six-hour threshold.
- Every eligible flight is considered, including subsequent connections. Duplicate entries across calendars share one request and D1 cache. Known airports use IANA time zones, including daylight saving. Explicit UTC offsets are respected; unknown or ambiguous zones are skipped.
- Refresh continues until AeroDataBox reports Arrived/Canceled/Cancelled/Diverted, or 24 hours after scheduled departure. Departures remain based on the saved itinerary, so a revised departure cannot keep moving the refresh window.
- The authenticated manual lookup uses the same budget, cooldown, and cache. Read endpoints and the browser's one-minute visible-page polling only read D1; they never call AeroDataBox.
- D1 stores provider status, revised departure/arrival times, gates, terminals, baggage belt and fetch/attempt timestamps separately from the user's itinerary and private booking details. The UI shows the provider status and timestamps beside the saved schedule. Failed refreshes preserve the last good result with a stale indicator. Provider cache data expires after seven days.

## Budget

The single-day Flight Status endpoint is Tier 2, accounted at **2 units per request**, with `withFlightPlan=false`, aircraft images and position extras disabled. See the [official specification](https://doc.aerodatabox.com/docs/openapi-rapidapi-v1.json) and [provider pricing](https://aerodatabox.com/pricing). Confirm the applicable RapidAPI subscription terms before enabling a key.

An atomic D1 INSERT trigger rejects reservations that would exceed **400 units in any rolling 31 days**. This is deliberately stricter than a calendar-month cap and also protects a billing month that starts mid-month. At most 200 requests fit in that window. Failed calls, no matches, timeouts and crashes retain their reservation. No retry bypass or automatic paid fallback exists. Concurrent requests cannot overspend or bypass the per-flight cooldown. Database failures prevent provider calls. Never delete the request ledger to reset the quota.

This ledger controls this experimental app's calls only; it cannot account for other apps using the same provider subscription. Use a dedicated key/subscription and provider-side hard quota for a subscription-wide guarantee. Unknown prior usage must be accounted before sharing an existing subscription.

## Deployment and configuration

1. Apply `live-schema.sql` only to the experimental D1 database. It adds tables, indexes and an insert trigger; it does not change existing flight records.
2. Upload both `worker.js` (entry module) and `live.js`, preserving the current DB binding, compatibility date (`2026-11-01`) and all existing secret bindings.
3. Set the test Worker's cron to `*/5 * * * *` using the Cloudflare schedules API or dashboard. Cron propagation can take several minutes.
4. Add **`AERODATABOX_KEY`** as an encrypted secret on **`flight-calendar-test`** through Cloudflare's dashboard. It must be a RapidAPI key subscribed to AeroDataBox. Never put a key into GitHub, plaintext Worker variables, chat, or a command argument. No email importing is implemented.
5. `/api/health` reports database/hash readiness and `liveStatus` including `configured`, budget and last scheduler check. `configured` means a secret exists, not that the provider accepted it; authorization errors are reported separately.

At implementation time, the test Worker had **no secrets**, no AeroDataBox key was present in the current execution environment, and no live provider call could be verified. Missing-key mode consumes zero units and is clearly displayed in the calendar.

## Validation

Run `node cloudflare/test-live.cjs` with a Node version supporting `node:sqlite`. Tests use in-memory SQLite and a fake provider; they never spend API units. They cover concurrency at the budget boundary, hourly cache and deduplication, 31-day/month boundaries, time zones/DST, six-hour activation, subsequent flights, terminal cutoffs, provider failures, stale persisted data, retention, missing keys and database fail-closed behavior.

No production Worker, branch or database should be changed as part of this feature.
