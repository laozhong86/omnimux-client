import { canonicalJson } from '../../shared/validation/compatKernel.ts';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { localFilePathFromUrl } from '../../shared/localMedia.ts';

/** Compare persisted intent without catalog lookup or opening source files. */
export function executionInputSignatures(input: {
  nodes: Array<{ id: string; type?: string; data?: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string }>;
}, selected?: ReadonlySet<string>): Record<string, string> {
  const intentData = (data: Record<string, unknown> = {}) => {
    const { executionStatus, executionError, taskId, status, probeStatus, isMissing, fileMissing,
      fileCorrupted, isOffline, ...intent } = data;
    return intent;
  };
  return Object.fromEntries(input.nodes.filter(node => !selected || selected.has(node.id)).map(node => [node.id, createHash('sha256').update(canonicalJson({
    type: node.type, data: intentData(node.data),
    incoming: input.edges.filter(edge => edge.target === node.id).map(edge => ({
      edge,
      source: input.nodes.filter(source => source.id === edge.source).map(source => ({
        id: source.id, type: source.type, data: intentData(source.data),
      })),
    })),
  })).digest('hex')]));
}

/** Existing local bytes supplement graph identity; unavailable files do not invent replacement bytes. */
export function executionSourceIdentities(input: { nodes: Array<{ id: string; data?: Record<string, unknown> }>; edges: Array<{ source: string; target: string }> }, selected?: ReadonlySet<string>): Record<string, Record<string, string>> {
  const digests = new Map<string, string | undefined>();
  const sourceIdentities = (value: unknown, field = '', identities: Record<string, string> = {}): Record<string, string> => {
    if (typeof value === 'string') {
      const path = localFilePathFromUrl(value) || ((field === 'path' || field === 'url') && isAbsolute(value) ? value : null);
      if (path) {
        if (!digests.has(path)) {
          let digest: string | undefined;
          try {
            if (statSync(path).isFile()) digest = createHash('sha256').update(readFileSync(path)).digest('hex');
          } catch {
            // A missing file can still belong to an already accepted task.
          }
          digests.set(path, digest);
        }
        const digest = digests.get(path);
        if (digest) identities[path] = digest;
      }
    } else if (Array.isArray(value)) value.forEach(item => sourceIdentities(item, field, identities));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => sourceIdentities(item, key, identities));
    return identities;
  };
  return Object.fromEntries(input.nodes.filter(node => !selected || selected.has(node.id)).map(node => [node.id, sourceIdentities({
    own: node.data,
    sources: input.edges.filter(edge => edge.target === node.id).flatMap(edge => input.nodes.filter(source => source.id === edge.source).map(source => source.data)),
  })]));
}
