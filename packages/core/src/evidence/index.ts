export { SOURCE_FAMILY, REGISTRY_SOURCE_TYPES } from './families';
export { makeSnippet } from './snippet';
export { normaliseValue } from './normalise-value';
export { DEFAULT_SELECTION_POLICY, selectBest, type SelectionPolicy } from './select';
export {
  DbEvidenceStore,
  MemoryEvidenceStore,
  type EvidenceDraft,
  type EvidenceRow,
  type EvidenceStore,
} from './store';
export { corroborate, resolveOwnerConflicts, REGISTRY_CONFLICT_REASON } from './corroborate';
