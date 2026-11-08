-- 002_pcf_json_storage.sql
-- Offline migration: PCF documents move from one HTML file per drawing to the
-- authoritative JSON file (data/pcf/<projectId>/<drawingId>.json).
--
-- The Hub never applies this file at startup. A fresh database stays at
-- user_version 1 and JSON storage already works; existing databases are
-- upgraded only by the explicit conversion script after it has:
--   1. stopped the Hub and backed up data/;
--   2. written and verified every .json document and history snapshot;
--   3. rewritten pcf_index.file_path below.
-- The script then runs this file and sets PRAGMA user_version = 2.
-- Re-running it is harmless: only .html pointers are rewritten.

UPDATE pcf_index
SET file_path = substr(file_path, 1, length(file_path) - 5) || '.json'
WHERE file_path LIKE '%.html';
