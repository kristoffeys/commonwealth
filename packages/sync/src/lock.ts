// The cross-process sync lock now lives in @commonwealth/core so both the sync engine and the
// curate consolidation pass can share it (#29). Re-exported here for existing importers.
export { acquireSyncLock } from "@commonwealth/core";
