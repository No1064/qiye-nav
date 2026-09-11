const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../shared.js");

function sampleTree() {
  return [{
    id: "0",
    title: "",
    children: [{
      id: "1",
      title: "书签栏",
      children: [
        { id: "loose", title: "散落网页", url: "https://loose.example/#top" },
        {
          id: "work",
          title: "工作",
          children: [{
            id: "news-parent",
            title: "资讯",
            children: [
              { id: "one", title: "第一篇", url: "https://one.example/" },
              {
                id: "news-child",
                title: "资讯",
                children: [{ id: "two", title: "第二篇", url: "https://two.example/docs" }]
              }
            ]
          }]
        }
      ]
    }, {
      id: "2",
      title: "其他书签",
      children: [
        { id: "invalid", title: "浏览器页面", url: "chrome://extensions" },
        { id: "other", title: "其他网页", url: "https://other.example/" }
      ]
    }]
  }];
}

test("展开书签树时排除系统根目录，并把散落书签交给默认分组", () => {
  const plan = shared.buildBookmarkImportPlan(sampleTree(), {
    selectedRootId: "all",
    defaultGroupId: "inbox"
  });

  assert.equal(plan.preview.totalBookmarks, 5);
  assert.equal(plan.preview.importableBookmarks, 4);
  assert.equal(plan.preview.skippedBookmarks, 1);
  assert.equal(plan.preview.looseBookmarkCount, 2);
  assert.equal(plan.groups.some((group) => ["书签栏", "其他书签"].includes(group.name)), false);
  assert.deepEqual(plan.bookmarks.find((item) => item.sourceId === "loose").folderPath, []);
  assert.equal(plan.bookmarks.find((item) => item.sourceId === "loose").url, "https://loose.example/#top");
  assert.deepEqual(plan.details.looseBookmarks, [
    { title: "散落网页", url: "https://loose.example/#top", sourceLocation: "书签栏" },
    { title: "其他网页", url: "https://other.example/", sourceLocation: "其他书签" }
  ]);
  assert.deepEqual(plan.details.skippedBookmarks, [{
    title: "浏览器页面",
    url: "chrome://extensions",
    sourceLocation: "其他书签",
    reason: "Chrome 内部页面"
  }]);
});

test("跳过明细区分扩展、本地文件、脚本和不支持的协议", () => {
  const tree = sampleTree();
  tree[0].children[1].children.push(
    { id: "extension", title: "扩展", url: "chrome-extension://abc/page.html" },
    { id: "file", title: "本地", url: "file:///tmp/readme.html" },
    { id: "script", title: "脚本", url: "javascript:alert(1)" },
    { id: "ftp", title: "旧站", url: "ftp://example.com/file" }
  );
  const plan = shared.buildBookmarkImportPlan(tree, { selectedRootId: "all" });
  assert.deepEqual(
    plan.details.skippedBookmarks.map(({ reason }) => reason),
    ["Chrome 内部页面", "扩展页面", "本地文件", "脚本地址", "不支持 FTP 协议"]
  );
});

test("选择子树时保留完整用户文件夹路径并为嵌套同名消歧", () => {
  const plan = shared.buildBookmarkImportPlan(sampleTree(), {
    selectedRootId: "news-parent",
    defaultGroupId: "inbox"
  });

  assert.deepEqual(plan.bookmarks.map((item) => item.folderPath), [
    ["工作", "资讯"],
    ["工作", "资讯", "资讯"]
  ]);
  assert.ok(plan.groups.some((group) => group.name === "工作" && group.path.length === 1));
  assert.ok(plan.groups.some((group) => group.name === "工作 / 资讯" && group.path.length === 2));
  assert.ok(plan.groups.some((group) => group.name === "工作 / 资讯 / 资讯" && group.path.length === 3));
});

test("子树选项包含全部、系统根和用户文件夹，但忽略空目录", () => {
  const tree = sampleTree();
  tree[0].children[0].children.push({ id: "empty", title: "空文件夹", children: [] });
  const options = shared.listBookmarkSubtrees(tree);
  assert.equal(options[0].id, "all");
  assert.ok(options.some((item) => item.id === "1" && item.system));
  assert.ok(options.some((item) => item.id === "news-child" && item.label.includes("工作 / 资讯 / 资讯")));
  assert.equal(options.some((item) => item.id === "empty"), false);
});

test("201 条书签严格拆为 200 + 1，并为重试保留稳定幂等键", () => {
  const bookmarks = Array.from({ length: 201 }, (_, index) => ({
    sourceId: String(index),
    url: `https://example.com/${index}`,
    title: `书签 ${index}`,
    folderPath: index % 2 ? ["工作"] : []
  }));
  const plan = {
    selectedRootId: "all",
    defaultGroupId: "inbox",
    groups: [{ sourceKey: "chrome-folder:work", name: "工作", path: ["工作"] }],
    bookmarks,
    details: { looseBookmarks: [{ title: "预览", url: "https://example.com/0" }], skippedBookmarks: [] },
    preview: { totalBookmarks: 201, importableBookmarks: 201, skippedBookmarks: 0, groupCount: 1, looseBookmarkCount: 101 }
  };
  const task = shared.createBookmarkImportTask(plan, {
    importSessionId: "session-fixed",
    defaultGroupId: "inbox",
    now: 123
  });

  assert.deepEqual(task.batches.map((batch) => batch.end - batch.start), [200, 1]);
  assert.equal(task.batches[0].idempotencyKey, "chrome-import-session-fixed-0");
  assert.equal(shared.importBatchIdempotencyKey("session-fixed", 0), task.batches[0].idempotencyKey);
  assert.equal(task.manifest.details, undefined);
  assert.equal(task.preview.details, undefined);

  const first = shared.buildBookmarkImportBatchPayload(task, 0);
  const second = shared.buildBookmarkImportBatchPayload(task, 1);
  assert.equal(first.items.length, 200);
  assert.equal(second.items.length, 1);
  assert.equal(first.source, "chrome_extension");
  assert.equal(first.importSessionId, "session-fixed");
  assert.equal("folderPath" in first.items[0], false);
  assert.deepEqual(first.items[1].folderPath, ["工作"]);
});

test("批量响应可从 summary 或逐项 results 恢复统计", () => {
  assert.deepEqual(
    shared.summarizeImportResponse({ summary: { total: 2, created: 1, duplicate: 1, invalid: 0, failed: 0 } }, 2),
    { total: 2, created: 1, duplicate: 1, invalid: 0, failed: 0 }
  );
  assert.deepEqual(
    shared.summarizeImportResponse({ results: [{ status: "created" }, { status: "failed" }] }, 2),
    { total: 2, created: 1, duplicate: 0, invalid: 0, failed: 1 }
  );
});
