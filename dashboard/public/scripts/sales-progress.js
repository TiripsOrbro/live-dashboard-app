/**
 * Live sales progress layers — same palette and layout as dashboard hourly cells.
 */
(function () {
    const paceFillMap = {
        'cell-green': 'var(--good)',
        'cell-orange': 'var(--near)',
        'cell-red': 'var(--bad)',
    };

    const paceBorderMap = {
        'cell-green': 'var(--good-border)',
        'cell-orange': 'var(--near-border)',
        'cell-red': 'var(--bad-border)',
    };

    function clampPercent(value) {
        return Math.max(0, Math.min(100, Number(value) || 0));
    }

    function paceFillPercentFromProgress(progress) {
        if (!progress) return 0;
        if (progress.phase === 'after') return 100;
        return clampPercent(progress.timeFillPercent);
    }

    function buildLiveProgressLayersHtml(timeFillPercent, outcomeClass, paceClass) {
        const p = clampPercent(timeFillPercent);
        const mainBg = paceFillMap[outcomeClass] || 'var(--blank)';
        const paceBg = paceFillMap[paceClass] || 'var(--bad)';
        return `<div class="grid-cell-live-layers" aria-hidden="true">
        <div class="grid-cell-live-main-frame">
            <div class="grid-cell-live-main-fill" style="width: ${p}%; background-color: ${mainBg};"></div>
        </div>
        <div class="grid-cell-live-pace-row">
            <div class="grid-cell-live-pace-grow" style="width: ${p}%;">
                <div class="grid-cell-live-pace-bar" style="border-top: var(--cell-border) ${paceBg}; background-color: ${paceBg};"></div>
            </div>
        </div>
    </div>`;
    }

    /** Bottom pace strip only (no outcome / forecast fill layer). */
    function buildPaceStripHtml(timeFillPercent, paceClass) {
        const p = clampPercent(timeFillPercent);
        const paceBg = paceFillMap[paceClass] || 'var(--bad)';
        return `<div class="grid-cell-live-layers mic-pace-strip-layers" aria-hidden="true">
            <div class="grid-cell-live-pace-row">
                <div class="grid-cell-live-pace-grow" style="width: ${p}%;">
                    <div class="grid-cell-live-pace-bar" style="background-color: ${paceBg};"></div>
                </div>
            </div>
        </div>`;
    }

    window.SalesProgress = {
        paceFillMap,
        paceBorderMap,
        paceFillPercentFromProgress,
        buildLiveProgressLayersHtml,
        buildPaceStripHtml,
    };
})();
