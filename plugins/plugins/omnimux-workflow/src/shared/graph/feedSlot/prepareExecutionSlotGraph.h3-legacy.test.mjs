import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildModelCatalog } from '../../../../../omnimux/src/catalog/list.js';
import { findExecutionReadinessFailure } from '../../validation/executionReadiness.ts';
import { prepareExecutionSlotGraph } from './prepareExecutionSlotGraph.ts';
import { createMaterialGatewayExecutor } from '../../../workflow/execution/materialGatewayExecutor.ts';
import { readNodeInputSource } from '../nodeInputSource.ts';

const snapshot = JSON.parse(readFileSync(new URL('../../../../../omnimux/src/catalog/cloud/bundled/pricing.json', import.meta.url), 'utf8'));
const historical = buildModelCatalog({ snapshot, gatewayContracts: false, env: {} });
const current = buildModelCatalog({ snapshot, env: {} });
const modelId = 'minimax-h3-video';
const operationId = 'digital_human';
const h3Inputs = (catalog) => catalog.models.find(model => model.id === modelId)
  .operations.find(operation => operation.id === operationId).inputs;

function savedGraph(versioned) {
  const importNode = (id, materialType, extension) => ({
    id, type: 'material', data: {
      nodeKind: 'import', materialType, mediaUrl: `https://fixture.example/${id}.${extension}`,
      mimeType: `${materialType}/${extension}`, sizeBytes: 64,
    },
  });
  const sources = [
    importNode('unused-image', 'image', 'png'), importNode('unused-audio', 'audio', 'wav'),
    importNode('portrait', 'image', 'png'), importNode('voice', 'audio', 'wav'),
  ];
  const historicalInputs = h3Inputs(historical);
  assert.deepEqual(historicalInputs.map(input => [input.slot, input.role]),
    [['character', 'first_frame'], ['driving_audio', 'audio_track']]);
  const bindings = Object.fromEntries(historicalInputs.map(input => {
    const source = sources.find(node => !node.id.startsWith('unused-') && node.data.materialType === input.type);
    return [input.slot, [{ edgeId: `edge-${source.id}`, sourceNodeId: source.id, outputId: `saved-${source.id}`,
      role: input.role, pinned: true, use: 'active', ordinal: 0 }]];
  }));
  const target = {
    id: 'h3', type: 'material',
    data: {
      nodeKind: 'generate', materialType: 'video', prompt: '',
      params: { model: modelId, operation: operationId },
      ...(versioned ? { inputBindingVersion: 1, slotBindings: bindings } : {}),
    },
  };
  const edges = sources.map(source => {
    const media = historicalInputs.find(input => input.type === source.data.materialType);
    return {
      id: `edge-${source.id}`, source: source.id, target: 'h3', targetHandle: 'in',
      data: source.id.startsWith('unused-') ? {} : versioned
        ? { slotBinding: { slot: media.slot, role: media.role, mirror: true } }
        : { targetSlot: media.slot, role: media.role },
    };
  });
  // The pre-overlay catalog and saved graph use their actual historical shapes.
  return JSON.parse(JSON.stringify({ nodes: [...sources, target], edges }));
}

for (const versioned of [true, false]) {
  test(`saved H3 ${versioned ? 'versioned bindings' : 'legacy edge hints'} run against the current catalog without editing the graph`, async (t) => {
    const saved = savedGraph(versioned);
    const before = structuredClone(saved);
    const oldGraph = prepareExecutionSlotGraph(saved.nodes, saved.edges, historical);
    assert.equal(findExecutionReadinessFailure([oldGraph.nodes.at(-1)], historical, oldGraph), null);

    const graph = prepareExecutionSlotGraph(saved.nodes, saved.edges, current);
    const target = graph.nodes.at(-1);
    assert.equal(findExecutionReadinessFailure([target], current, graph), null);
    assert.equal(target.data.params.operation, operationId);
    if (versioned) {
      assert.deepEqual(target.data.slotBindings.reference_image, [{ ...saved.nodes.at(-1).data.slotBindings.character[0], role: 'reference' }]);
      assert.deepEqual(target.data.slotBindings.reference_audio, [{ ...saved.nodes.at(-1).data.slotBindings.driving_audio[0], role: 'reference' }]);
    }
    const requests = [];
    const unexpectedFetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected HTTP in the saved graph fixture'); });
    const executor = createMaterialGatewayExecutor({ gateway: {
      capabilities: async () => current,
      submit: async (request) => { requests.push(request); return { taskId: 'fixture-h3' }; },
      awaitTask: async () => ({ type: 'video', url: 'https://fixture.example/result.mp4' }),
    } });
    await executor.execute(target, {
      upstreamBindings: graph.edges.map(edge => ({
        edgeId: edge.id, sourceNodeId: edge.source,
        output: readNodeInputSource(graph.nodes.find(node => node.id === edge.source)).output,
      })),
      upstreamOutputs: new Map(), mediaDir: '/tmp', signal: new AbortController().signal,
    });
    assert.deepEqual(requests[0].references.map(({ edgeId, sourceNodeId, targetSlot }) => [edgeId, sourceNodeId, targetSlot]),
      [['edge-portrait', 'portrait', 'reference_image'], ['edge-voice', 'voice', 'reference_audio']]);
    assert.equal(unexpectedFetch.mock.callCount(), 0);
    assert.deepEqual(graph.edges.map(({ id, source, target }) => [id, source, target]),
      saved.edges.map(({ id, source, target }) => [id, source, target]));
    assert.deepEqual(saved, before);
  });
}

test('H3 compatibility does not rebind inactive, intentionally empty, or unrelated saved intent', () => {
  const saved = savedGraph(true);
  const data = saved.nodes.at(-1).data;
  data.slotBindings.character[0].use = 'inactive';
  data.slotBindings.reference_audio = [];
  data.slotBindings.custom_portrait = [{ edgeId: 'edge-unused-image', sourceNodeId: 'unused-image', use: 'inactive', pinned: true }];
  const before = structuredClone(saved);
  const graph = prepareExecutionSlotGraph(saved.nodes, saved.edges, current);
  const target = graph.nodes.at(-1);
  assert.deepEqual(target.data.slotBindings.reference_image, [{ ...data.slotBindings.character[0], role: 'reference' }]);
  for (const slot of ['reference_audio', 'driving_audio', 'custom_portrait']) {
    assert.deepEqual(target.data.slotBindings[slot], data.slotBindings[slot]);
  }
  assert.notEqual(findExecutionReadinessFailure([target], current, graph), null);
  assert.deepEqual(saved, before);
});

test('legacy H3 binding with a mismatched edge and source stays blocked', () => {
  const saved = savedGraph(true);
  saved.edges.find(edge => edge.id === 'edge-portrait').source = 'unused-image';
  const before = structuredClone(saved);
  const graph = prepareExecutionSlotGraph(saved.nodes, saved.edges, current);
  const target = graph.nodes.at(-1);
  assert.equal(target.data.slotBindings.reference_image[0].sourceNodeId, 'portrait');
  assert.equal(findExecutionReadinessFailure([target], current, graph)?.reasonCode, 'input_unavailable');
  assert.deepEqual(saved, before);
});
