(function () {
    const bodyEl = document.getElementById('changelog-body');
    const versionEl = document.getElementById('changelog-version');

    if (window.DashboardNavBack) {
        window.DashboardNavBack.mountBackButton(document.getElementById('changelog-back'), {
            fallback: '/login',
        });
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function inlineMarkdown(text) {
        return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }

    function renderMarkdown(md) {
        const lines = String(md || '').split(/\r?\n/);
        const parts = [];
        let inList = false;

        function closeList() {
            if (inList) {
                parts.push('</ul>');
                inList = false;
            }
        }

        for (const raw of lines) {
            const line = raw.trimEnd();
            if (!line.trim()) {
                closeList();
                continue;
            }
            if (/^---+$/.test(line.trim())) {
                closeList();
                parts.push('<hr>');
                continue;
            }
            if (line.startsWith('### ')) {
                closeList();
                parts.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
                continue;
            }
            if (line.startsWith('## ')) {
                closeList();
                parts.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
                continue;
            }
            if (line.startsWith('# ')) {
                closeList();
                parts.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
                continue;
            }
            if (/^[-*]\s+/.test(line)) {
                if (!inList) {
                    parts.push('<ul>');
                    inList = true;
                }
                parts.push(`<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`);
                continue;
            }
            if (/^\|.+\|$/.test(line.trim())) {
                closeList();
                parts.push(`<p class="changelog-table-line">${inlineMarkdown(line)}</p>`);
                continue;
            }
            closeList();
            parts.push(`<p>${inlineMarkdown(line)}</p>`);
        }
        closeList();
        return parts.join('\n');
    }

    async function loadChangelog() {
        try {
            const res = await fetch('/api/dashboard/changelog', { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Could not load changelog.');
            }
            if (versionEl && data.version) {
                versionEl.textContent = data.version;
            }
            if (bodyEl) {
                bodyEl.innerHTML = renderMarkdown(data.markdown);
            }
        } catch (err) {
            if (bodyEl) {
                bodyEl.innerHTML = `<p class="changelog-error">${escapeHtml(err.message || 'Load failed.')}</p>`;
            }
        }
    }

    loadChangelog();
})();
