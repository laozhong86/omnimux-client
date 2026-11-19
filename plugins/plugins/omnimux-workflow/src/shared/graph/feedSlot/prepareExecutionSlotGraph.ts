import type { CapabilityCatalog } from '../../api.ts';
import { buildContractView, readExplicitTargetSlot, resolveModelView, type ContractOperationView } from '../../validation/compatKernel.ts';
import { buildInputCapability } from '../../validation/inputCapability.ts';
import { readNodeInputSource } from '../nodeInputSource.ts';
import { resolveNodeKind } from '../materialNode.ts';
import { materialTools } from '../../specs/nodes/materialNodeSpec.ts';
import { deriveSlotLayout } from './deriveSlotLayout.ts';
import { readPreferredOperationId } from '../../validation/operationUi.ts';
import { effectiveInputDisplay } from './effectiveInputDisplay.ts';
import type { LegacySlotEdge } from './hydrateSlotBindings.ts';
import type { FeedAsset, SlotBindings, SlotConflict, SlotOccupant } from './types.ts';
import { buildCanvasUpstreamFingerprint } from '../canvasInputSources.ts';
import type { CanvasNode } from '../canvasInputMutationGateway.ts';
import type { Edge } from '@xyflow/react';
import { resolveSlotOperation } from './resolveSlotOperation.ts';
import { normalizeVideoParamsForSchema } from '../../../canvas/editor/components/MaterialNode/ConfigPanel/videoParams/videoParamNormalization.ts';

const H3_SLOT_RENAMES = [
  { from: 'character', fromRole: 'first_frame', to: 'reference_image', type: 'image' },
  { from: 'driving_audio', fromRole: 'audio_track', to: 'reference_audio', type: 'audio' },
] as const;

/** Project the pre-gateway H3 slot names onto a cloned execution graph. */
function projectSavedH3Slots(data: Record<string, unknown>, incoming: LegacySlotEdge[], operation: ContractOperationView): void {
  const bindings = data.slotBindings as SlotBindings | undefined;
  for (const { from, fromRole, to, type } of H3_SLOT_RENAMES) {
    if (operation.inputs.some(input => input.slot === from)) continue;
    const target = operation.inputs.find(input => input.slot === to && input.type === type && input.role === 'reference'
      && input.source === 'upstream_edge' && input.min === 1 && input.max === 1);
    if (!target) continue;
    const savedOccupants = bindings?.[from];
    if (bindings && Array.isArray(savedOccupants) && !Object.hasOwn(bindings, to)) {
      const projectRole = (occupant: SlotOccupant) => occupant.role === fromRole ? { ...occupant, role: target.role } : occupant;
      bindings[to] = savedOccupants.map(projectRole);
      delete bindings[from];
      const conflicts = data.slotConflicts as SlotConflict[] | undefined;
      if (Array.isArray(conflicts)) {
        data.slotConflicts = conflicts.map(conflict => conflict.slot === from
          ? { ...conflict, slot: to, occupant: projectRole(conflict.occupant) }
          : conflict);
      }
    }
    for (const edge of incoming) {
      const metadata = edge.data ?? {};
      if (readExplicitTargetSlot(metadata, edge.targetHandle) !== from) continue;
      const binding = metadata.slotBinding as { role?: string; mirror?: boolean } | undefined;
      const role = typeof metadata.role === 'string' ? metadata.role : binding?.mirror === true ? undefined : binding?.role;
      edge.data = { ...metadata, targetSlot: to, ...(role === fromRole ? { role: target.role } : {}) };
    }
  }
}

/** Freeze legacy hydration for dispatch without modifying the persisted graph or topology. */
export function prepareExecutionSlotGraph<
  N extends { id: string; type?: string; data?: Record<string, unknown> },
  E extends LegacySlotEdge & { target: string },
>(nodes: N[], edges: E[], catalog: CapabilityCatalog | null | undefined): { nodes: N[]; edges: E[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const view = buildContractView(catalog);
  const ordinalByTarget = new Map<string, number>();
  const nextEdges = edges.map((edge) => {
    const ordinal = ordinalByTarget.get(edge.target) ?? 0;
    ordinalByTarget.set(edge.target, ordinal + 1);
    return { ...structuredClone(edge), id: edge.id ?? `feed-${edge.source}-${ordinal}`,
      data: { ...structuredClone(edge.data), feedType: readNodeInputSource(byId.get(edge.source) ?? { id: edge.source }).materialType } };
  }) as E[];
  const nextNodes = nodes.map((node) => {
    if (node.type !== 'material' || resolveNodeKind(node.data ?? {}) !== 'generate') return structuredClone(node);
    const capabilityId = typeof node.data?.outputCapabilityId === 'string'
      ? node.data.outputCapabilityId.trim()
      : '';
    if (capabilityId && materialTools[capabilityId]?.executorKey) return structuredClone(node);
    const data = structuredClone(node.data ?? {});
    let params = (data.params ?? {}) as Record<string, unknown>;
    const kind = (data.materialType ?? 'text') as keyof NonNullable<CapabilityCatalog['defaults']>;
    const autoOperationId = typeof data.autoOperationId === 'string' || data.autoOperationId === null
      ? data.autoOperationId as string | null
      : undefined;
    const model = resolveModelView(view, (params.model ?? catalog?.defaults?.[kind]) as string | undefined);
    if (kind === 'video' && catalog?.source === 'omnimux' && typeof params.model === 'string' && model?.id === 'minimax-h3-video'
      && params.operation === 'digital_human') {
      const operation = model.operations.find(candidate => candidate.id === params.operation && candidate.listed && candidate.output.type === kind);
      if (operation) projectSavedH3Slots(data, nextEdges.filter(edge => edge.target === node.id), operation);
    }
    params.model ??= model?.id;
    const fingerprint = buildCanvasUpstreamFingerprint(node.id, nodes as unknown as CanvasNode[], nextEdges as unknown as Edge[]);
    if (kind === 'video') {
      // R9: inputCapability decides the operation from the connected media;
      // #55 below only normalizes the values against that operation schema.
      const preferredOperationId = readPreferredOperationId(params, autoOperationId);
      const capability = buildInputCapability({
        catalog,
        modelId: model?.id,
        outputType: 'video',
        fingerprint,
        ...(preferredOperationId ? { preferredOperationId } : {}),
        autoOperationId,
        params,
        ignoredEdgeIds: (data.slotStandbyEdgeIds ?? []) as string[],
      });
      if (capability.selectedOperationId) params.operation = capability.selectedOperationId;
      if (capability.paramsProjection) params = capability.paramsProjection.params;
    } else {
      params.operation ??= resolveSlotOperation(catalog, model?.id, params.operation, kind, fingerprint);
    }
    if (kind === 'video' && catalog?.source === 'omnimux') {
      // The gateway catalog is the execution contract. A model row without
      // model-level parameters can still carry operation-level constraints;
      // skipping normalization here would dispatch a value the read side
      // already normalized. Offline static stubs keep their historical shape.
      const normalized = normalizeVideoParamsForSchema({
        params,
        operationId: typeof params.operation === 'string' ? params.operation : undefined,
        catalog,
      });
      params = normalized.params;
    }
    data.params = params;
    // Current bindings are explicit intent; preparation is not a migration or picker.
    if (data.inputBindingVersion === 1) return { ...node, data } as N;
    if (kind === 'audio' && params.operation === 'text_to_speech') {
      data.slotBindings = {};
      data.slotConflicts = [];
    }
    {
      const incoming = nextEdges.filter((edge) => edge.target === node.id);
      const feed: FeedAsset[] = incoming.flatMap((edge, ordinal) => {
        const source = readNodeInputSource(byId.get(edge.source) ?? { id: edge.source });
        if (!['image', 'video', 'audio'].includes(source.materialType)) return [];
        return [{ edgeId: edge.id ?? `feed-${edge.source}-${ordinal}`, sourceNodeId: edge.source, ordinal,
          type: source.materialType, outputId: source.outputId, availability: source.availability,
          url: source.output.mediaAssets?.[0]?.url, ...source.metadata }];
      });
      const layout = deriveSlotLayout(catalog, model?.id, params.operation as string | undefined);
      const fill = effectiveInputDisplay(layout, feed, data.slotBindings as SlotBindings | undefined,
        (data.slotConflicts ?? []) as SlotConflict[], incoming, (data.slotStandbyEdgeIds ?? []) as string[]);
      data.slotBindings = fill.bindings;
      data.slotConflicts = fill.conflicts;
    }
    return { ...node, data } as N;
  });
  return { nodes: nextNodes, edges: nextEdges };
}
