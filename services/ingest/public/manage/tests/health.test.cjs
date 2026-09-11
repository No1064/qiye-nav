const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness() {
  const findings = [
    { id: 'missing', kind: 'missing_metadata', items: [{ itemId: 'i1', groupId: 'g1', url: 'https://example.com' }] },
    { id: 'empty', kind: 'empty_group', groupId: 'g1' },
    { id: 'other', kind: 'broken', itemId: 'i2', groupId: 'g2' }
  ];
  const state = { healthJob: { findings }, catalog: { groups: [{ id: "g1", items: [{ id: "i1", title: "Example", url: "https://example.com" }] }] }, healthActions: new Map(), healthDraftActions: new Map() };
  const context = vm.createContext({ state, URL, elements: { healthIssueFilter: { value: '' }, healthGroupFilter: { value: 'g1' }, healthDomainFilter: { value: '' }, healthStatusFilter: { value: '' }, healthApplyPreview: {} }, showToastMessage() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../health.js'), 'utf8'), context);
  context.renderHealthFindings = () => {};
  return { context, state };
}
test('select all includes rows without recommendations and respects current filters', () => {
  const { context, state } = harness();
  context.selectFilteredHealthFindings();
  assert.deepEqual([...state.healthActions.keys()], ['missing']);
  assert.equal(state.healthActions.get('missing').action, '');
  assert.equal(state.healthActions.has('empty'), false);
});
test('metadata payload resolves item refs and never falls back to deletion', () => {
  const { context } = harness();
  assert.equal(context.healthActionPayload({ findingId: 'missing', action: '' }), null);
  assert.equal(context.healthActionPayload({ findingId: 'missing', action: 'fill_metadata' }), null);
  const payload = context.healthActionPayload({ findingId: 'missing', action: 'fill_metadata', metadata: { description: 'Example' } });
  assert.equal(payload, null);
});
test('explicit skip persists through select all; recommendations do not select destructive rows', () => {
  const { context, state } = harness();
  state.healthDraftActions.set('missing', { action: '' });
  context.selectFilteredHealthFindings();
  assert.equal(state.healthActions.get('missing').action, '');
  state.healthActions.clear();
  context.recommendFilteredHealthFindings();
  assert.deepEqual([...state.healthActions.keys()], []);
});

test('persisted applied metadata is excluded from repeated bulk repair and restore reopens it', () => {
  const { context, state } = harness();
  const item = { id: 'i1', url: 'https://example.com', description: 'Filled' };
  state.catalog.groups = [{ id: 'g1', items: [item] }];
  state.healthJob.changeSets = [{ operations: [{ actionId: 'missing', type: 'fill_metadata', itemId: 'i1', after: item }] }];
  assert.ok(context.healthAppliedOperation(state.healthJob.findings[0]));
  context.selectFilteredHealthFindings();
  assert.equal(state.healthActions.has('missing'), false);
  assert.equal(context.healthActionPayload({ findingId: 'missing', action: 'fill_metadata', metadata: { description: 'Filled' } }), null);
  state.catalog.groups[0].items[0] = { id: 'i1', url: 'https://example.com' };
  assert.equal(context.healthAppliedOperation(state.healthJob.findings[0]), undefined);
});

test('handoff sends only selected bookmarks and only their missing text fields', async () => {
  const { context, state } = harness();
  let handedOff;
  context.closeHealthCenter = () => {};
  context.openAiOrganizer = async (scope) => { handedOff = scope; };
  state.healthActions.set('missing', { findingId: 'missing', action: '' });
  state.healthActions.set('other', { findingId: 'other', action: 'delete_item' });
  await context.transferHealthToAi();
  assert.equal(JSON.stringify(handedOff), JSON.stringify({ ids: ['i1'], fields: ['description'] }));
});

test('similar URLs are informational and icon-only rows do not start text enrichment', () => {
  const { context, state } = harness();
  assert.equal(context.healthActionOptions({ kind: 'suspected_duplicate' }).length, 0);
  state.catalog.groups[0].items[0].description = 'Already present';
  assert.equal(context.healthFindingSelectable(state.healthJob.findings[0]), false);
});

test('historical false empty findings are suppressed when current group has children or bookmarks', () => {
  const { context, state } = harness();
  state.healthJob.findings = [
    { id: 'parent-empty', kind: 'empty_group', groupId: 'parent' },
    { id: 'filled-empty', kind: 'empty_group', groupId: 'g1' },
    { id: 'leaf-empty', kind: 'empty_group', groupId: 'leaf' }
  ];
  state.catalog.groups.push({ id: 'parent', items: [] }, { id: 'leaf', parentId: 'parent', items: [] });
  assert.equal(JSON.stringify(context.healthFindings().map(row => row.id)), JSON.stringify(['leaf-empty']));
});
