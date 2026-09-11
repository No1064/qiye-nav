import assert from "node:assert/strict";
import test from "node:test";
import { parseBulkMoveItems, parseMoveItem, parseOrder } from "../src/validation.js";

test("move validation accepts stable UUID identifiers and rejects duplicate bulk rows", () => {
  const targetGroupId = "8433727d-e9bc-4533-a90d-0ce3826cfb55";
  assert.deepEqual(parseMoveItem({ targetGroupId }), { targetGroupId });
  assert.deepEqual(parseBulkMoveItems({
    targetGroupId,
    items: [{
      groupId: "c776bbcd-eb59-4f5e-b5c8-b50029a6ecb9",
      itemId: "406ea0dc-0049-45e4-8450-c454363f6fd4",
    }],
  }).targetGroupId, targetGroupId);
  assert.throws(() => parseBulkMoveItems({
    targetGroupId,
    items: [
      { groupId: "group", itemId: "item" },
      { groupId: "group", itemId: "item" },
    ],
  }), { code: "duplicate_move_item" });
});

test("order validation accepts UUID identifiers and rejects identifiers over 100 characters", () => {
  const groupId = "8433727d-e9bc-4533-a90d-0ce3826cfb55";
  const itemId = "406ea0dc-0049-45e4-8450-c454363f6fd4";
  assert.deepEqual(parseOrder({ scope: "groups", groupIds: [groupId] }), {
    scope: "groups", groupIds: [groupId],
  });
  assert.deepEqual(parseOrder({ scope: "items", groupId, itemIds: [itemId] }), {
    scope: "items", groupId, itemIds: [itemId],
  });
  assert.throws(() => parseOrder({ scope: "groups", groupIds: ["x".repeat(101)] }), {
    code: "invalid_request",
  });
});
