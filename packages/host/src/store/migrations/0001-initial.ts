/**
 * Migration 0001 — the initial schema.
 *
 * Verbatim from `docs/design/architecture.md` §4: all 11 tables
 * (`devices`, `links`, `services`, `sightings`, `sessions`,
 * `board_owner`, `relay_leases`, `firmware`, `settings`, `tasks`,
 * `changes`) and their three indexes (`devices_name`, `links_device`,
 * `sightings_device_at`). Column names, types, primary keys, and
 * defaults must match that document exactly — ticket 003's typed
 * operations and every downstream watcher assume these exact shapes.
 *
 * This module exports only the SQL text; applying it (and recording the
 * resulting `PRAGMA user_version`) is `db.ts`'s job.
 */
export const MIGRATION_0001_INITIAL = `
CREATE TABLE devices (
  id            INTEGER PRIMARY KEY,   -- FICR.DEVICEID[1], decoded
  name          TEXT NOT NULL,         -- deviceIdToName(id); CHECK shape zvgpt/uoiea
  kind          TEXT NOT NULL,         -- 'robot' | 'relay'
  role          TEXT,                  -- banner role token (NEZHA2, RADIOBRIDGE, …)
  program       TEXT, version TEXT,    -- from the ID reply; 'calibration' is derived
  usb_serial    TEXT,                  -- KL27 interface-chip serial; display hint only
  radio_channel INTEGER, radio_group INTEGER,
  radio_source  TEXT,                  -- 'override' | 'registry' | NULL (derived default)
  owned         INTEGER NOT NULL DEFAULT 0, -- 1 once identified over USB on this host
  first_seen    INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX devices_name ON devices(name);

CREATE TABLE links (
  id            TEXT PRIMARY KEY,      -- opaque; never parsed by the UI
  device_id     INTEGER REFERENCES devices(id),   -- NULL until identified
  transport     TEXT NOT NULL,         -- 'usb' | 'wifi' | 'radio' | 'mbrelay' | 'mbserial'
  address       TEXT NOT NULL,         -- JSON: {path,hidPath} | {host,port} | {relayLinkId,channel,group} | …
  state         TEXT NOT NULL,         -- see §5
  state_reason  TEXT,
  state_since   INTEGER NOT NULL,
  last_seen     INTEGER,               -- last time the watcher saw the underlying thing
  next_retry_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  user_closed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX links_device ON links(device_id);

CREATE TABLE services (                -- raw mDNS observations, one per instance+type
  instance      TEXT NOT NULL, type TEXT NOT NULL,
  host TEXT, port INTEGER, txt TEXT,   -- txt as JSON
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (instance, type)
);

CREATE TABLE sightings (               -- every probe result, any transport
  id INTEGER PRIMARY KEY,
  device_id INTEGER, name TEXT,        -- name kept even when device_id unknown
  transport TEXT NOT NULL, via_link_id TEXT,
  at INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT
);
CREATE INDEX sightings_device_at ON sightings(device_id, at);

CREATE TABLE sessions (                -- one per open link
  link_id TEXT PRIMARY KEY REFERENCES links(id),
  opened_at INTEGER NOT NULL,
  seq INTEGER, pending INTEGER, last_done INTEGER, last_done_reason TEXT,
  robot_status TEXT, functions TEXT    -- JSON
);

CREATE TABLE board_owner (             -- exclusivity for one physical USB board
  usb_serial TEXT PRIMARY KEY,
  owner TEXT NOT NULL,                 -- 'naming' | 'session:<linkId>' | 'flash' | 'sweep'
  since INTEGER NOT NULL
);

CREATE TABLE relay_leases (
  relay_link_id TEXT PRIMARY KEY REFERENCES links(id),
  owner TEXT NOT NULL,                 -- 'sweep' | 'session:<childLinkId>'
  since INTEGER NOT NULL
);

CREATE TABLE firmware (
  kind TEXT PRIMARY KEY,               -- 'relay' | 'robot' | 'joystick'
  repo TEXT, tag TEXT, available INTEGER, reason TEXT, message TEXT,
  etag TEXT, checked_at INTEGER
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);   -- firmware sources, wifi creds, state dir
CREATE TABLE tasks (name TEXT PRIMARY KEY, state TEXT, heartbeat_at INTEGER, detail TEXT);
CREATE TABLE changes (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, key TEXT, at INTEGER NOT NULL);
`;
