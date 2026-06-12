/**
 * Register standard period-audit API routes on an Express app.
 */
function registerPeriodAuditRoutes(app, config) {
    const {
        auditType,
        coachOnly = false,
        storeModule,
        assertStoreAccess,
        assertDfscAccess,
        assertCanStartAudit,
        assertCoachAuditAccess,
        dfscRequestUserContext,
        assertSessionAccess,
    } = config;

    const apiPrefix = `/api/${auditType}`;
    const logLabel = auditType;

    function coachGate(req, res) {
        if (!coachOnly) return true;
        return assertCoachAuditAccess(req, res);
    }

    app.get(`${apiPrefix}/context`, (req, res) => {
        try {
            const store = String(req.query.store || '').trim();
            if (!store || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            res.json({
                success: true,
                auditType,
                ...storeModule.getContext(store, {
                    username: ctx.username,
                    conductorFullName: ctx.conductorFullName,
                    accountLevel: ctx.accountLevel,
                    canAccessDfsc: ctx.canAccessDfsc,
                    canCompleteAudits: ctx.canCompleteAudits,
                    canStartAudits: ctx.canStartAudits,
                    isAdmin: ctx.isAdmin,
                }),
            });
        } catch (error) {
            console.error(`API: Error loading ${logLabel} context:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get(`${apiPrefix}/open`, (req, res) => {
        try {
            const store = String(req.query.store || '').trim();
            if (!store || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            res.json({ success: true, openAudits: storeModule.listOpenAudits(store, { access: ctx.access }) });
        } catch (error) {
            console.error(`API: Error listing open ${logLabel} audits:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get(`${apiPrefix}/history`, (req, res) => {
        try {
            const store = String(req.query.store || '').trim();
            const limit = Number(req.query.limit) || 50;
            if (!store || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            res.json({ success: true, history: storeModule.listInspectionHistory(store, { limit }) });
        } catch (error) {
            console.error(`API: Error loading ${logLabel} history:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete(`${apiPrefix}/session`, (req, res) => {
        try {
            const store = String(req.query.store || '').trim();
            const sessionId = String(req.query.sessionId || '').trim();
            if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            const result = storeModule.deleteOpenAudit(store, sessionId, ctx.access);
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({
                success: true,
                deletedId: result.deletedId,
                openAudits: storeModule.listOpenAudits(store, { access: ctx.access }),
            });
        } catch (error) {
            console.error(`API: Error deleting open ${logLabel} audit:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post(`${apiPrefix}/start`, (req, res) => {
        try {
            const store = String(req.body?.store || req.query.store || '').trim();
            if (!store || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            if (!assertCanStartAudit(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            const result = storeModule.createSession(store, {
                name: req.body?.name,
                startSignatureDataUrl: req.body?.startSignatureDataUrl,
                forceNew: Boolean(req.body?.forceNew),
                clientMeta: req.body?.clientMeta,
                createdByUsername: ctx.username,
            });
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({ success: true, session: result.session, resumed: result.resumed });
        } catch (error) {
            console.error(`API: Error starting ${logLabel}:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get(`${apiPrefix}/session`, (req, res) => {
        try {
            const store = String(req.query.store || '').trim();
            const sessionId = String(req.query.sessionId || '').trim();
            if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const session = storeModule.getSessionById(store, sessionId, req.query.periodKey);
            if (!assertSessionAccess(req, res, session)) return;
            const ctx = dfscRequestUserContext(req);
            const canReopen =
                session?.status === 'completed' &&
                storeModule.userOwnsSession(session, ctx.username, ctx.conductorFullName);
            res.json({ success: true, session, canReopen });
        } catch (error) {
            console.error(`API: Error loading ${logLabel} session:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get(`${apiPrefix}/report.pdf`, async (req, res) => {
        try {
            const store = String(req.query.store || '').trim();
            const sessionId = String(req.query.sessionId || '').trim();
            if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const session = storeModule.getSessionById(store, sessionId, req.query.periodKey) || storeModule.findSessionAcrossPeriods(store, sessionId);
            if (!session || session.status !== 'completed') {
                res.status(404).json({ success: false, error: 'Completed session not found.' });
                return;
            }
            const { getAuditTypeConfig } = require('./auditRegistry');
            const cfg = getAuditTypeConfig(auditType);
            const pdf = await cfg.buildPdf(session);
            const filename = cfg.buildFilename(session);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            res.send(pdf);
        } catch (error) {
            console.error(`API: Error generating ${logLabel} report:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post(`${apiPrefix}/reopen`, (req, res) => {
        try {
            const store = String(req.body?.store || req.query.store || '').trim();
            const sessionId = String(req.body?.sessionId || req.query.sessionId || '').trim();
            if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            const result = storeModule.reopenSession(store, sessionId, req.body?.periodKey, ctx.access);
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({ success: true, session: result.session });
        } catch (error) {
            console.error(`API: Error reopening ${logLabel}:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.put(`${apiPrefix}/session`, (req, res) => {
        try {
            const store = String(req.body?.store || req.query.store || '').trim();
            const sessionId = String(req.body?.sessionId || '').trim();
            if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            const result = storeModule.updateSession(store, sessionId, req.body || {}, ctx.access);
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({
                success: true,
                session: result.session,
                nonCompliant: result.nonCompliant,
                score: result.score,
            });
        } catch (error) {
            console.error(`API: Error saving ${logLabel} session:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post(`${apiPrefix}/session/validate-section`, (req, res) => {
        try {
            const store = String(req.body?.store || req.query.store || '').trim();
            const sessionId = String(req.body?.sessionId || '').trim();
            const sectionId = String(req.body?.sectionId || '').trim();
            if (!store || !sessionId || !sectionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            const result = storeModule.validateSessionSection(store, sessionId, sectionId, ctx.access);
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({ success: true });
        } catch (error) {
            console.error(`API: Error validating ${logLabel} section:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post(`${apiPrefix}/submit`, async (req, res) => {
        try {
            const store = String(req.body?.store || req.query.store || '').trim();
            const sessionId = String(req.body?.sessionId || '').trim();
            if (!store || !sessionId || !assertStoreAccess(req, res, store)) return;
            if (!assertDfscAccess(req, res)) return;
            if (!coachGate(req, res)) return;
            const ctx = dfscRequestUserContext(req);
            const result = storeModule.submitSession(store, sessionId, req.body?.signOff || {}, ctx.access);
            if (!result.ok) {
                res.status(400).json({ success: false, error: result.error });
                return;
            }
            res.json({ success: true, session: result.session });
        } catch (error) {
            console.error(`API: Error submitting ${logLabel}:`, error);
            res.status(500).json({ success: false, error: error.message });
        }
    });
}

module.exports = { registerPeriodAuditRoutes };
