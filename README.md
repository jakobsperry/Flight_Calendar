# Flight Calendar

The authenticated Cloudflare Worker is the live application: https://flight-calendar-test.jakob-flight-calendar.workers.dev/

Cloudflare D1 `flight-calendar-experiment` is the sole flight data source. Never store real itineraries, booking references, or passenger details in this public repository. GitHub Pages only links to the authenticated app. The existing Worker, D1 database, user accounts, and MCP endpoint remain unchanged.

The `main` branch is the canonical implementation. The existing Cloudflare resource names are retained for compatibility.
