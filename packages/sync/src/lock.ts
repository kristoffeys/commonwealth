// The cross-process sync lock now lives in @cmnwlth/core so both the sync engine and the
// curate consolidation pass can share it (#29). Re-exported here for existing importers.
export { acquireSyncLock } from "@cmnwlth/core";
