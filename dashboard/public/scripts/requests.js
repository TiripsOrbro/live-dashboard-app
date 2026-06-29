(function (global) {
    const REQUESTS_PANEL_HTML = `
        <div class="requests-view">
            <header class="admin-section-header requests-view-header">
                <div class="requests-view-header-row">
                    <div>
                        <h2>Feature requests</h2>
                        <p class="admin-section-subtitle">Upvote requests to raise important ideas. Downvote to lower them. New requests email the team.</p>
                    </div>
                    <button type="button" id="requests-add-toggle" class="requests-add-toggle" aria-label="New request" aria-expanded="false" title="New request">
                        <svg class="requests-add-toggle-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                            <path fill="currentColor" d="M12 5c.55 0 1 .45 1 1v5h5c.55 0 1 .45 1 1s-.45 1-1 1h-5v5c0 .55-.45 1-1 1s-1-.45-1-1v-5H6c-.55 0-1-.45-1-1s.45-1 1-1h5V6c0-.55.45-1 1-1z"/>
                        </svg>
                    </button>
                </div>
            </header>
            <div id="requests-form-wrap" class="requests-form-wrap">
                <form id="requests-form" class="requests-form">
                    <input id="requests-title" name="title" type="text" class="requests-form-title" placeholder="Title" maxlength="2000" required autocomplete="off">
                    <div class="requests-form-description-wrap">
                        <button type="button" id="requests-add-description" class="requests-form-add-description">Add description</button>
                        <div id="requests-description-panel" class="requests-form-description-panel">
                            <textarea id="requests-description" name="description" rows="3" placeholder="Add more context…"></textarea>
                        </div>
                    </div>
                    <div class="requests-form-footer">
                        <select id="requests-category" name="category" aria-label="Tab"></select>
                        <button type="submit" class="requests-submit mic-settings-btn mic-settings-btn--primary">Add request</button>
                    </div>
                </form>
            </div>
            <p id="requests-success" class="requests-success" role="status" hidden></p>
            <div class="admin-settings-segmented-tabs admin-accounts-org-nav requests-tabs-bar">
                <div class="admin-accounts-scope-row-wrap">
                    <span class="admin-accounts-scope-row-label">Category</span>
                    <div class="requests-tabs-row">
                        <div id="requests-tabs" class="admin-accounts-scope-row admin-accounts-scope-row--equal requests-tabs" role="tablist" aria-label="Feature request tabs"></div>
                        <button type="button" id="requests-tab-add" class="admin-accounts-scope-chip requests-tab-add" aria-label="Add tab" title="Add tab">+</button>
                    </div>
                </div>
            </div>
            <div id="requests-list" class="requests-list" aria-live="polite">Loading…</div>
            <p id="requests-empty" class="requests-empty" hidden>No feature requests yet.</p>
            <p id="requests-error" class="requests-error" role="alert" hidden></p>
            <div class="admin-settings-segmented-tabs requests-done-bar">
                <div class="admin-accounts-scope-row-wrap">
                    <div class="admin-accounts-scope-row admin-accounts-scope-row--equal requests-done-row" style="--scope-cols: 1">
                        <button type="button" id="requests-done-toggle" class="admin-accounts-scope-chip requests-done-toggle" aria-pressed="false" role="tab">Done</button>
                    </div>
                </div>
            </div>
            <dialog id="requests-tab-dialog" class="requests-tab-dialog">
                <form id="requests-tab-dialog-form" class="requests-tab-dialog-form">
                    <h2 class="requests-tab-dialog-title">New tab</h2>
                    <label class="requests-tab-dialog-label" for="requests-tab-dialog-input">Tab name</label>
                    <input id="requests-tab-dialog-input" class="requests-tab-dialog-input" type="text" maxlength="40" autocomplete="off" placeholder="e.g. Dashboard">
                    <div class="requests-tab-dialog-actions">
                        <button type="button" id="requests-tab-dialog-cancel" class="requests-tab-dialog-cancel">Cancel</button>
                        <button type="submit" class="requests-tab-dialog-create mic-settings-btn mic-settings-btn--primary">Create tab</button>
                    </div>
                </form>
            </dialog>
        </div>`;

    let pageHost = null;
    let formEl;
    let formWrapEl;
    let addToggleEl;
    let titleEl;
    let addDescriptionBtn;
    let descriptionPanelEl;
    let descriptionEl;
    let categoryEl;
    let submitEl;
    let tabsEl;
    let tabAddEl;
    let doneToggleEl;
    let tabDialogEl;
    let tabDialogFormEl;
    let tabDialogInputEl;
    let tabDialogCancelEl;
    let listEl;
    let emptyEl;
    let errorEl;
    let successEl;

    let categories = [];
    let priorities = [];
    let allRequests = [];
    let canManage = false;
    let activeTab = null;
    let expandedId = null;
    let formOpen = false;
    let descriptionOpen = false;
    let panelAnimating = false;

    const PANEL_MS = 700;
    const CREATE_TAB_VALUE = '__create_tab__';
    const UNASSIGNED_TAB = 'unassigned';

    function wait(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    async function closePanelElement(panel) {
        if (!panel || !panel.classList.contains('is-open')) return;
        panel.classList.remove('is-open');
        await wait(PANEL_MS);
    }

    function bindDom(root) {
        formEl = root.querySelector('#requests-form');
        formWrapEl = root.querySelector('#requests-form-wrap');
        addToggleEl = root.querySelector('#requests-add-toggle');
        titleEl = root.querySelector('#requests-title');
        addDescriptionBtn = root.querySelector('#requests-add-description');
        descriptionPanelEl = root.querySelector('#requests-description-panel');
        descriptionEl = root.querySelector('#requests-description');
        categoryEl = root.querySelector('#requests-category');
        submitEl = formEl?.querySelector('.requests-submit');
        tabsEl = root.querySelector('#requests-tabs');
        tabAddEl = root.querySelector('#requests-tab-add');
        doneToggleEl = root.querySelector('#requests-done-toggle');
        tabDialogEl = root.querySelector('#requests-tab-dialog');
        tabDialogFormEl = root.querySelector('#requests-tab-dialog-form');
        tabDialogInputEl = root.querySelector('#requests-tab-dialog-input');
        tabDialogCancelEl = root.querySelector('#requests-tab-dialog-cancel');
        listEl = root.querySelector('#requests-list');
        emptyEl = root.querySelector('#requests-empty');
        errorEl = root.querySelector('#requests-error');
        successEl = root.querySelector('#requests-success');
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function categoryLabel(categoryId) {
        if (!categoryId) return 'Unassigned';
        const match = categories.find((row) => row.id === categoryId);
        return match?.label || categoryId;
    }

    function visibleCategories() {
        return categories.filter((row) => !row.hidden);
    }

    function findCategoryByInput(raw) {
        const trimmed = String(raw || '').trim();
        if (!trimmed || trimmed.toLowerCase() === 'unassigned') return null;
        return (
            visibleCategories().find(
                (row) => row.id === trimmed.toLowerCase() || row.label.toLowerCase() === trimmed.toLowerCase()
            ) || null
        );
    }

    function promptTabName() {
        return new Promise((resolve) => {
            if (!tabDialogEl || !tabDialogInputEl || !tabDialogFormEl) {
                resolve(null);
                return;
            }

            tabDialogInputEl.value = '';
            tabDialogInputEl.setCustomValidity('');

            const finish = (value) => {
                tabDialogFormEl.removeEventListener('submit', onSubmit);
                tabDialogCancelEl?.removeEventListener('click', onCancel);
                tabDialogEl.removeEventListener('cancel', onCancel);
                tabDialogEl.close();
                resolve(value);
            };

            const onCancel = (event) => {
                event.preventDefault();
                finish(null);
            };

            const onSubmit = (event) => {
                event.preventDefault();
                const trimmed = String(tabDialogInputEl.value || '').trim();
                if (trimmed.length < 2) {
                    tabDialogInputEl.setCustomValidity('Tab name must be at least 2 characters.');
                    tabDialogInputEl.reportValidity();
                    return;
                }
                tabDialogInputEl.setCustomValidity('');
                finish(trimmed);
            };

            tabDialogFormEl.addEventListener('submit', onSubmit);
            tabDialogCancelEl?.addEventListener('click', onCancel);
            tabDialogEl.addEventListener('cancel', onCancel);
            tabDialogEl.showModal();
            tabDialogInputEl.focus();
        });
    }

    function showError(message) {
        if (!errorEl) return;
        errorEl.hidden = !message;
        errorEl.textContent = message || '';
    }

    function showSuccess(message) {
        if (!successEl) return;
        successEl.hidden = !message;
        successEl.textContent = message || '';
    }

    async function readApiJson(res) {
        const text = await res.text();
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch {
            if (res.status === 404) {
                throw new Error('Tab API not found. Restart the dashboard server and try again.');
            }
            if (res.status >= 500) {
                throw new Error(`Server error (${res.status}). Check the server console and try again.`);
            }
            throw new Error(`Unexpected response (${res.status}). Restart the dashboard server and try again.`);
        }
    }

    function setDescriptionOpen(open) {
        descriptionOpen = Boolean(open);
        formWrapEl?.classList.toggle('has-description', descriptionOpen);
        addDescriptionBtn?.classList.toggle('is-hidden', descriptionOpen);
        if (!descriptionPanelEl) return;
        if (descriptionOpen) {
            requestAnimationFrame(() => {
                descriptionPanelEl.classList.add('is-open');
                descriptionEl?.focus();
            });
        } else {
            descriptionPanelEl.classList.remove('is-open');
            if (descriptionEl) descriptionEl.value = '';
        }
    }

    function resetNewRequestForm() {
        if (titleEl) titleEl.value = '';
        setDescriptionOpen(false);
    }

    function setFormOpen(open) {
        formOpen = Boolean(open);
        addToggleEl?.setAttribute('aria-expanded', formOpen ? 'true' : 'false');
        addToggleEl?.classList.toggle('is-active', formOpen);
        if (!formWrapEl) return;
        if (formOpen) {
            requestAnimationFrame(() => {
                formWrapEl.classList.add('is-open');
                titleEl?.focus();
            });
        } else {
            formWrapEl.classList.remove('is-open');
            formWrapEl.classList.remove('has-description');
            resetNewRequestForm();
        }
    }

    async function createTabWithLabel(label, options = {}) {
        const switchActiveTab = options.switchActiveTab !== false;
        const deferRender = Boolean(options.deferRender);
        const selectEl = options.selectEl || null;
        const trimmed = String(label || '').trim();
        if (trimmed.length < 2) {
            showError('Tab name must be at least 2 characters.');
            return null;
        }

        const existing = findCategoryByInput(trimmed);
        if (existing) {
            if (switchActiveTab) activeTab = existing.id;
            if (selectEl) setCategorySelect(selectEl, existing.id);
            if (!deferRender) {
                setFormCategorySelect(existing.id);
                renderRequests();
                scrollTabIntoView(existing.id);
            }
            return existing.id;
        }

        showError('');
        if (tabAddEl) tabAddEl.disabled = true;
        try {
            const res = await fetch('/api/feature-requests/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ label: trimmed }),
            });
            const data = await readApiJson(res);
            if (!res.ok || !data.success) {
                throw new Error(data.error || `Could not create tab (${res.status}).`);
            }
            applyCategoriesUpdate(data);
            const newId = data.category?.id || null;
            if (!newId) {
                throw new Error('Tab was created but no id was returned.');
            }
            if (switchActiveTab) activeTab = newId;
            if (selectEl) setCategorySelect(selectEl, newId);
            if (!deferRender) {
                setFormCategorySelect(newId);
                renderRequests();
                scrollTabIntoView(newId);
                showSuccess(`Tab “${trimmed}” created.`);
            }
            return newId;
        } catch (error) {
            showError(error.message || 'Could not create tab.');
            return null;
        } finally {
            if (tabAddEl) tabAddEl.disabled = false;
        }
    }

    async function createTab(options = {}) {
        const label = options.label != null ? options.label : await promptTabName();
        if (label == null) return null;
        return createTabWithLabel(label, options);
    }

    async function handleCategorySelectChange(selectEl) {
        if (!selectEl) return;
        if (selectEl.value !== CREATE_TAB_VALUE) {
            selectEl.dataset.lastValue = selectEl.value;
            return;
        }
        const previous = selectEl.dataset.lastValue ?? '';
        selectEl.value = previous;
        const itemEl = selectEl.closest('[data-request-id]');
        const requestId = itemEl?.getAttribute('data-request-id') || null;
        const deferRender = Boolean(requestId);
        const tabId = await createTab({
            switchActiveTab: Boolean(requestId),
            selectEl,
            deferRender,
        });
        if (!tabId || !requestId || !itemEl) return;

        showError('');
        showSuccess('');
        try {
            const body = readPanelState(itemEl);
            body.category = tabId;
            await patchRequest(requestId, body);
            activeTab = tabId;
            expandedId = requestId;
            renderRequests();
            scrollTabIntoView(tabId);
            showSuccess(`Assigned to “${categoryLabel(tabId)}”.`);
        } catch (error) {
            showError(error.message || 'Tab created but could not assign request.');
            renderRequests();
        }
    }

    function priorityOptionsHtml(selectedId) {
        const selected = selectedId || 'normal';
        return priorities
            .map(
                (row) =>
                    `<option value="${escapeAttr(row.id)}"${row.id === selected ? ' selected' : ''}>${escapeHtml(row.label)}</option>`
            )
            .join('');
    }

    function priorityBadgeHtml(priorityId) {
        const id = priorityId || 'normal';
        if (id === 'normal') return '';
        const match = priorities.find((row) => row.id === id);
        if (!match) return '';
        return `<span class="requests-priority requests-priority--${escapeAttr(id)}">${escapeHtml(match.label)}</span>`;
    }

    function countForTab(tabId) {
        if (tabId === 'done') {
            return allRequests.filter((row) => row.completed).length;
        }
        if (tabId === UNASSIGNED_TAB) {
            return allRequests.filter((row) => !row.completed && !row.category).length;
        }
        return allRequests.filter((row) => !row.completed && row.category === tabId).length;
    }

    function filterRequestsForTab(requests, tabId) {
        if (tabId === 'done') {
            return requests.filter((row) => row.completed);
        }
        if (tabId === UNASSIGNED_TAB) {
            return requests.filter((row) => !row.completed && !row.category);
        }
        return requests.filter((row) => row.category === tabId);
    }

    function isValidActiveTab(tabId) {
        if (tabId === UNASSIGNED_TAB || tabId === 'done') return true;
        return visibleCategories().some((row) => row.id === tabId);
    }

    function resolveDefaultActiveTab() {
        const sorted = sortedMainTabs();
        const firstUrgent = sorted.find((tab) => tab.hasUrgent && tab.openCount > 0);
        if (firstUrgent) return firstUrgent.id;
        if (countForTab(UNASSIGNED_TAB) > 0) return UNASSIGNED_TAB;
        const firstWithOpen = sorted.find((tab) => tab.openCount > 0);
        if (firstWithOpen) return firstWithOpen.id;
        return sorted[0]?.id || UNASSIGNED_TAB;
    }

    function ensureActiveTab() {
        if (!isValidActiveTab(activeTab)) {
            activeTab = resolveDefaultActiveTab();
        } else if (activeTab == null) {
            activeTab = resolveDefaultActiveTab();
        }
    }

    function priorityRank(priorityId) {
        const match = priorities.find((row) => row.id === (priorityId || 'normal'));
        return match?.rank ?? 2;
    }

    function openRequestsForTab(tabId) {
        if (tabId === UNASSIGNED_TAB) {
            return allRequests.filter((row) => !row.completed && !row.category);
        }
        if (tabId === 'done') return [];
        return allRequests.filter((row) => !row.completed && row.category === tabId);
    }

    function tabSortMeta(tabId) {
        const open = openRequestsForTab(tabId);
        const openCount = open.length;
        const hasUrgent = open.some((row) => (row.priority || 'normal') === 'urgent');
        const maxPriority = openCount ? Math.max(...open.map((row) => priorityRank(row.priority))) : 0;
        return { openCount, hasUrgent, maxPriority };
    }

    function compareTabSort(a, b) {
        const aEmpty = a.openCount === 0;
        const bEmpty = b.openCount === 0;
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
        if (a.hasUrgent !== b.hasUrgent) return a.hasUrgent ? -1 : 1;
        if (b.maxPriority !== a.maxPriority) return b.maxPriority - a.maxPriority;
        if (a.id === UNASSIGNED_TAB) return -1;
        if (b.id === UNASSIGNED_TAB) return 1;
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    }

    function sortedMainTabs() {
        return [{ id: UNASSIGNED_TAB, label: 'Unassigned' }, ...visibleCategories()]
            .map((tab) => ({ ...tab, ...tabSortMeta(tab.id) }))
            .sort(compareTabSort);
    }

    function tabsForBar() {
        return sortedMainTabs().filter((tab) => tab.openCount > 0 || tab.id === activeTab);
    }

    function sortedVisibleCategories() {
        return sortedMainTabs().filter((tab) => tab.id !== UNASSIGNED_TAB);
    }

    function categorySelectOptionsHtml(selectedId) {
        const selected = selectedId || '';
        const tabOptions = sortedVisibleCategories()
            .map(
                (cat) =>
                    `<option value="${escapeAttr(cat.id)}"${cat.id === selected ? ' selected' : ''}>${escapeHtml(cat.label)}</option>`
            )
            .join('');
        const createOption = canManage
            ? `<option disabled aria-hidden="true">──────────</option><option value="${CREATE_TAB_VALUE}">+ New tab…</option>`
            : '';
        return `<option value=""${!selected ? ' selected' : ''}>Unassigned</option>${tabOptions}${createOption}`;
    }

    function setCategorySelect(selectEl, categoryId) {
        if (!selectEl) return;
        selectEl.innerHTML = categorySelectOptionsHtml(categoryId || '');
        selectEl.value = categoryId || '';
        selectEl.dataset.lastValue = categoryId || '';
    }

    function setFormCategorySelect(categoryId) {
        setCategorySelect(categoryEl, categoryId);
    }

    function applyCategoriesUpdate(data) {
        if (Array.isArray(data?.categories)) {
            categories = data.categories;
            return;
        }
        if (data?.category?.id && !categories.some((row) => row.id === data.category.id)) {
            categories = [...categories, data.category];
        }
    }

    function scrollTabIntoView(tabId) {
        if (!tabId || tabId === UNASSIGNED_TAB || tabId === 'done' || !tabsEl) return;
        requestAnimationFrame(() => {
            tabsEl.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)?.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'nearest',
            });
        });
    }

    function renderDoneToggle() {
        if (!doneToggleEl) return;
        const count = countForTab('done');
        const isActive = activeTab === 'done';
        doneToggleEl.classList.toggle('is-active', isActive);
        doneToggleEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
        doneToggleEl.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        doneToggleEl.innerHTML = `<span class="requests-tab-label">Done</span>${count ? `<span class="requests-tab-count">${count}</span>` : ''}`;
    }

    function renderTabs() {
        if (!tabsEl) return;
        if (tabAddEl) tabAddEl.hidden = !canManage;
        const tabs = tabsForBar();
        tabsEl.style.setProperty('--scope-cols', String(Math.max(tabs.length, 1)));
        tabsEl.innerHTML = tabs
            .map((tab) => {
                const count = countForTab(tab.id);
                const selected = tab.id === activeTab;
                return `
                    <button
                        type="button"
                        class="admin-accounts-scope-chip${selected ? ' is-active' : ''}"
                        role="tab"
                        aria-selected="${selected ? 'true' : 'false'}"
                        data-tab-id="${escapeAttr(tab.id)}"
                    >
                        <span class="requests-tab-label">${escapeHtml(tab.label)}</span>${count ? `<span class="requests-tab-count">${count}</span>` : ''}
                    </button>
                `;
            })
            .join('');
        renderDoneToggle();
    }

    async function applyTabRemoval(tabId, mode, selectEl) {
        const cat = categories.find((row) => row.id === tabId);
        if (!cat) return false;
        const actionLabel = mode === 'hide' ? 'Hide' : 'Delete';
        const confirmed = window.confirm(
            `${actionLabel} “${cat.label}” tab?\n\nRequests in this tab will be unassigned and only show under Unassigned.`
        );
        if (!confirmed) return false;

        showError('');
        showSuccess('');
        try {
            const res = await fetch(`/api/feature-requests/categories/${encodeURIComponent(tabId)}`, {
                method: mode === 'hide' ? 'PATCH' : 'DELETE',
                headers: mode === 'hide' ? { 'Content-Type': 'application/json' } : undefined,
                credentials: 'same-origin',
                body: mode === 'hide' ? JSON.stringify({ hidden: true }) : undefined,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || `Could not ${mode} tab.`);
            }
            categories = Array.isArray(data.categories) ? data.categories : categories;
            allRequests = Array.isArray(data.requests) ? data.requests : allRequests;
            if (activeTab === tabId) activeTab = resolveDefaultActiveTab();
            expandedId = null;
            if (selectEl) setCategorySelect(selectEl, null);
            setFormCategorySelect('');
            renderRequests();
            const count = Number(data.unassignedCount) || 0;
            showSuccess(
                `${mode === 'hide' ? 'Tab hidden' : 'Tab deleted'}.${count ? ` ${count} request(s) unassigned.` : ''}`
            );
            return true;
        } catch (error) {
            showError(error.message || `Could not ${mode} tab.`);
            return false;
        }
    }

    async function hideTab(tabId, selectEl) {
        return applyTabRemoval(tabId, 'hide', selectEl);
    }

    async function deleteTab(tabId, selectEl) {
        return applyTabRemoval(tabId, 'delete', selectEl);
    }

    function buildMilestoneHtml(milestone, index) {
        const id = milestone?.id || `draft-${index}`;
        const text = milestone?.text || '';
        const completed = Boolean(milestone?.completed);
        return `
            <li class="requests-milestone" data-milestone-id="${escapeAttr(id)}">
                <label class="requests-milestone-check">
                    <input type="checkbox" data-field="milestone-completed"${completed ? ' checked' : ''}>
                    <span class="requests-milestone-text">${escapeHtml(text)}</span>
                </label>
                <input type="text" class="requests-milestone-input" value="${escapeAttr(text)}" placeholder="Milestone">
                <button type="button" class="requests-milestone-remove" data-action="remove-milestone" aria-label="Remove milestone">×</button>
            </li>
        `;
    }

    function buildVoteHtml(row) {
        const completed = Boolean(row.completed);
        if (completed) {
            return `<div class="requests-vote-stack requests-vote-stack--disabled" aria-hidden="true">
                <span class="requests-vote-score">${Number(row.score) || 0}</span>
            </div>`;
        }
        return `
            <div class="requests-vote-stack">
                <button
                    type="button"
                    class="requests-vote requests-vote--up${row.upvotedByViewer ? ' is-active' : ''}"
                    data-action="vote-up"
                    data-request-id="${escapeAttr(row.id)}"
                    aria-label="${row.upvotedByViewer ? 'Remove upvote' : 'Upvote'}"
                >▲</button>
                <span class="requests-vote-score">${Number(row.score) || 0}</span>
                <button
                    type="button"
                    class="requests-vote requests-vote--down${row.downvotedByViewer ? ' is-active' : ''}"
                    data-action="vote-down"
                    data-request-id="${escapeAttr(row.id)}"
                    aria-label="${row.downvotedByViewer ? 'Remove downvote' : 'Downvote'}"
                >▼</button>
            </div>`;
    }

    function buildReadOnlyPanel(row) {
        const details = row.details
            ? `<p class="requests-panel-details requests-panel-details--readonly">${escapeHtml(row.details).replace(/\n/g, '<br>')}</p>`
            : '';
        const milestones = Array.isArray(row.milestones) ? row.milestones : [];
        const milestoneHtml = milestones.length
            ? `<ul class="requests-milestones requests-milestones--readonly">${milestones
                  .map(
                      (milestone) =>
                          `<li class="requests-milestone-readonly${milestone.completed ? ' is-done' : ''}">${escapeHtml(milestone.text)}</li>`
                  )
                  .join('')}</ul>`
            : '';
        return `
            ${details}
            ${milestoneHtml}
            <p class="requests-item-meta">Submitted by ${escapeHtml(row.submittedByName || row.submittedBy || 'Unknown')}</p>
        `;
    }

    function buildAdminPanelHtml(row) {
        const completed = Boolean(row.completed);
        const milestones = Array.isArray(row.milestones) ? row.milestones : [];
        return `
            <label class="requests-panel-label" for="details-${escapeAttr(row.id)}">Details</label>
            <textarea id="details-${escapeAttr(row.id)}" class="requests-panel-details" data-field="details" rows="2" placeholder="Notes, context, links…">${escapeHtml(row.details || '')}</textarea>

            <div class="requests-panel-fields">
                <div class="requests-panel-field">
                    <label class="requests-panel-label" for="category-${escapeAttr(row.id)}">Tab</label>
                    <select id="category-${escapeAttr(row.id)}" class="requests-panel-select" data-field="category">
                        ${categorySelectOptionsHtml(row.category || '')}
                    </select>
                </div>
                <div class="requests-panel-field">
                    <label class="requests-panel-label" for="priority-${escapeAttr(row.id)}">Priority</label>
                    <select id="priority-${escapeAttr(row.id)}" class="requests-panel-select" data-field="priority">
                        ${priorityOptionsHtml(row.priority || 'normal')}
                    </select>
                </div>
            </div>

            <div class="requests-panel-milestones-head">
                <span class="requests-panel-label">Milestones</span>
                <button type="button" class="requests-panel-link" data-action="add-milestone">Add milestone</button>
            </div>
            <ul class="requests-milestones">
                ${milestones.map((milestone, index) => buildMilestoneHtml(milestone, index)).join('')}
            </ul>

            <div class="requests-panel-footer">
                <label class="requests-panel-done">
                    <input type="checkbox" data-field="completed"${completed ? ' checked' : ''}>
                    Mark complete
                </label>
                <div class="requests-panel-actions">
                    <button type="button" class="requests-panel-save" data-action="save">Save</button>
                    <span class="requests-panel-status" data-role="save-status"></span>
                </div>
            </div>
        `;
    }

    function buildItemHtml(row) {
        const completed = Boolean(row.completed);
        const expanded = row.id === expandedId;
        const milestones = Array.isArray(row.milestones) ? row.milestones : [];
        const milestoneCount = milestones.length;
        const doneCount = milestones.filter((m) => m.completed).length;
        const progress =
            milestoneCount > 0 ? `<span class="requests-item-progress">${doneCount}/${milestoneCount}</span>` : '';
        const priorityBadge = priorityBadgeHtml(row.priority);

        return `
            <article class="requests-item requests-item--with-votes${completed ? ' is-completed' : ''}${expanded ? ' is-expanded' : ''}" data-request-id="${escapeHtml(row.id)}">
                ${buildVoteHtml(row)}
                <div class="requests-item-main">
                    <button
                        type="button"
                        class="requests-item-header"
                        data-action="expand"
                        aria-expanded="${expanded ? 'true' : 'false'}"
                    >
                        ${priorityBadge}
                        <span class="requests-item-text">${escapeHtml(row.text)}</span>
                        ${progress}
                    </button>
                    <div class="requests-item-panel">
                        ${canManage ? buildAdminPanelHtml(row) : buildReadOnlyPanel(row)}
                    </div>
                </div>
            </article>
        `;
    }

    function renderRequests() {
        if (!listEl) return;
        const rows = filterRequestsForTab(allRequests, activeTab);
        renderTabs();
        if (!rows.length) {
            listEl.innerHTML = '';
            expandedId = null;
            if (emptyEl) {
                emptyEl.hidden = false;
                emptyEl.textContent =
                    activeTab === 'done'
                        ? 'No completed requests yet.'
                        : activeTab === UNASSIGNED_TAB
                          ? 'No unassigned requests.'
                          : `No requests in ${categoryLabel(activeTab)} yet.`;
            }
            return;
        }
        if (emptyEl) emptyEl.hidden = true;
        if (expandedId && !rows.some((row) => row.id === expandedId)) {
            expandedId = null;
        }
        listEl.innerHTML = rows.map((row) => buildItemHtml(row)).join('');
        if (expandedId) {
            const panel = listEl.querySelector(
                `[data-request-id="${CSS.escape(expandedId)}"] .requests-item-panel`
            );
            if (panel) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => panel.classList.add('is-open'));
                });
            }
        }
    }

    async function loadRequests() {
        showError('');
        if (listEl) listEl.textContent = 'Loading…';
        const res = await fetch('/api/feature-requests', { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load feature requests.');
        }
        categories = Array.isArray(data.categories) ? data.categories : [];
        priorities = Array.isArray(data.priorities)
            ? data.priorities
            : [
                  { id: 'low', label: 'Low' },
                  { id: 'normal', label: 'Normal' },
                  { id: 'high', label: 'High' },
                  { id: 'urgent', label: 'Urgent' },
              ];
        allRequests = Array.isArray(data.requests) ? data.requests : [];
        canManage = Boolean(data.canManage);
        ensureActiveTab();
        setFormCategorySelect(activeTab === 'done' ? '' : activeTab === UNASSIGNED_TAB ? '' : activeTab);
        renderRequests();
    }

    function readPanelState(itemEl) {
        const details = itemEl.querySelector('[data-field="details"]')?.value ?? '';
        const categoryValue = itemEl.querySelector('[data-field="category"]')?.value ?? '';
        const category = categoryValue && categoryValue !== CREATE_TAB_VALUE ? categoryValue : null;
        const priority = itemEl.querySelector('[data-field="priority"]')?.value ?? 'normal';
        const completed = Boolean(itemEl.querySelector('[data-field="completed"]')?.checked);
        const milestones = [];
        itemEl.querySelectorAll('.requests-milestone').forEach((row, index) => {
            const text = String(row.querySelector('.requests-milestone-input')?.value || '').trim();
            if (!text) return;
            milestones.push({
                id: row.getAttribute('data-milestone-id') || `draft-${index}`,
                text,
                completed: Boolean(row.querySelector('[data-field="milestone-completed"]')?.checked),
            });
        });
        return { details, category, priority, completed, milestones };
    }

    async function patchRequest(id, body) {
        const res = await fetch(`/api/feature-requests/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not update feature request.');
        }
        allRequests = Array.isArray(data.requests) ? data.requests : allRequests;
        if (Array.isArray(data.categories)) {
            categories = data.categories;
        }
        renderTabs();
        return data;
    }

    async function toggleVote(requestId, direction) {
        const res = await fetch(`/api/feature-requests/${encodeURIComponent(requestId)}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ direction }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not update vote.');
        }
        allRequests = Array.isArray(data.requests) ? data.requests : allRequests;
        if (Array.isArray(data.categories)) {
            categories = data.categories;
        }
        renderRequests();
    }

    async function submitRequest(text, category, details) {
        const res = await fetch('/api/feature-requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ text, category, details: details || '' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not add feature request.');
        }
        if (Array.isArray(data.requests)) {
            allRequests = data.requests;
        }
        return data;
    }

    function addMilestoneRow(itemEl) {
        const list = itemEl.querySelector('.requests-milestones');
        if (!list) return;
        const li = document.createElement('li');
        li.className = 'requests-milestone';
        li.setAttribute('data-milestone-id', `draft-${Date.now()}`);
        li.innerHTML = `
            <label class="requests-milestone-check">
                <input type="checkbox" data-field="milestone-completed">
                <span class="requests-milestone-text"></span>
            </label>
            <input type="text" class="requests-milestone-input" value="" placeholder="Milestone">
            <button type="button" class="requests-milestone-remove" data-action="remove-milestone" aria-label="Remove milestone">×</button>
        `;
        list.appendChild(li);
        li.querySelector('.requests-milestone-input')?.focus();
    }

    function wireEvents() {
        if (pageHost?.dataset.requestsBound) return;
        if (pageHost) pageHost.dataset.requestsBound = '1';

    tabsEl?.addEventListener('contextmenu', (event) => {
        if (!canManage) return;
        const tab = event.target.closest('[data-tab-id]');
        if (!tab) return;
        const tabId = tab.getAttribute('data-tab-id');
        if (!tabId || tabId === UNASSIGNED_TAB || tabId === 'done') return;
        event.preventDefault();
        const cat = categories.find((row) => row.id === tabId);
        if (!cat) return;
        if (window.confirm(`Hide “${cat.label}” tab?\n\nRequests will be unassigned and only show under Unassigned.`)) {
            void hideTab(tabId);
            return;
        }
        if (window.confirm(`Permanently delete “${cat.label}” tab?\n\nRequests will be unassigned and only show under Unassigned.`)) {
            void deleteTab(tabId);
        }
    });

    tabsEl?.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-tab-id]');
        if (!tab) return;
        activeTab = tab.getAttribute('data-tab-id') || UNASSIGNED_TAB;
        if (activeTab !== 'done' && activeTab !== UNASSIGNED_TAB) {
            setFormCategorySelect(activeTab);
        }
        renderRequests();
    });

    tabAddEl?.addEventListener('click', () => {
        void createTab();
    });

    doneToggleEl?.addEventListener('click', () => {
        activeTab = activeTab === 'done' ? resolveDefaultActiveTab() : 'done';
        renderRequests();
    });

    categoryEl?.addEventListener('focus', () => {
        if (categoryEl.value !== CREATE_TAB_VALUE) {
            categoryEl.dataset.lastValue = categoryEl.value;
        }
    });

    categoryEl?.addEventListener('change', () => {
        void handleCategorySelectChange(categoryEl);
    });

    addToggleEl?.addEventListener('click', () => {
        if (!formOpen) {
            const cat = activeTab !== UNASSIGNED_TAB && activeTab !== 'done' ? activeTab : '';
            setFormCategorySelect(cat);
        }
        setFormOpen(!formOpen);
    });

    addDescriptionBtn?.addEventListener('click', () => {
        setDescriptionOpen(true);
    });

    formEl?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = String(titleEl?.value || '').trim();
        const details = descriptionOpen ? String(descriptionEl?.value || '').trim() : '';
        if (!text) return;
        showError('');
        showSuccess('');
        if (submitEl) submitEl.disabled = true;
        try {
            const categoryValue = categoryEl?.value ?? '';
            const category = categoryValue && categoryValue !== CREATE_TAB_VALUE ? categoryValue : null;
            const data = await submitRequest(text, category, details);
            if (category) activeTab = category;
            expandedId = data.request?.id || null;
            setFormCategorySelect(category || '');
            setFormOpen(false);
            showSuccess('Request added. The team has been emailed.');
            renderRequests();
        } catch (error) {
            showError(error.message || 'Could not add request.');
        } finally {
            if (submitEl) submitEl.disabled = false;
        }
    });

    listEl?.addEventListener('change', (event) => {
        const select = event.target.closest('[data-field="category"]');
        if (!select) return;
        void handleCategorySelectChange(select);
    });

    listEl?.addEventListener('click', async (event) => {
        const voteUpBtn = event.target.closest('[data-action="vote-up"]');
        if (voteUpBtn) {
            const requestId = voteUpBtn.getAttribute('data-request-id');
            if (requestId) {
                void toggleVote(requestId, 'up').catch((error) => showError(error.message));
            }
            return;
        }

        const voteDownBtn = event.target.closest('[data-action="vote-down"]');
        if (voteDownBtn) {
            const requestId = voteDownBtn.getAttribute('data-request-id');
            if (requestId) {
                void toggleVote(requestId, 'down').catch((error) => showError(error.message));
            }
            return;
        }

        const expandBtn = event.target.closest('[data-action="expand"]');
        if (expandBtn) {
            if (panelAnimating) return;
            const item = expandBtn.closest('[data-request-id]');
            const id = item?.getAttribute('data-request-id');
            if (!id) return;
            panelAnimating = true;
            try {
                if (expandedId === id) {
                    await closePanelElement(item?.querySelector('.requests-item-panel'));
                    expandedId = null;
                    renderRequests();
                    return;
                }
                if (expandedId) {
                    const oldItem = listEl.querySelector(`[data-request-id="${CSS.escape(expandedId)}"]`);
                    await closePanelElement(oldItem?.querySelector('.requests-item-panel'));
                }
                expandedId = id;
                renderRequests();
                const panel = listEl.querySelector(
                    `[data-request-id="${CSS.escape(id)}"] .requests-item-panel`
                );
                if (panel) {
                    await wait(20);
                    panel.classList.add('is-open');
                    listEl.querySelector(`[data-request-id="${CSS.escape(id)}"] .requests-panel-details`)?.focus();
                }
            } finally {
                panelAnimating = false;
            }
            return;
        }

        const addBtn = event.target.closest('[data-action="add-milestone"]');
        if (addBtn) {
            if (!canManage) return;
            const item = addBtn.closest('[data-request-id]');
            if (item) addMilestoneRow(item);
            return;
        }

        const removeBtn = event.target.closest('[data-action="remove-milestone"]');
        if (removeBtn) {
            removeBtn.closest('.requests-milestone')?.remove();
            return;
        }

        const saveBtn = event.target.closest('[data-action="save"]');
        if (!saveBtn || saveBtn.disabled) return;
        if (!canManage) return;
        const item = saveBtn.closest('[data-request-id]');
        const id = item?.getAttribute('data-request-id');
        if (!item || !id) return;
        const statusEl = item.querySelector('[data-role="save-status"]');
        saveBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Saving…';
        showError('');
        try {
            const body = readPanelState(item);
            await patchRequest(id, body);
            expandedId = id;
            if (statusEl) statusEl.textContent = 'Saved';
            renderRequests();
            window.setTimeout(() => {
                if (statusEl) statusEl.textContent = '';
            }, 1800);
        } catch (error) {
            if (statusEl) statusEl.textContent = '';
            showError(error.message || 'Save failed.');
        } finally {
            saveBtn.disabled = false;
        }
    });

    listEl?.addEventListener('input', (event) => {
        const input = event.target.closest('.requests-milestone-input');
        if (!input) return;
        const row = input.closest('.requests-milestone');
        const preview = row?.querySelector('.requests-milestone-text');
        if (preview) preview.textContent = input.value;
    });
    }

    async function mount(host) {
        pageHost = host;
        host.innerHTML = REQUESTS_PANEL_HTML;
        bindDom(host);
        wireEvents();
        categories = [];
        priorities = [];
        allRequests = [];
        canManage = false;
        activeTab = null;
        expandedId = null;
        formOpen = false;
        descriptionOpen = false;
        return loadRequests().catch((error) => {
            if (listEl) listEl.innerHTML = '';
            showError(error.message || 'Load failed.');
        });
    }

    function unmount() {
        pageHost = null;
    }

    global.FeatureRequestsView = { mount, unmount };

    if (!global.__APP_SHELL__ && document.getElementById('requests-mount')) {
        void mount(document.getElementById('requests-mount'));
    }
})(window);
