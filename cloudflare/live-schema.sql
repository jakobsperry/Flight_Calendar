CREATE TABLE IF NOT EXISTS flight_api_requests (
 id TEXT PRIMARY KEY,
 cache_key TEXT NOT NULL,
 attempted_at INTEGER NOT NULL,
 units INTEGER NOT NULL CHECK(units=2)
);
CREATE INDEX IF NOT EXISTS flight_api_requests_time ON flight_api_requests(attempted_at);
CREATE INDEX IF NOT EXISTS flight_api_requests_key ON flight_api_requests(cache_key,attempted_at);
CREATE TRIGGER IF NOT EXISTS flight_api_budget BEFORE INSERT ON flight_api_requests
BEGIN
 SELECT CASE WHEN NEW.units + COALESCE((SELECT SUM(units) FROM flight_api_requests WHERE attempted_at > NEW.attempted_at - 2678400000),0) > 400 THEN RAISE(ABORT,'flight_api_budget_exhausted') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM flight_api_requests WHERE cache_key=NEW.cache_key AND attempted_at > NEW.attempted_at - 3600000) THEN RAISE(ABORT,'flight_api_cooldown') END;
END;
CREATE TABLE IF NOT EXISTS flight_api_cache (
 cache_key TEXT PRIMARY KEY,
 attempted_at INTEGER NOT NULL,
 fetched_at INTEGER,
 flights_json TEXT,
 error TEXT
);
CREATE TABLE IF NOT EXISTS flight_api_scheduler (
 id INTEGER PRIMARY KEY CHECK(id=1),
 checked_at INTEGER NOT NULL,
 state TEXT NOT NULL
);
