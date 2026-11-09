-- 002_pcf_json_storage.sql
-- PCF conversion: documents move from one HTML file per drawing to the
-- authoritative JSON file (data/pcf/<projectId>/<drawingId>.json).
--
-- Schema initialization alone never applies this file. The startup/offline
-- converter invokes it only after backing up and verifying every JSON file.
-- Fresh JSON-only databases may stay at user_version 1; mixed version-2
-- directories can rerun this index step safely.
-- The converter then sets PRAGMA user_version = 2.
-- Re-running it is harmless: only .html pointers are rewritten.

UPDATE pcf_index
SET file_path = substr(file_path, 1, length(file_path) - 5) || '.json'
WHERE file_path LIKE '%.html';
