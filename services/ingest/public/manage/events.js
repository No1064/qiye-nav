"use strict";

function bindEvents() {
  bindHealthEvents();
  const passwordDialog = document.querySelector("#password-dialog");
  document.querySelector("#open-password-dialog").addEventListener("click", () => {
    document.querySelector("#password-form").reset();
    document.querySelector("#password-error").textContent = "";
    passwordDialog.showModal();
  });
  document.querySelector("#close-password-dialog").addEventListener("click", () => passwordDialog.close());
  passwordDialog.addEventListener("close", () => document.querySelector("#password-form").reset());
  document.querySelector("#password-form").addEventListener("submit", changeAdminPassword);
  document.querySelector("#clear-ai-item-scope").addEventListener("click", () => {
    state.aiItemScope = null;
    elements.aiGroupStrategy.disabled = false;
    document.querySelectorAll('input[name="ai-field"]').forEach((input) => { input.disabled = false; input.checked = input.defaultChecked; });
    showAiView("setup");
  });
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.toggleLoginPassword.addEventListener("click", toggleLoginPassword);
  elements.logoutButton.addEventListener("click", () => void logout());
  elements.settingsButton.addEventListener("click", openSettingsDialog);
  elements.settingsForm.addEventListener("submit", handleSettingsSubmit);
  elements.aiProvider.addEventListener("change", handleAiProviderChange);
  elements.aiGroupStrategy.addEventListener("change", updateAiGroupingControls);
  elements.testAiConfig.addEventListener("click", () => void testAiConfig());
  elements.aiOrganizeButton.addEventListener("click", () => void openAiOrganizer());
  elements.aiViewTabs.addEventListener("click", handleAiViewTabClick);
  elements.closeAiDialog.addEventListener("click", closeAiOrganizer);
  elements.aiDialog.addEventListener("close", () => {
    clearTimeout(state.aiPollTimer);
    state.aiPollTimer = null;
  });
  document.querySelectorAll('input[name="ai-scope"]').forEach((input) => {
    input.addEventListener("change", updateAiScopeControls);
  });
  elements.aiSingleGroup.addEventListener("change", updateAiScopeSummary);
  elements.aiMultipleGroups.addEventListener("change", updateAiScopeSummary);
  elements.prepareAiJob.addEventListener("click", prepareAiJob);
  elements.cancelAiStart.addEventListener("click", () => {
    elements.aiStartConfirmation.hidden = true;
    elements.prepareAiJob.hidden = false;
  });
  elements.confirmAiStart.addEventListener("click", () => void startAiJob());
  elements.cancelAiJob.addEventListener("click", () => void cancelAiJob());
  elements.pauseAiJob.addEventListener("click", () => void pauseAiJob());
  elements.resumeAiJob.addEventListener("click", () => void resumeAiJob());
  elements.retryAiJob.addEventListener("click", () => void retryAiJob());
  elements.newAiJob.addEventListener("click", () => showAiView("setup"));
  elements.toggleAiLogs.addEventListener("click", toggleAiLogs);
  elements.deleteAiHistory.addEventListener("click", confirmDeleteAiHistory);
  elements.refreshAiHistory.addEventListener("click", () => void loadAiHistory(true));
  elements.loadMoreAiHistory.addEventListener("click", () => void loadAiHistory(false));
  elements.aiHistoryList.addEventListener("click", handleAiHistoryClick);
  elements.aiProposedGroupList.addEventListener("change", handleProposedGroupSelection);
  elements.selectAllSuggestions.addEventListener("click", () => setAllAiSuggestions(true));
  elements.clearSuggestions.addEventListener("click", () => setAllAiSuggestions(false));
  elements.aiSuggestionList.addEventListener("change", handleAiSuggestionSelection);
  elements.applyAiSuggestions.addEventListener("click", () => void applyAiSuggestions());
  elements.aiChangeSetList.addEventListener("click", handleAiChangeSetClick);
  elements.retryCatalog.addEventListener("click", () => void loadCatalog().catch(() => {}));
  elements.globalSearch.addEventListener("input", () => {
    state.query = elements.globalSearch.value;
    state.selectedItems.clear();
    renderCatalog();
  });
  elements.mobileGroupList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-group-id]");
    if (button) {
      const groupId = button.dataset.groupId;
      if (state.catalog.groups.some((group) => group.parentId === groupId)) {
        if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
        else state.collapsedGroupIds.add(groupId);
      }
      selectGroup(groupId);
    }
  });
  elements.addGroup.addEventListener("click", () => openGroupDialog("create"));
  elements.mobileAddGroup.addEventListener("click", () => openGroupDialog("create"));
  elements.renameGroup.addEventListener("click", () => openGroupDialog("rename"));
  elements.deleteGroup.addEventListener("click", openDeleteGroupDialog);
  elements.addItemTop.addEventListener("click", () => openItemDrawer());
  elements.emptyAddItem.addEventListener("click", handleEmptyAction);
  elements.groupForm.addEventListener("submit", handleGroupSubmit);
  elements.itemForm.addEventListener("submit", handleItemSubmit);
  elements.closeDrawer.addEventListener("click", closeItemDrawer);
  elements.cancelItem.addEventListener("click", closeItemDrawer);
  elements.drawerBackdrop.addEventListener("click", closeItemDrawer);
  elements.clearItemInDrawer.addEventListener("click", deleteDrawerItem);
  elements.previewMetadata.addEventListener("click", () => previewMetadata(false));
  elements.itemUrl.addEventListener("paste", scheduleMetadataPreview);
  elements.itemUrl.addEventListener("input", clearUrlErrors);
  elements.itemLocalUrl.addEventListener("input", clearUrlErrors);
  elements.metadataIcon.addEventListener("error", () => {
    elements.metadataPreview.classList.add("no-icon");
    elements.metadataIcon.hidden = true;
  });
  elements.confirmForm.addEventListener("submit", handleConfirmSubmit);
  elements.groupList.addEventListener("click", handleGroupListClick);
  elements.itemList.addEventListener("click", handleItemListClick);
  elements.itemList.addEventListener("change", handleItemSelectionChange);
  elements.selectVisibleItems.addEventListener("change", toggleVisibleItemSelection);
  elements.clearItemSelection.addEventListener("click", clearItemSelection);
  elements.bulkMoveItems.addEventListener("click", () => void bulkMoveSelectedItems());
  bindDragAndDrop(elements.groupList, "group");
  bindDragAndDrop(elements.itemList, "item");

  document.querySelectorAll(".dialog-close").forEach((button) => {
    button.addEventListener("click", () => elements.groupDialog.close());
  });
  document.querySelectorAll(".confirm-cancel").forEach((button) => {
    button.addEventListener("click", closeConfirmDialog);
  });
  document.querySelectorAll(".settings-close").forEach((button) => {
    button.addEventListener("click", () => elements.settingsDialog.close());
  });
  document.querySelectorAll('input[name="delete-mode"]').forEach((input) => {
    input.addEventListener("change", updateDeleteTargetState);
  });
  document.addEventListener("keydown", handleGlobalKeydown);
  elements.drawer.addEventListener("keydown", trapDrawerFocus);
}

function handleGlobalKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (!elements.app.hidden) {
      event.preventDefault();
      elements.globalSearch.focus();
      elements.globalSearch.select();
    }
    return;
  }
  if (event.key !== "Escape") return;
  if (elements.groupDialog.open || elements.confirmDialog.open || elements.settingsDialog.open || elements.aiDialog.open || elements.healthDialog.open) return;
  if (state.drawer) {
    event.preventDefault();
    closeItemDrawer();
  } else if (state.query) {
    state.query = "";
    elements.globalSearch.value = "";
    renderCatalog();
  }
}

function trapDrawerFocus(event) {
  if (event.key !== "Tab" || !state.drawer) return;
  const focusable = [...elements.drawer.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
