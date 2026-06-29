(function (global) {
    const PANEL_HTML = `
        <div class="requests-view bug-reports-view">
            <header class="admin-section-header requests-view-header">
                <div class="requests-view-header-row">
                    <div>
                        <h2>Report a bug</h2>
                        <p class="admin-section-subtitle">Upvote bugs others reported to raise important ones. Photos are removed when a bug is marked fixed.</p>
                    </div>
                    <button type="button" id="bug-reports-add-toggle" class="requests-add-toggle" aria-label="Report bug" aria-expanded="false" title="Report bug">
                        <svg class="requests-add-toggle-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                            <path fill="currentColor" d="M12 5c.55 0 1 .45 1 1v5h5c.55 0 1 .45 1 1s-.45 1-1 1h-5v5c0 .55-.45 1-1 1s-1-.45-1-1v-5H6c-.55 0-1-.45-1-1s.45-1 1-1h5V6c0-.55.45-1 1-1z"/>
                        </svg>
                    </button>
                </div>
            </header>
            <div id="bug-reports-form-wrap" class="requests-form-wrap">
                <form id="bug-reports-form" class="requests-form">
                    <input id="bug-reports-title" name="title" type="text" class="requests-form-title" placeholder="What went wrong?" maxlength="200" required autocomplete="off">
                    <textarea id="bug-reports-details" name="details" rows="3" placeholder="Steps to reproduce, what you expected, etc."></textarea>
                    <div class="bug-reports-photo-field">
                        <label class="requests-panel-label" for="bug-reports-photos">Photos (optional)</label>
                        <input id="bug-reports-photos" class="bug-reports-photo-input" type="file" accept="image/*" multiple>
                        <p class="bug-reports-photo-hint">Up to 5 images, 2 MB each.</p>
                        <div id="bug-reports-photo-preview" class="bug-reports-photo-preview" hidden></div>
                    </div>
                    <div class="requests-form-footer">
                        <button type="submit" class="requests-submit mic-settings-btn mic-settings-btn--primary">Submit bug</button>
                    </div>
                </form>
            </div>
            <p id="bug-reports-success" class="requests-success" role="status" hidden></p>
            <div id="bug-reports-list" class="requests-list" aria-live="polite">Loading…</div>
            <p id="bug-reports-empty" class="requests-empty" hidden>No open bugs yet.</p>
            <p id="bug-reports-error" class="requests-error" role="alert" hidden></p>
            <div class="admin-settings-segmented-tabs requests-done-bar">
                <div class="admin-accounts-scope-row-wrap">
                    <div class="admin-accounts-scope-row admin-accounts-scope-row--equal requests-done-row" style="--scope-cols: 1">
                        <button type="button" id="bug-reports-fixed-toggle" class="admin-accounts-scope-chip requests-done-toggle" aria-pressed="false" role="tab">Fixed</button>
                    </div>
                </div>
            </div>
        </div>`;

    let pageHost = null;
    let formWrapEl;
    let formEl;
    let addToggleEl;
    let titleEl;
    let detailsEl;
    let photosEl;
    let photoPreviewEl;
    let listEl;
    let emptyEl;
    let errorEl;
    let successEl;
    let fixedToggleEl;

    let allBugs = [];
    let canManage = false;
    let viewerUsername = '';
    let showFixed = false;
    let expandedId = null;
    let formOpen = false;
    let pendingPhotos = [];

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

    function showError(message) {
        if (!errorEl) return;
        if (message) {
            errorEl.textContent = message;
            errorEl.hidden = false;
        } else {
            errorEl.textContent = '';
            errorEl.hidden = true;
        }
    }

    function showSuccess(message) {
        if (!successEl) return;
        if (message) {
            successEl.textContent = message;
            successEl.hidden = false;
        } else {
            successEl.textContent = '';
            successEl.hidden = true;
        }
    }

    function setFormOpen(open) {
        formOpen = open;
        formWrapEl?.classList.toggle('is-open', open);
        addToggleEl?.classList.toggle('is-active', open);
        addToggleEl?.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
            reader.readAsDataURL(file);
        });
    }

    async function refreshPhotoPreview() {
        if (!photoPreviewEl) return;
        const files = Array.from(photosEl?.files || []).slice(0, 5);
        pendingPhotos = [];
        for (const file of files) {
            pendingPhotos.push(await readFileAsDataUrl(file));
        }
        if (!pendingPhotos.length) {
            photoPreviewEl.innerHTML = '';
            photoPreviewEl.hidden = true;
            return;
        }
        photoPreviewEl.hidden = false;
        photoPreviewEl.innerHTML = pendingPhotos
            .map(
                (src, index) =>
                    `<div class="bug-reports-photo-thumb" aria-label="Photo ${index + 1}"><img src="${escapeAttr(src)}" alt=""></div>`
            )
            .join('');
    }

    function visibleBugs() {
        return allBugs.filter((bug) => Boolean(bug.fixed) === showFixed);
    }

    function formatWhen(iso) {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
            });
        } catch {
            return '';
        }
    }

    function photoUrl(bugId, photoId) {
        return `/api/bug-reports/${encodeURIComponent(bugId)}/photos/${encodeURIComponent(photoId)}`;
    }

    function buildItemHtml(bug) {
        const expanded = bug.id === expandedId;
        const photos = Array.isArray(bug.photos) ? bug.photos : [];
        const photoHtml = photos.length
            ? `<div class="bug-reports-item-photos">${photos
                  .map(
                      (photo) =>
                          `<a class="bug-reports-item-photo-link" href="${escapeAttr(photoUrl(bug.id, photo.id))}" target="_blank" rel="noopener noreferrer"><img src="${escapeAttr(photoUrl(bug.id, photo.id))}" alt="Bug screenshot"></a>`
                  )
                  .join('')}</div>`
            : '';
        const adminHtml =
            canManage && !bug.fixed
                ? `<div class="bug-reports-admin-row">
                        <label><input type="checkbox" data-action="mark-fixed" data-bug-id="${escapeAttr(bug.id)}"> Mark as fixed</label>
                   </div>`
                : '';
        return `
            <article class="requests-item bug-reports-item${expanded ? ' is-expanded' : ''}" data-bug-id="${escapeAttr(bug.id)}">
                <button
                    type="button"
                    class="bug-reports-upvote${bug.upvotedByViewer ? ' is-active' : ''}"
                    data-action="upvote"
                    data-bug-id="${escapeAttr(bug.id)}"
                    aria-label="${bug.upvotedByViewer ? 'Remove upvote' : 'Upvote'}"
                    ${bug.fixed ? 'disabled' : ''}>
                    <span class="bug-reports-upvote-icon" aria-hidden="true">▲</span>
                    <span class="bug-reports-upvote-count">${Number(bug.upvoteCount) || 0}</span>
                </button>
                <div class="bug-reports-item-main">
                    <button type="button" class="requests-item-header" data-action="expand" aria-expanded="${expanded ? 'true' : 'false'}">
                        <span class="requests-item-text">${escapeHtml(bug.title)}</span>
                    </button>
                    <div class="requests-item-panel">
                        ${bug.details ? `<p class="requests-panel-details bug-reports-details">${escapeHtml(bug.details).replace(/\n/g, '<br>')}</p>` : '<p class="requests-panel-details bug-reports-details">No extra details.</p>'}
                        ${photoHtml}
                        <p class="bug-reports-item-meta">Reported by ${escapeHtml(bug.submittedByName || bug.submittedBy || 'Unknown')}${bug.createdAt ? ` · ${escapeHtml(formatWhen(bug.createdAt))}` : ''}</p>
                        ${adminHtml}
                    </div>
                </div>
            </article>`;
    }

    function renderList() {
        const rows = visibleBugs();
        if (!listEl) return;
        if (!rows.length) {
            listEl.innerHTML = '';
            if (emptyEl) {
                emptyEl.textContent = showFixed ? 'No fixed bugs yet.' : 'No open bugs yet.';
                emptyEl.hidden = false;
            }
            return;
        }
        if (emptyEl) emptyEl.hidden = true;
        listEl.innerHTML = rows.map((bug) => buildItemHtml(bug)).join('');
        if (expandedId) {
            const panel = listEl.querySelector(`[data-bug-id="${CSS.escape(expandedId)}"] .requests-item-panel`);
            if (panel) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => panel.classList.add('is-open'));
                });
            }
        }
        fixedToggleEl?.setAttribute('aria-pressed', showFixed ? 'true' : 'false');
        fixedToggleEl?.classList.toggle('is-active', showFixed);
    }

    async function loadBugs() {
        showError('');
        if (listEl) listEl.textContent = 'Loading…';
        const res = await fetch('/api/bug-reports', { credentials: 'same-origin', cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not load bug reports.');
        }
        allBugs = Array.isArray(data.bugs) ? data.bugs : [];
        canManage = Boolean(data.canManage);
        viewerUsername = String(data.viewerUsername || '');
        renderList();
    }

    async function submitBug(title, details, photos) {
        const res = await fetch('/api/bug-reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ title, details, photos }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not submit bug report.');
        }
        allBugs = Array.isArray(data.bugs) ? data.bugs : allBugs;
        return data;
    }

    async function toggleUpvote(bugId) {
        const res = await fetch(`/api/bug-reports/${encodeURIComponent(bugId)}/upvote`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not update upvote.');
        }
        allBugs = Array.isArray(data.bugs) ? data.bugs : allBugs;
        renderList();
    }

    async function markFixed(bugId) {
        const res = await fetch(`/api/bug-reports/${encodeURIComponent(bugId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ fixed: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Could not mark bug as fixed.');
        }
        allBugs = Array.isArray(data.bugs) ? data.bugs : allBugs;
        if (expandedId === bugId) expandedId = null;
        renderList();
        showSuccess('Bug marked as fixed. Photos removed.');
    }

    function wireEvents() {
        if (pageHost?.dataset.bugReportsBound) return;
        if (pageHost) pageHost.dataset.bugReportsBound = '1';

        addToggleEl?.addEventListener('click', () => {
            setFormOpen(!formOpen);
            if (formOpen) titleEl?.focus();
        });

        photosEl?.addEventListener('change', () => {
            void refreshPhotoPreview().catch((error) => showError(error.message));
        });

        formEl?.addEventListener('submit', (event) => {
            event.preventDefault();
            const title = String(titleEl?.value || '').trim();
            const details = String(detailsEl?.value || '').trim();
            const submitBtn = formEl.querySelector('.requests-submit');
            if (submitBtn) submitBtn.disabled = true;
            showError('');
            showSuccess('');
            void submitBug(title, details, pendingPhotos)
                .then(() => {
                    formEl.reset();
                    pendingPhotos = [];
                    if (photoPreviewEl) {
                        photoPreviewEl.innerHTML = '';
                        photoPreviewEl.hidden = true;
                    }
                    setFormOpen(false);
                    showFixed = false;
                    renderList();
                    showSuccess('Bug reported. The team has been emailed.');
                })
                .catch((error) => showError(error.message || 'Could not submit bug.'))
                .finally(() => {
                    if (submitBtn) submitBtn.disabled = false;
                });
        });

        fixedToggleEl?.addEventListener('click', () => {
            showFixed = !showFixed;
            expandedId = null;
            renderList();
        });

        listEl?.addEventListener('click', (event) => {
            const upvoteBtn = event.target.closest('[data-action="upvote"]');
            if (upvoteBtn) {
                event.preventDefault();
                const bugId = upvoteBtn.getAttribute('data-bug-id');
                if (!bugId) return;
                void toggleUpvote(bugId).catch((error) => showError(error.message));
                return;
            }

            const fixedCheckbox = event.target.closest('[data-action="mark-fixed"]');
            if (fixedCheckbox?.checked) {
                const bugId = fixedCheckbox.getAttribute('data-bug-id');
                if (!bugId) return;
                if (!window.confirm('Mark this bug as fixed? Photos will be permanently removed.')) {
                    fixedCheckbox.checked = false;
                    return;
                }
                void markFixed(bugId).catch((error) => {
                    fixedCheckbox.checked = false;
                    showError(error.message);
                });
                return;
            }

            const expandBtn = event.target.closest('[data-action="expand"]');
            if (!expandBtn) return;
            const item = expandBtn.closest('[data-bug-id]');
            const bugId = item?.getAttribute('data-bug-id');
            if (!bugId) return;
            expandedId = expandedId === bugId ? null : bugId;
            renderList();
        });
    }

    function bindDom(root) {
        formWrapEl = root.querySelector('#bug-reports-form-wrap');
        formEl = root.querySelector('#bug-reports-form');
        addToggleEl = root.querySelector('#bug-reports-add-toggle');
        titleEl = root.querySelector('#bug-reports-title');
        detailsEl = root.querySelector('#bug-reports-details');
        photosEl = root.querySelector('#bug-reports-photos');
        photoPreviewEl = root.querySelector('#bug-reports-photo-preview');
        listEl = root.querySelector('#bug-reports-list');
        emptyEl = root.querySelector('#bug-reports-empty');
        errorEl = root.querySelector('#bug-reports-error');
        successEl = root.querySelector('#bug-reports-success');
        fixedToggleEl = root.querySelector('#bug-reports-fixed-toggle');
    }

    async function mount(host) {
        pageHost = host;
        host.innerHTML = PANEL_HTML;
        bindDom(host);
        wireEvents();
        allBugs = [];
        canManage = false;
        showFixed = false;
        expandedId = null;
        formOpen = false;
        pendingPhotos = [];
        return loadBugs().catch((error) => {
            if (listEl) listEl.innerHTML = '';
            showError(error.message || 'Load failed.');
        });
    }

    function unmount() {
        pageHost = null;
    }

    global.BugReportsView = { mount, unmount };
})(window);
