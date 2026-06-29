(function (global) {
    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function defaultDueDate(context) {
        return String(context?.defaultActionDueDate || '').trim();
    }

    function resolveDueDate(entry, context) {
        const fromEntry = String(entry?.dueDate || '').trim();
        if (fromEntry) return fromEntry;
        return defaultDueDate(context);
    }

    function renderDueDateField(questionId, entry, context) {
        const value = resolveDueDate(entry, context);
        return `
            <label class="dfsc-action-due">
                <span class="dfsc-action-due__label">Due date</span>
                <input class="dfsc-input dfsc-input--date" type="date"
                    data-action-due-qid="${escapeHtml(questionId)}"
                    value="${escapeHtml(value)}" />
            </label>`;
    }

    function readDueDateFromDom(questionId) {
        const input = document.querySelector(`[data-action-due-qid="${CSS.escape(questionId)}"]`);
        return String(input?.value || '').trim();
    }

    global.AuditActionForm = {
        defaultDueDate,
        resolveDueDate,
        renderDueDateField,
        readDueDateFromDom,
    };
})(window);
