(function (global) {
    function questionGroupKey(sectionId, groupName) {
        return `${sectionId}::${groupName}`;
    }

    function questionGroupDomId(groupKey) {
        return `dfsc-grp-${groupKey.replace(/[^a-zA-Z0-9]+/g, '-')}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function pageScrollY() {
        return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    function setPageScrollY(y) {
        window.scrollTo(0, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
    }

    function questionCardIsVisible(el) {
        if (!el) return false;
        const groupBody = el.closest('.dfsc-group-body');
        if (groupBody?.hasAttribute('hidden')) return false;
        return el.getBoundingClientRect().height > 0;
    }

    function createController({ isAnswerEmpty, isQuestionResolved, excludeProgressTypes = ['banner'] } = {}) {
        if (typeof isAnswerEmpty !== 'function') {
            throw new Error('AuditQuestionGroupsUi.createController requires isAnswerEmpty');
        }

        const collapsedGroups = new Set();

        function isQuestionComplete(question, sess) {
            if (typeof isQuestionResolved === 'function') {
                return isQuestionResolved(question, sess);
            }
            return !isAnswerEmpty(question, sess?.answers?.[question.id]);
        }

        function groupProgress(questions, session) {
            const items = questions.filter((q) => !excludeProgressTypes.includes(q.type));
            const required = items.filter((q) => q.required !== false);
            const answered = required.filter((q) => isQuestionComplete(q, session)).length;
            return { answered, total: required.length };
        }

        function groupForQuestion(schema, questionId) {
            const question = (schema?.questions || []).find((q) => q.id === questionId);
            return question?.group || null;
        }

        function expandQuestionGroup(schema, questionId) {
            const question = (schema?.questions || []).find((q) => q.id === questionId);
            if (!question?.group) return;
            collapsedGroups.delete(questionGroupKey(question.section, question.group));
        }

        function orderedQuestionGroups(sectionId, visibleQuestions) {
            const groups = [];
            for (const question of visibleQuestions(sectionId)) {
                if (question.group && !groups.includes(question.group)) groups.push(question.group);
            }
            return groups;
        }

        function autoCollapseCompletedGroups({ sectionId, activeQuestionId = null, schema, session, visibleQuestions }) {
            if (!sectionId || typeof visibleQuestions !== 'function') return;
            if (global.AuditPreferences?.isAutoCollapseEnabled?.() === false) return;
            const activeGroup = activeQuestionId ? groupForQuestion(schema, activeQuestionId) : null;
            const groupOrder = orderedQuestionGroups(sectionId, visibleQuestions);
            const activeGroupIndex = activeGroup ? groupOrder.indexOf(activeGroup) : -1;
            const questions = visibleQuestions(sectionId);
            let index = 0;
            let groupIndex = 0;
            while (index < questions.length) {
                const question = questions[index];
                if (!question.group) {
                    index += 1;
                    continue;
                }
                const groupName = question.group;
                const groupQuestions = [];
                while (index < questions.length && questions[index].group === groupName) {
                    groupQuestions.push(questions[index]);
                    index += 1;
                }
                const key = questionGroupKey(sectionId, groupName);
                const progress = groupProgress(groupQuestions, session);
                const complete = progress.total > 0 && progress.answered === progress.total;
                const isFutureGroup = activeGroupIndex >= 0 && groupIndex > activeGroupIndex;

                if (!complete) {
                    collapsedGroups.delete(key);
                    groupIndex += 1;
                    continue;
                }
                if (isFutureGroup) {
                    groupIndex += 1;
                    continue;
                }
                collapsedGroups.add(key);
                groupIndex += 1;
            }
        }

        function captureScrollAnchor(questionId) {
            if (!questionId) return null;
            const el = document.querySelector(`[data-question-id="${CSS.escape(questionId)}"]`);
            if (!el) return null;
            const groupEl = el.closest('.dfsc-group');
            const rect = el.getBoundingClientRect();
            return {
                questionId,
                groupKey: groupEl?.dataset?.groupKey || null,
                offsetTop: rect.top + pageScrollY(),
                scrollY: pageScrollY(),
            };
        }

        function scrollAnchorElement(snapshot) {
            let el = document.querySelector(`[data-question-id="${CSS.escape(snapshot.questionId)}"]`);
            if (el && questionCardIsVisible(el)) return el;
            if (snapshot.groupKey) {
                return document.querySelector(
                    `.dfsc-group[data-group-key="${CSS.escape(snapshot.groupKey)}"] .dfsc-subsection-toggle`
                );
            }
            return el;
        }

        function restoreScrollAnchor(snapshot) {
            if (!snapshot?.questionId) return;
            const apply = () => {
                if (Number.isFinite(snapshot.scrollY)) {
                    setPageScrollY(snapshot.scrollY);
                }
                const el = scrollAnchorElement(snapshot);
                if (!el) return;
                const nextOffset = el.getBoundingClientRect().top + pageScrollY();
                const delta = nextOffset - snapshot.offsetTop;
                if (Math.abs(delta) > 0.5) {
                    setPageScrollY(pageScrollY() + delta);
                }
            };
            apply();
            requestAnimationFrame(() => requestAnimationFrame(apply));
        }

        function toggleQuestionGroup(groupKey) {
            if (collapsedGroups.has(groupKey)) {
                collapsedGroups.delete(groupKey);
            } else {
                collapsedGroups.add(groupKey);
            }
            const wrap = document.querySelector(`.dfsc-group[data-group-key="${CSS.escape(groupKey)}"]`);
            const btn = wrap?.querySelector('[data-toggle-group]');
            const body = wrap?.querySelector('.dfsc-group-body');
            const collapsed = collapsedGroups.has(groupKey);
            wrap?.classList.toggle('is-collapsed', collapsed);
            btn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            body?.toggleAttribute('hidden', collapsed);
        }

        function renderGroupShell({ sectionId, groupName, groupQuestions, session, renderQuestion }) {
            const key = questionGroupKey(sectionId, groupName);
            const domId = questionGroupDomId(key);
            const collapsed = collapsedGroups.has(key);
            const progress = groupProgress(groupQuestions, session);
            const complete = progress.total > 0 && progress.answered === progress.total;
            const banners = groupQuestions.filter((q) => excludeProgressTypes.includes(q.type));
            const items = groupQuestions.filter((q) => !excludeProgressTypes.includes(q.type));
            const bannerHtml = banners.map((q) => renderQuestion(q)).join('');
            const body = items.map((q) => renderQuestion(q)).join('');

            return `
                ${bannerHtml}
                <div class="dfsc-group${collapsed ? ' is-collapsed' : ''}" data-group-key="${escapeHtml(key)}">
                    <button type="button" class="dfsc-subsection dfsc-subsection-toggle"
                        data-toggle-group="${escapeHtml(key)}"
                        aria-expanded="${collapsed ? 'false' : 'true'}"
                        aria-controls="${escapeHtml(domId)}">
                        <span class="dfsc-subsection-progress${complete ? ' is-complete' : ''}">${progress.answered}/${progress.total}</span>
                        <span class="dfsc-subsection-title">${escapeHtml(groupName)}</span>
                        <span class="dfsc-subsection-chevron" aria-hidden="true"></span>
                    </button>
                    <div class="dfsc-group-body" id="${escapeHtml(domId)}"${collapsed ? ' hidden' : ''}>
                        ${body}
                    </div>
                </div>`;
        }

        return {
            collapsedGroups,
            questionGroupKey,
            questionGroupDomId,
            groupProgress,
            expandQuestionGroup,
            autoCollapseCompletedGroups,
            toggleQuestionGroup,
            captureScrollAnchor,
            restoreScrollAnchor,
            renderGroupShell,
            pageScrollY,
            setPageScrollY,
        };
    }

    global.AuditQuestionGroupsUi = {
        questionGroupKey,
        questionGroupDomId,
        createController,
    };
})(window);
