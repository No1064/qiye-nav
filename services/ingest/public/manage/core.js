(function attachManageCore(root, factory) {
  const api = factory();
  root.NavManageCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis, function createManageCore() {
  "use strict";

  function normalizeCatalog(input) {
    const catalog = input?.catalog ?? input ?? {};
    const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
    return {
      version: String(catalog.version ?? ""),
      settings: {
        title: String(catalog.settings?.title ?? "栖页"),
        subtitle: String(catalog.settings?.subtitle ?? "常去的网站和家里的服务"),
        defaultSearchEngine: String(catalog.settings?.defaultSearchEngine ?? "duckduckgo"),
        localAccessHosts: Array.isArray(catalog.settings?.localAccessHosts)
          ? catalog.settings.localAccessHosts.map(String).filter(Boolean)
          : []
      },
      groups: groups.map((group, groupIndex) => {
        const items = Array.isArray(group?.items) ? group.items : [];
        return {
          id: String(group?.id ?? `group-${groupIndex}`),
          name: String(group?.name ?? "未命名分组"),
          ...(group?.parentId ? { parentId: String(group.parentId) } : {}),
          ...(group?.icon ? { icon: String(group.icon) } : {}),
          itemCount: Number.isFinite(Number(group?.itemCount)) ? Number(group.itemCount) : items.length,
          items: items.map((item, itemIndex) => ({
            id: String(item?.id ?? `item-${itemIndex}`),
            title: String(item?.title ?? item?.url ?? "未命名网址"),
            url: String(item?.url ?? ""),
            ...(item?.localUrl ? { localUrl: String(item.localUrl) } : {}),
            ...(item?.description ? { description: String(item.description) } : {}),
            ...(item?.icon ? { icon: String(item.icon) } : {}),
            ...(item?.tags ? { tags: normalizeTags(item.tags) } : {})
          }))
        };
      })
    };
  }

  function normalizeTags(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(",");
    return [...new Set(values.map((tag) => String(tag).trim()).filter(Boolean))];
  }

  function findGroup(catalog, groupId) {
    return catalog?.groups?.find((group) => group.id === groupId) ?? null;
  }

  function groupPath(catalog, group) {
    if (!group) return "";
    const parent = group.parentId ? findGroup(catalog, group.parentId) : null;
    return parent ? `${parent.name} / ${group.name}` : group.name;
  }

  function orderedGroupTree(catalog) {
    const roots = catalog.groups.filter((group) => !group.parentId);
    return roots.flatMap((root) => [root, ...catalog.groups.filter((group) => group.parentId === root.id)]);
  }

  function childGroups(catalog, groupId) {
    return catalog.groups.filter((group) => group.parentId === groupId);
  }

  function groupEntries(catalog, groupId) {
    const group = findGroup(catalog, groupId);
    if (!group) return [];
    return [group, ...childGroups(catalog, groupId)].flatMap((sourceGroup) =>
      sourceGroup.items.map((item) => ({ group: sourceGroup, item }))
    );
  }

  function groupTotalCount(catalog, groupId) {
    return groupEntries(catalog, groupId).length;
  }

  function listVisibleItems(catalog, currentGroupId, query) {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN");
    const groups = normalizedQuery
      ? catalog.groups
      : [findGroup(catalog, currentGroupId), ...childGroups(catalog, currentGroupId)].filter(Boolean);
    const results = [];
    for (const group of groups) {
      for (const item of group.items) {
        const haystack = [
          item.title,
          item.url,
          item.localUrl,
          item.description,
          ...(item.tags || []),
          group.name,
          groupPath(catalog, group)
        ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
        if (!normalizedQuery || haystack.includes(normalizedQuery)) {
          results.push({ group, item });
        }
      }
    }
    return results;
  }

  function reorderIds(ids, sourceId, targetId) {
    const result = [...ids];
    const sourceIndex = result.indexOf(sourceId);
    const targetIndex = result.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return result;
    const [moved] = result.splice(sourceIndex, 1);
    result.splice(targetIndex, 0, moved);
    return result;
  }

  function moveId(ids, id, delta) {
    const sourceIndex = ids.indexOf(id);
    const targetIndex = sourceIndex + delta;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ids.length) return [...ids];
    const result = [...ids];
    [result[sourceIndex], result[targetIndex]] = [result[targetIndex], result[sourceIndex]];
    return result;
  }

  function aiGroupingOptions(values, itemCount, strategy) {
    const count = Number(itemCount);
    const targetRaw = String(values?.targetGroupCount ?? "").trim();
    const minimumRaw = String(values?.minGroupSize ?? "").trim();
    const maximumRaw = String(values?.maxGroupSize ?? "").trim();
    const target = targetRaw ? Number(targetRaw) : undefined;
    const minimum = minimumRaw ? Number(minimumRaw) : 5;
    const maximum = maximumRaw ? Number(maximumRaw) : 40;

    if (target !== undefined && (!Number.isInteger(target) || target < 1 || target > 100)) {
      throw new Error("目标分组数应为 1 至 100 的整数，或留空自动计算");
    }
    if (target !== undefined && target > count) {
      throw new Error(`目标分组数不能超过本次整理的 ${count} 个网址`);
    }
    if (!Number.isInteger(minimum) || minimum < 2 || minimum > 50) {
      throw new Error("最小容量应为 2 至 50 的整数，留空则使用 5");
    }
    if (!Number.isInteger(maximum) || maximum < 5 || maximum > 200) {
      throw new Error("最大容量应为 5 至 200 的整数，留空则使用 40");
    }
    if (minimum > maximum) throw new Error("最小容量不能大于最大容量");

    const factor = strategy === "rebuild" ? 1.15 : 1.4;
    const automaticTarget = Math.max(1, Math.min(60, Math.round(Math.sqrt(Math.max(1, count)) * factor)));
    return {
      request: {
        ...(target === undefined ? {} : { targetGroupCount: target }),
        minGroupSize: minimum,
        maxGroupSize: maximum
      },
      resolved: { targetGroupCount: target ?? automaticTarget, minGroupSize: minimum, maxGroupSize: maximum },
      automatic: target === undefined
    };
  }

  function responseErrorMessage(body, status) {
    const code = body?.error?.code ?? body?.code;
    const translated = {
      dashy_upstream_error: "导航数据源暂时不可用，请稍后重试",
      duplicate_group: "已存在同名分组，请换一个名称",
      group_has_children: "该分组仍有下级分组，请先移动或删除下级分组",
      duplicate_url: "这个网址已经存在于导航站中",
      group_not_found: "目标分组已不存在，请刷新后重试",
      invalid_migration_target: "迁移目标无效，请选择其他分组",
      invalid_group_parent: "分组最多支持两级，且父分组不能放到自己的下级中",
      invalid_order: "排序内容与当前目录不一致，请刷新后重试",
      invalid_request: "提交的内容不完整或格式不正确",
      invalid_url: "网址格式不正确",
      invalid_url_scheme: "网址仅支持 HTTP 或 HTTPS",
      item_not_found: "目标网址已不存在，请刷新后重试",
      local_url_disabled: "服务端未启用局域网地址",
      metadata_invalid_content_type: "目标页面不是可读取的 HTML 网页",
      metadata_access_denied: "目标网站拒绝自动读取，你仍可手动填写后保存",
      ssrf_target_blocked: "该地址因内网访问安全策略被阻止",
      admin_unauthorized: "管理会话已失效，请重新登录",
      ai_empty_completion: "模型返回了空内容，请重试；若持续出现，请检查模型名称或切换模型",
      ai_timeout: "模型生成响应超时，已完成的前置分析会保留；请直接重试失败阶段",
      ai_suggestion_stale: "该网址在分析后已被修改，请刷新后查看具体冲突项",
      ai_group_plan_stale: "AI 准备复用的分组结构在分析后已被修改，请刷新后重新分析该分组",
      ai_invalid_response: "模型返回内容无法解析，请重试或检查模型兼容性",
      ai_response_truncated: "模型输出被截断，请缩小整理范围后重试",
      unauthorized: "管理会话已失效，请重新登录",
      url_credentials_forbidden: "网址中不能包含用户名或密码",
      version_conflict: "目录已被其他操作更新，请刷新后重试",
      version_required: "目录版本缺失，请刷新后重试"
    }[code];
    if (translated) return translated;
    const message = body?.error?.message ?? body?.message ?? body?.error;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (message && typeof message === "object") {
      const nested = message.message ?? message.detail ?? message.reason;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
    if (status === 401) return "管理会话已失效，请重新登录";
    if (status === 409) return "目录已被其他操作更新，请刷新后重试";
    return `请求失败 (${status})`;
  }

  return Object.freeze({
    findGroup,
    groupEntries,
    groupTotalCount,
    groupPath,
    aiGroupingOptions,
    listVisibleItems,
    moveId,
    normalizeCatalog,
    normalizeTags,
    orderedGroupTree,
    reorderIds,
    responseErrorMessage
  });
});
