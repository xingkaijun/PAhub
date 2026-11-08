// PCF document constants and validation. Table definitions live in the numbered
// migrations (hub-server/sql/migrations/001_schema.sql); this module no longer
// creates schema.
export { validateJSON } from './pcf-v26.ts';
export const PCF_SCHEMA_VERSION = '1.0';
export const PCF_APP_VERSION = '2.6';
