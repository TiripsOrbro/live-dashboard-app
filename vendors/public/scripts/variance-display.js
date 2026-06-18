/**
 * MMX-style variance table rendering and screenshot capture for stock count flows.
 */
(function varianceDisplayModule(global) {
    const VARIANCE_COLUMNS = [
        { key: 'name', label: 'Item' },
        { key: 'unit', label: 'Unit' },
        { key: 'box', label: 'Box' },
        { key: 'inner', label: 'Inner' },
        { key: 'unitCount', label: 'Unit' },
        { key: 'stockOnHand', label: 'Stock on Hand' },
        { key: 'varianceQty', label: 'Variance' },
        { key: 'varianceValue', label: 'Variance Value' },
    ];

    function parseClosingValue(raw) {
        if (raw == null || raw === '' || raw === '-' || raw === '-') return null;
        const n = Number(String(raw).replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : null;
    }

    function formatQty(value) {
        if (value == null || !Number.isFinite(Number(value))) return '0';
        const n = Number(value);
        if (Number.isInteger(n)) return String(n);
        return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }

    function formatVarianceQty(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '-';
        return n.toLocaleString('en-AU', { maximumFractionDigits: 2 });
    }

    function formatVarianceMoney(value) {
        if (value == null || !Number.isFinite(Number(value))) return '-';
        const n = Number(value);
        const abs = Math.abs(n).toLocaleString('en-AU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
        if (n < 0) return `-$${abs}`;
        return `$${abs}`;
    }

    function inferUnitSlotsFromVariance(variance) {
        const box = parseClosingValue(variance.closingBox);
        const inner = parseClosingValue(variance.closingInner);
        const unit = parseClosingValue(variance.closingUnit);
        return [
            { key: box != null ? 'box' : null, label: 'Box', na: box == null },
            { key: inner != null ? 'bag' : null, label: 'Inner', na: inner == null },
            { key: unit != null ? 'kg' : null, label: 'Unit', na: unit == null },
        ];
    }

    function resolveUnitSlots(item) {
        if (Array.isArray(item.unitSlots) && item.unitSlots.length === 3) return item.unitSlots;
        const cols = Array.isArray(item.columns) ? item.columns : [];
        const slots = cols.map((col) => ({ key: col.key, label: col.label, na: false }));
        while (slots.length < 3) slots.push({ key: null, label: 'N/a', na: true });
        return slots.slice(0, 3);
    }

    function mapVarianceClosingToCounts(item, variance) {
        const counts = {};
        const slots = resolveUnitSlots(item);
        const values = [variance.closingBox, variance.closingInner, variance.closingUnit];
        slots.forEach((slot, idx) => {
            if (slot.na || !slot.key) return;
            const n = parseClosingValue(values[idx]);
            if (n != null && n >= 0) counts[slot.key] = n;
        });
        return counts;
    }

    function buildCatalogsBySlug(catalog) {
        const map = new Map();
        if (!catalog?.items?.length) return map;
        map.set('daily', catalog);
        for (const item of catalog.items) {
            const slug = item.sourceVendorSlug;
            if (!slug || map.has(slug)) continue;
            map.set(slug, {
                ...catalog,
                items: catalog.items.filter((row) => row.sourceVendorSlug === slug),
            });
        }
        return map;
    }

    function resolveVarianceCatalogMatch(variance, catalog) {
        const matcher = global.VarianceCatalogMatch;
        if (!matcher || !catalog) return null;
        const bySlug = buildCatalogsBySlug(catalog);
        if (!bySlug.size) return null;
        return matcher.resolveVarianceCatalogMatch(variance, bySlug);
    }

    function varianceSeverityClass(row) {
        if (row.isRed === false) return ' stock-count-value-box--variance-ok';
        return ' stock-count-value-box--variance-alert';
    }

    function buildClosingCellHtml(slot, counts, escapeHtml) {
        const label = slot.label || 'N/a';
        let display = '0';
        if (!slot.na && slot.key) {
            const value = counts[slot.key];
            if (value != null && Number.isFinite(Number(value))) {
                display = formatQty(value);
            }
        }
        const naClass = slot.na ? ' stock-count-value-box--na' : '';
        return `<td class="stock-count-grid-cell stock-count-grid-cell--variance-value">
            <div class="stock-count-unit-slot">
                <span class="stock-count-unit-label">${escapeHtml(label)}</span>
                <div class="stock-count-value-box stock-count-value-box--variance stock-count-value-box--variance-closing${naClass}">${escapeHtml(display)}</div>
            </div>
        </td>`;
    }

    function buildStatCellHtml(label, display, extraClass, escapeHtml) {
        return `<td class="stock-count-grid-cell stock-count-grid-cell--variance-value">
            <div class="stock-count-unit-slot">
                <span class="stock-count-unit-label">${escapeHtml(label)}</span>
                <div class="stock-count-value-box stock-count-value-box--variance${extraClass}">${escapeHtml(display)}</div>
            </div>
        </td>`;
    }

    function buildVarianceRowHtml(row, catalog, escapeHtml) {
        const match = resolveVarianceCatalogMatch(row, catalog);
        const matcher = global.VarianceCatalogMatch;
        let item = match?.item || null;
        const mmxName = String(row.itemName || '').trim();
        const itemCode = String(row.itemCode || '').trim();

        if (!item) {
            item = {
                key: row.catalogKey || row.itemCode,
                itemCode: row.matchedItemCode || row.itemCode,
                name: mmxName || row.catalogName || row.itemCode || 'Unknown item',
                unitSlots: inferUnitSlotsFromVariance(row),
                columns: inferUnitSlotsFromVariance(row)
                    .filter((slot) => !slot.na && slot.key)
                    .map((slot) => ({ key: slot.key, label: slot.label })),
            };
        } else if (mmxName && matcher && matcher.nameMatchScore(mmxName, item.name) < 45) {
            item = {
                ...item,
                name: mmxName,
                unitSlots: inferUnitSlotsFromVariance(row),
                columns: inferUnitSlotsFromVariance(row)
                    .filter((slot) => !slot.na && slot.key)
                    .map((slot) => ({ key: slot.key, label: slot.label })),
            };
        }

        const displayName = mmxName || item.displayName || item.name || row.catalogName || 'Unknown item';
        const counts = mapVarianceClosingToCounts(item, row);
        const slots = resolveUnitSlots(item).slice(0, 3);
        const closingCells = slots.map((slot) => buildClosingCellHtml(slot, counts, escapeHtml)).join('');
        const severity = varianceSeverityClass(row);
        const unitLabel = String(row.unit || '').trim() || '-';
        const rowClass = row.isRed === false ? 'stock-count-variance-row--ok' : 'stock-count-variance-row--alert';

        const statCells = [
            buildStatCellHtml('Stock on Hand', formatVarianceQty(row.stockCounted), '', escapeHtml),
            buildStatCellHtml(
                'Variance',
                formatVarianceQty(row.varianceQty),
                `${severity} stock-count-value-box--variance-money`,
                escapeHtml
            ),
            buildStatCellHtml(
                'Variance Value',
                formatVarianceMoney(row.varianceValue),
                `${severity} stock-count-value-box--variance-money`,
                escapeHtml
            ),
        ].join('');

        const itemLabel = itemCode
            ? `<span class="stock-count-variance-item-code">${escapeHtml(itemCode)}</span><span class="stock-count-variance-item-name">${escapeHtml(displayName)}</span>`
            : `<span class="stock-count-variance-item-name">${escapeHtml(displayName)}</span>`;

        return `<tr class="stock-count-grid-row stock-count-variance-row ${rowClass}">
            <th scope="row" class="stock-count-grid-name stock-count-variance-item">${itemLabel}</th>
            <td class="stock-count-grid-cell stock-count-grid-cell--variance-unit">${escapeHtml(unitLabel)}</td>
            ${closingCells}
            ${statCells}
        </tr>`;
    }

    function buildHeaderRowHtml(escapeHtml) {
        return `<tr class="stock-count-grid-row stock-count-variance-header-row">
            ${VARIANCE_COLUMNS.map((col) => {
                const nameClass = col.key === 'name' ? ' stock-count-variance-header--name' : '';
                return `<th scope="col" class="stock-count-variance-header${nameClass}">${escapeHtml(col.label)}</th>`;
            }).join('')}
        </tr>`;
    }

    function buildCaptureMetaHtml(meta, escapeHtml) {
        const lines = [];
        if (meta.title) lines.push(`<div class="stock-count-variance-capture-title">${escapeHtml(meta.title)}</div>`);
        const subParts = [];
        if (meta.storeLabel) subParts.push(meta.storeLabel);
        if (meta.dateLabel) subParts.push(meta.dateLabel);
        if (meta.countLabel) subParts.push(meta.countLabel);
        if (subParts.length) {
            lines.push(
                `<div class="stock-count-variance-capture-sub">${escapeHtml(subParts.join(' · '))}</div>`
            );
        }
        if (meta.note) {
            lines.push(`<div class="stock-count-variance-capture-note">${escapeHtml(meta.note)}</div>`);
        }
        return lines.join('');
    }

    function buildTableHtml(variances, { catalog, escapeHtml, captureId, meta = {} }) {
        const rows = (variances || []).map((row) => buildVarianceRowHtml(row, catalog, escapeHtml)).join('');
        if (!rows) return '';

        const tableHtml = `<div class="stock-count-variance-scroll">
            <table class="stock-count-table stock-count-table--entry stock-count-table--connected stock-count-table--variances stock-count-table--variances-mmx">
                <thead>${buildHeaderRowHtml(escapeHtml)}</thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

        if (!captureId) return tableHtml;

        return `<div id="${escapeHtml(captureId)}" class="stock-count-variance-capture">
            ${buildCaptureMetaHtml(meta, escapeHtml)}
            ${tableHtml}
        </div>`;
    }

    async function rasterizeElement(element, options = {}) {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) throw new Error('Nothing to capture.');
        const render = global.html2canvas;
        if (typeof render !== 'function') {
            throw new Error('Screenshot is unavailable - refresh the page and try again.');
        }
        const scale = options.scale ?? Math.min(3, Math.max(2, global.devicePixelRatio || 2));
        return render(element, {
            scale,
            backgroundColor: '#ffffff',
            useCORS: true,
            logging: false,
            scrollX: 0,
            scrollY: -global.scrollY,
            windowWidth: document.documentElement.clientWidth,
            windowHeight: document.documentElement.clientHeight,
        });
    }

    async function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) reject(new Error('Could not create image.'));
                else resolve(blob);
            }, 'image/png');
        });
    }

    async function shareCapture(element, { filename = 'daily-count-variances.png', title = 'Daily count variances' } = {}) {
        const canvas = await rasterizeElement(element);
        const blob = await canvasToBlob(canvas);
        const file = new File([blob], filename, { type: 'image/png' });

        if (global.navigator?.share) {
            const payload = { files: [file], title };
            if (typeof global.navigator.canShare === 'function' && global.navigator.canShare(payload)) {
                await global.navigator.share(payload);
                return { mode: 'shared' };
            }
        }

        const url = URL.createObjectURL(blob);
        try {
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.click();
            return { mode: 'downloaded' };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    global.VarianceDisplay = {
        buildTableHtml,
        shareCapture,
        formatVarianceQty,
        formatVarianceMoney,
    };
})(window);
