const dfscSchema = require('../../audits/Daily Food Safety Check/dfscSchema');
const pestWalkSchema = require('../../audits/Pest Walk/pestWalkSchema');
const rgmCleaningSchema = require('../../audits/RGM Cleaning/rgmCleaningSchema');
const psiSchema = require('../../audits/Periodic Safety Inspection/psiSchema');
const squareOneSchema = require('../../audits/Square One/squareOneSchema');
const coreOpsSchema = require('../../audits/CORE Operations/coreOpsSchema');
const coreFoodSafetySchema = require('../../audits/CORE Food Safety/coreFoodSafetySchema');
const visitCoachSchema = require('../../audits/Visiting as a Coach/visitCoachSchema');
const visitCustomerSchema = require('../../audits/Visiting as a Customer/visitCustomerSchema');

const AUDIT_SCHEMAS = {
    dfsc: dfscSchema,
    'pest-walk': pestWalkSchema,
    'rgm-cleaning': rgmCleaningSchema,
    psi: psiSchema,
    'square-one': squareOneSchema,
    'core-ops': coreOpsSchema,
    'core-food-safety': coreFoodSafetySchema,
    'visit-coach': visitCoachSchema,
    'visit-customer': visitCustomerSchema,
};

const RGM_ACTION_PLAN_FIELDS = [
    ['action_drinkMachines', 'Drink Machines'],
    ['action_drains', 'Drains'],
    ['action_floors', 'Floors'],
    ['action_restrooms', 'Restrooms'],
    ['action_dumpsterBins', 'Dumpster & Bins'],
];

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/i;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getQuestionLabel(auditType, session, questionId) {
    const schema = AUDIT_SCHEMAS[auditType];
    if (!schema?.getQuestionById) return questionId;
    let question = null;
    if (auditType === 'square-one') {
        question = schema.getQuestionById(questionId, session?.areaId);
    } else if (auditType === 'psi') {
        question = schema.getQuestionById(questionId, session?.psiWeek);
    } else {
        question = schema.getQuestionById(questionId);
    }
    return question?.label || questionId;
}

function collectNcRows(auditType, session) {
    const schema = AUDIT_SCHEMAS[auditType];
    if (typeof schema?.collectNonCompliant !== 'function') return [];
    try {
        return schema.collectNonCompliant(session) || [];
    } catch {
        return [];
    }
}

function collectRgmActionPlanEntries(session) {
    const out = [];
    for (const [fieldId, label] of RGM_ACTION_PLAN_FIELDS) {
        const text = String(session?.answers?.[fieldId] || '').trim();
        if (!text) continue;
        out.push({ label, text });
    }
    return out;
}

function rowDetailText(row) {
    const parts = [];
    const action = String(row.actionText || '').trim();
    const note = String(row.note || '').trim();
    if (action) parts.push(`Action: ${action}`);
    if (note) parts.push(`Note: ${note}`);
    return parts.join('\n') || '-';
}

function photoDataUrl(photo) {
    if (!photo) return '';
    if (typeof photo === 'string') return photo.trim();
    return String(photo.dataUrl || photo.url || '').trim();
}

function parseDataUrlAttachment(questionId, dataUrl) {
    const match = String(dataUrl || '').match(DATA_URL_RE);
    if (!match) return null;
    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) return null;
    const safeId = String(questionId).replace(/[^a-zA-Z0-9_-]/g, '-');
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const cid = `photo-${safeId}`;
    return {
        questionId,
        cid,
        filename: `${cid}.${ext}`,
        content: buffer,
        contentType,
    };
}

function collectEmailPhotos(auditType, session) {
    const ncIds = new Set(collectNcRows(auditType, session).map((row) => row.questionId));
    const photos = session?.photos && typeof session.photos === 'object' ? session.photos : {};
    const items = [];

    for (const [questionId, photo] of Object.entries(photos)) {
        const dataUrl = photoDataUrl(photo);
        const attachment = parseDataUrlAttachment(questionId, dataUrl);
        if (!attachment) continue;
        items.push({
            ...attachment,
            label: getQuestionLabel(auditType, session, questionId),
            isNcRelated: ncIds.has(questionId),
        });
    }

    items.sort((a, b) => {
        if (a.isNcRelated !== b.isNcRelated) return a.isNcRelated ? -1 : 1;
        return a.label.localeCompare(b.label);
    });
    return items;
}

function buildActionsSection(auditType, session) {
    const ncRows = collectNcRows(auditType, session);
    const rgmPlan = auditType === 'rgm-cleaning' ? collectRgmActionPlanEntries(session) : [];

    if (!ncRows.length && !rgmPlan.length) {
        return { html: '', text: '', hasContent: false };
    }

    const htmlParts = [];
    const textParts = [];

    if (ncRows.length) {
        htmlParts.push('<h3 style="margin:20px 0 8px;font-size:15px;">Non-compliant items</h3>');
        htmlParts.push('<ul style="margin:0;padding-left:20px;">');
        textParts.push('', 'Non-compliant items:');

        for (const row of ncRows) {
            const label = escapeHtml(row.label || row.questionId || 'Item');
            const detail = escapeHtml(rowDetailText(row)).replace(/\n/g, '<br />');
            htmlParts.push(`<li style="margin-bottom:10px;"><strong>${label}</strong><br />${detail}</li>`);
            textParts.push(`- ${row.label || row.questionId}: ${rowDetailText(row).replace(/\n/g, ' ')}`);
        }
        htmlParts.push('</ul>');
    }

    if (rgmPlan.length) {
        htmlParts.push('<h3 style="margin:20px 0 8px;font-size:15px;">Action plan</h3>');
        textParts.push('', 'Action plan:');
        for (const entry of rgmPlan) {
            htmlParts.push(
                `<div style="margin-bottom:10px;"><strong>${escapeHtml(entry.label)}</strong><p style="margin:4px 0 0;">${escapeHtml(entry.text)}</p></div>`
            );
            textParts.push(`- ${entry.label}: ${entry.text}`);
        }
    }

    return { html: htmlParts.join('\n'), text: textParts.join('\n'), hasContent: true };
}

function buildPhotosSection(photoItems) {
    if (!photoItems.length) {
        return { html: '', text: '', attachments: [], hasContent: false };
    }

    const htmlParts = [
        '<h3 style="margin:20px 0 8px;font-size:15px;">Photos</h3>',
    ];
    const textParts = ['', 'Photos:'];
    const attachments = [];

    for (const photo of photoItems) {
        htmlParts.push(
            `<div style="margin-bottom:16px;"><p style="margin:0 0 6px;"><strong>${escapeHtml(photo.label)}</strong></p>` +
                `<img src="cid:${photo.cid}" alt="${escapeHtml(photo.label)}" style="display:block;max-width:100%;width:320px;height:auto;border:1px solid #d1d5db;" /></div>`
        );
        textParts.push(`- ${photo.label} (see image in HTML version of this email)`);
        attachments.push({
            filename: photo.filename,
            content: photo.content,
            contentType: photo.contentType,
            cid: photo.cid,
        });
    }

    return {
        html: htmlParts.join('\n'),
        text: textParts.join('\n'),
        attachments,
        hasContent: true,
    };
}

function buildAuditEmailContent(auditType, session, intro) {
    const actions = buildActionsSection(auditType, session);
    const photoItems = collectEmailPhotos(auditType, session);
    const photos = buildPhotosSection(photoItems);

    const htmlSections = [
        `<p style="margin:0 0 12px;">${escapeHtml(intro)}</p>`,
        actions.html,
        photos.html,
        '<p style="margin:20px 0 0;color:#6b7280;font-size:13px;">The full audit report is attached as a PDF.</p>',
    ].filter(Boolean);

    const textSections = [intro, actions.text, photos.text, '', 'The full audit report is attached as a PDF.'].filter(
        (part) => part !== ''
    );

    return {
        html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1f2933;">${htmlSections.join('\n')}</div>`,
        text: textSections.join('\n'),
        attachments: photos.attachments,
    };
}

module.exports = {
    collectNcRows,
    collectEmailPhotos,
    buildAuditEmailContent,
};
