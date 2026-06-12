#!/usr/bin/env node
/**
 * Parse TacAudit PDF forms into generated question JSON.
 * Usage: node tacaudit/scripts/import-audit-pdf.js [pdfPath] [outputJson]
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const AUDIT_PROFILES = {
    'core-ops': {
        pdf: 'CORE Operations Self Score 2025.pdf',
        out: path.join(__dirname, '../audits/CORE Operations/coreOpsQuestions.generated.json'),
        auditLabel: 'CORE Operations Self Score',
        defaultQuestionType: 'yes_no_points',
        passThreshold: 20,
    },
    'core-food-safety': {
        pdf: 'CORE Food Safety Self Score 2025.pdf',
        out: path.join(__dirname, '../audits/CORE Food Safety/coreFoodSafetyQuestions.generated.json'),
        auditLabel: 'CORE Food Safety Self Score',
        defaultQuestionType: 'standard_rating',
    },
    'visit-customer': {
        pdf: 'Visiting as a Customer.pdf',
        out: path.join(__dirname, '../audits/Visiting as a Customer/visitCustomerQuestions.generated.json'),
        auditLabel: 'Visiting as a Customer',
        defaultQuestionType: 'compliant_nc',
    },
    'visit-coach': {
        pdf: 'Visiting as a Coach - FY26.pdf',
        out: path.join(__dirname, '../audits/Visiting as a Coach/visitCoachQuestions.generated.json'),
        auditLabel: 'Visiting as a Coach',
        defaultQuestionType: 'select',
    },
};

const DOWNLOADS = process.env.AUDIT_PDF_DIR || path.join(process.env.USERPROFILE || '', 'Downloads');

function slugId(text, index) {
    const base = String(text || 'q')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 48);
    return base ? `${base}_${index}` : `question_${index}`;
}

function parsePoints(label) {
    const m = String(label).match(/\((\d+)\s*PTS?\)/i);
    return m ? Number(m[1]) : null;
}

function parseNoPoints(optionLine) {
    const m = String(optionLine).match(/\[ \]\s*No\s*\((\d+)\)/i);
    return m ? Number(m[1]) : null;
}

function parseConditional(line) {
    const m = String(line).match(/If answer is\s+(.+?)\s+Answer Question\(s\)\s+([\d.,\s]+)/i);
    if (!m) return null;
    const whenRaw = m[1].trim().toLowerCase();
    const when = whenRaw.includes('drive') ? 'drive-thru' : whenRaw.includes('front') ? 'front counter' : whenRaw;
    const refs = m[2].split(/,\s*/).map((r) => r.trim()).filter(Boolean);
    return { when, refs };
}

function inferQuestionType(options, profile) {
    const opts = options.map((o) => o.toLowerCase());
    if (opts.some((o) => o.includes('at standard'))) return 'standard_rating';
    if (opts.some((o) => o.includes('compliant'))) return 'compliant_nc';
    if (opts.some((o) => o.includes('great!') || o.includes('poor'))) return 'overall_result';
    if (opts.length === 1 && opts[0].includes('checkbox')) return 'checkbox';
    if (opts.every((o) => o === 'yes' || o.startsWith('no') || o === 'n/a' || o.includes('(+'))) {
        return profile.defaultQuestionType === 'yes_no_points' ? 'yes_no_points' : 'yes_no_na';
    }
    if (opts.length >= 2) return 'select';
    return profile.defaultQuestionType;
}

function cleanQuestionLabel(raw) {
    return String(raw || '')
        .replace(/^\*\s*/, '')
        .replace(/\s*Select one\s*$/i, '')
        .replace(/\s*Text answer\s*$/i, '')
        .replace(/\s*Signature\s*$/i, '')
        .replace(/\s*Number\s*$/i, '')
        .replace(/\s*Date\/time\s*$/i, '')
        .replace(/\s*Checkbox\s*$/i, '')
        .trim();
}

function isNumberedQuestionStart(line) {
    return /^\d+\.\d+\s*-\s*/.test(String(line).trim());
}

function isQuestionLine(line) {
    const t = String(line).trim();
    if (t.startsWith('*')) return true;
    if (isNumberedQuestionStart(t)) return true;
    if (/Select one\s*$/i.test(t) && t.length > 12) return true;
    if (/\(\d+\s*PTS?\)/i.test(t) && /Select one/i.test(t)) return true;
    return false;
}

function isSectionHeading(line) {
    const t = String(line).trim();
    if (!t || t.startsWith('*') || t.startsWith('[') || t.startsWith('--')) return false;
    if (isQuestionLine(t)) return false;
    if (/^\d+\.\d+\s*-/.test(t)) return false;
    if (/^\d+\/\d+$/.test(t)) return false;
    if (/^If answer is/i.test(t)) return false;
    if (/^Enter Date/i.test(t)) return false;
    if (/Select one/i.test(t)) return false;
    if (/\?/.test(t)) return false;
    if (t.length < 3 || t.length > 80) return false;
    if (/^Title Page$/i.test(t)) return true;
    if (/^Step \d+/i.test(t)) return true;
    if (/^Scoring$/i.test(t)) return true;
    if (/^Evaluation/i.test(t)) return true;
    if (/^Section \d+/i.test(t)) return true;
    if (/^Serving Up/i.test(t)) return true;
    if (/^Customer Shop/i.test(t)) return true;
    if (/^Kitchen 101/i.test(t)) return true;
    if (/^Right People/i.test(t)) return true;
    if (/^The Brand Experience/i.test(t)) return true;
    if (/^Inside your Taco Bell/i.test(t)) return true;
    if (/^THE BRAND EXPERIENCE/i.test(t)) return true;
    if (/^Restaurant (Exterior|Interior)/i.test(t)) return true;
    if (/^Product Recognition/i.test(t)) return true;
    if (/^Plan Your Visit/i.test(t)) return true;
    if (/^Techno/i.test(t)) return true;
    if (/^Back of House/i.test(t)) return true;
    if (/^Prevent pest/i.test(t)) return true;
    return /^[A-Z]/.test(t) && !t.includes('PTS') && !t.includes('Select one');
}

function sectionIdFromLabel(label, order) {
    const slug = String(label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 40);
    return slug || `section_${order}`;
}

async function extractPdfText(pdfPath) {
    const buf = new Uint8Array(fs.readFileSync(pdfPath));
    const parser = new PDFParse(buf);
    const result = await parser.getText();
    return result?.text || String(result || '');
}

function parsePdfText(text, profile) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const sections = [];
    const questions = [];
    let currentSection = { id: 'title_page', label: 'Title Page', order: 0 };
    sections.push(currentSection);
    let qIndex = 0;
    let pendingQuestion = null;
    let pendingConditional = null;
    const conditionalRefs = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('-- ') && line.endsWith(' --')) continue;
        if (/^\d+\/\d+$/.test(line)) continue;
        if (/^CORE Operations|^CORE Food Safety|^Visiting as a Coach|^Visiting as a Customer/i.test(line)) continue;
        if (/^0-20 points|^Each standard is worth/i.test(line)) continue;

        const cond = parseConditional(line);
        if (cond) {
            pendingConditional = cond;
            continue;
        }

        if (isSectionHeading(line)) {
            if (pendingQuestion) {
                questions.push(pendingQuestion);
                pendingQuestion = null;
            }
            const order = sections.length;
            const label = line;
            currentSection = {
                id: sectionIdFromLabel(label, order),
                label,
                order,
            };
            if (!sections.find((s) => s.id === currentSection.id)) {
                sections.push(currentSection);
            } else {
                currentSection = sections.find((s) => s.id === currentSection.id);
            }
            continue;
        }

        if (line.startsWith('*')) {
            if (pendingQuestion) questions.push(pendingQuestion);
            const label = cleanQuestionLabel(line);
            const lower = label.toLowerCase();
            let type = profile.defaultQuestionType;
            if (lower.includes('signature')) type = 'signature';
            else if (lower.includes('date/time') || lower === 'conducted on') type = 'datetime';
            else if (lower.includes('text answer') || lower.includes('prepared by') || lower.includes('site conducted')) type = 'text';
            else if (lower.includes('score') && lower.includes('number')) type = 'number';
            else if (lower.includes('comments')) type = 'textarea';
            else if (lower.includes('notes:')) type = 'textarea';

            pendingQuestion = {
                id: slugId(label, qIndex++),
                section: currentSection.id,
                type,
                label: label.replace(/\s*Text answer\s*$/i, '').replace(/\s*Signature\s*$/i, '').trim(),
                group: currentSection.label,
                required: !/comments/i.test(label),
                options: [],
                points: parsePoints(label),
            };
            if (pendingConditional) {
                pendingQuestion.showWhenRef = pendingConditional.ref;
                pendingQuestion.showWhenValue = pendingConditional.when;
                conditionalRefs.push({ ref: pendingConditional.ref, questionId: pendingQuestion.id });
                pendingConditional = null;
            }
            continue;
        }

        if (line.startsWith('[ ]') && pendingQuestion) {
            const opt = line.replace(/^\[ \]\s*/, '').trim();
            pendingQuestion.options.push(opt);
            const noPts = parseNoPoints(line);
            if (noPts != null && pendingQuestion.type === 'yes_no_points') {
                pendingQuestion.noPoints = noPts;
            }
            continue;
        }

        if (pendingQuestion && pendingQuestion.type === 'textarea' && !line.startsWith('[')) {
            pendingQuestion.label = `${pendingQuestion.label} ${line}`.trim();
        }
    }
    if (pendingQuestion) questions.push(pendingQuestion);

    for (const q of questions) {
        if (q.options?.length && !['signature', 'text', 'textarea', 'datetime', 'number'].includes(q.type)) {
            q.type = inferQuestionType(q.options, profile);
        }
        if (q.showWhenRef) {
            const parent = questions.find((p) => p.label.includes(q.showWhenRef) || p.id.includes(q.showWhenRef.replace(/\./g, '_')));
            if (parent) {
                q.showWhenAnswer = { [parent.id]: q.showWhenValue === 'yes' ? 'yes' : q.showWhenValue };
            }
            delete q.showWhenRef;
            delete q.showWhenValue;
        }
        delete q.options;
        if (Array.isArray(q.options) && q.options.length === 0) delete q.options;
    }

  // Re-infer types and keep options array
  for (const q of questions) {
    const rawOpts = q._rawOptions;
    if (rawOpts) {
      q.type = inferQuestionType(rawOpts, profile);
      if (q.type === 'yes_no_points' || q.type === 'yes_no_na' || q.type === 'select' || q.type === 'standard_rating' || q.type === 'compliant_nc' || q.type === 'overall_result') {
        q.options = rawOpts.map((o) => o.replace(/\s*\(\d+\)\s*$/, '').replace(/\s*\(\+\d+\)\s*$/, '').trim());
      }
      delete q._rawOptions;
    }
  }

    const signOffSection = {
        id: 'sign_off',
        label: 'Sign Off',
        order: sections.length,
    };
    if (!sections.find((s) => s.id === 'sign_off')) sections.push(signOffSection);

    return {
        auditLabel: profile.auditLabel,
        passThreshold: profile.passThreshold ?? null,
        sections: sections.sort((a, b) => a.order - b.order),
        questions,
    };
}

function parsePdfTextFixed(text, profile) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const sections = [];
    const questions = [];
    let currentSection = { id: 'title_page', label: 'Title Page', order: 0 };
    sections.push(currentSection);
    let qIndex = 0;
    let pendingQuestion = null;
    let pendingConditional = null;

    for (const line of lines) {
        if (line.startsWith('-- ') && line.endsWith(' --')) continue;
        if (/^\d+\/\d+$/.test(line)) continue;
        if (/^CORE Operations|^CORE Food Safety|^Visiting as a Coach|^Visiting as a Customer/i.test(line) && line.length < 60) continue;
        if (/^0-20 points|^Each standard is worth/i.test(line)) continue;

        const cond = parseConditional(line);
        if (cond) {
            pendingConditional = cond;
            continue;
        }

        if (isSectionHeading(line)) {
            if (pendingQuestion) {
                if (pendingQuestion._rawOptions?.length) {
                    pendingQuestion.type = inferQuestionType(pendingQuestion._rawOptions, profile);
                    if (pendingQuestion.type !== 'checkbox') {
                        pendingQuestion.options = pendingQuestion._rawOptions.map((o) =>
                            o.replace(/\s*\(\d+\)\s*$/, '').replace(/\s*\(\+\d+\)\s*$/, '').trim()
                        );
                    }
                }
                delete pendingQuestion._rawOptions;
                questions.push(pendingQuestion);
                pendingQuestion = null;
            }
            const order = sections.length;
            const label = line;
            const id = sectionIdFromLabel(label, order);
            currentSection = sections.find((s) => s.id === id) || { id, label, order };
            if (!sections.find((s) => s.id === id)) sections.push(currentSection);
            continue;
        }

        if (isQuestionLine(line) || (pendingQuestion && !line.startsWith('[ ]') && !isSectionHeading(line) && pendingQuestion._awaitingSelectOne)) {
            if (pendingQuestion && (isQuestionLine(line) || line.startsWith('*'))) {
                if (pendingQuestion._rawOptions?.length) {
                    pendingQuestion.type = inferQuestionType(pendingQuestion._rawOptions, profile);
                    if (pendingQuestion.type !== 'checkbox') {
                        pendingQuestion.options = pendingQuestion._rawOptions.map((o) =>
                            o.replace(/\s*\(\d+\)\s*$/, '').replace(/\s*\(\+\d+\)\s*$/, '').trim()
                        );
                    }
                }
                delete pendingQuestion._rawOptions;
                delete pendingQuestion._awaitingSelectOne;
                questions.push(pendingQuestion);
                pendingQuestion = null;
            }

            let label = line.startsWith('*') ? cleanQuestionLabel(line) : line.replace(/\s*Select one\s*$/i, '').trim();
            if (isNumberedQuestionStart(label)) {
                label = label.replace(/^\d+\.\d+\s*-\s*/, '').trim();
            }

            const lower = label.toLowerCase();
            let type = profile.defaultQuestionType;
            if (lower.includes('signature')) type = 'signature';
            else if (lower.includes('conducted on') || lower.includes('date/time')) type = 'datetime';
            else if (/prepared by|site conducted|rgm|mic text|location text|area coach completing/i.test(lower)) type = 'text';
            else if (lower.includes('score') && lower.includes('number')) type = 'number';
            else if (lower.includes('comments') || lower === 'notes:') type = 'textarea';
            else if (/drive-thru|front counter/i.test(lower) && /select one/i.test(line)) type = 'select';

            pendingQuestion = {
                id: slugId(label, qIndex++),
                section: currentSection.id,
                type,
                label,
                group: currentSection.label,
                required: !/comments/i.test(label),
                points: parsePoints(label),
                _rawOptions: [],
                _awaitingSelectOne: /Select one\s*$/i.test(line) && !line.startsWith('[ ]'),
            };
            if (pendingConditional) {
                pendingQuestion.conditionalRefs = pendingConditional.refs;
                pendingQuestion.conditionalWhen = pendingConditional.when;
                pendingConditional = null;
            }
            if (!pendingQuestion._awaitingSelectOne && !line.startsWith('[ ]')) {
                // multiline label continuation handled on next non-option lines
            }
            continue;
        }

        if (pendingQuestion && pendingQuestion._awaitingSelectOne && !line.startsWith('[ ]')) {
            pendingQuestion.label = `${pendingQuestion.label} ${line.replace(/\s*Select one\s*$/i, '')}`.trim();
            pendingQuestion._awaitingSelectOne = /Select one\s*$/i.test(line);
            pendingQuestion.points = parsePoints(pendingQuestion.label);
            continue;
        }

        if (line.startsWith('[ ]') && pendingQuestion) {
            const opt = line.replace(/^\[ \]\s*/, '').trim();
            pendingQuestion._rawOptions = pendingQuestion._rawOptions || [];
            pendingQuestion._rawOptions.push(opt);
            const noPts = parseNoPoints(line);
            if (noPts != null) pendingQuestion.noPoints = noPts;
            if (/checkbox/i.test(opt)) pendingQuestion.type = 'checkbox';
        }
    }

    if (pendingQuestion) {
        if (pendingQuestion._rawOptions?.length) {
            pendingQuestion.type = inferQuestionType(pendingQuestion._rawOptions, profile);
            if (pendingQuestion.type !== 'checkbox') {
                pendingQuestion.options = pendingQuestion._rawOptions.map((o) =>
                    o.replace(/\s*\(\d+\)\s*$/, '').replace(/\s*\(\+\d+\)\s*$/, '').trim()
                );
            }
        }
        delete pendingQuestion._rawOptions;
        questions.push(pendingQuestion);
    }

    const shopPathQuestion = questions.find((p) => /drive thru or front counter/i.test(p.label));
    for (const q of questions) {
        if (!q.conditionalRefs?.length) continue;
        const ref = q.conditionalRefs[0];
        const parent =
            shopPathQuestion ||
            questions.find(
                (p) =>
                    p.label.includes(ref) ||
                    p.label.match(new RegExp(`\\b${ref.replace('.', '\\.')}\\b`)) ||
                    p.id.includes(ref.replace(/\./g, '_'))
            );
        if (parent) {
            const whenVal = q.conditionalWhen === 'yes' ? 'yes' : q.conditionalWhen;
            q.showWhenAnswer = { [parent.id]: whenVal };
        }
        delete q.conditionalRefs;
        delete q.conditionalWhen;
    }

    const signOffSection = { id: 'sign_off', label: 'Sign Off', order: sections.length };
    if (!sections.find((s) => s.id === 'sign_off')) sections.push(signOffSection);

    return {
        auditLabel: profile.auditLabel,
        passThreshold: profile.passThreshold ?? null,
        sections: sections.sort((a, b) => a.order - b.order),
        questions,
    };
}

async function importPdf(profileKey, profile) {
    const pdfPath = path.join(DOWNLOADS, profile.pdf);
    if (!fs.existsSync(pdfPath)) {
        console.warn(`Skip ${profileKey}: missing ${pdfPath}`);
        return false;
    }
    const text = await extractPdfText(pdfPath);
    const data = parsePdfTextFixed(text, profile);
    fs.mkdirSync(path.dirname(profile.out), { recursive: true });
    fs.writeFileSync(profile.out, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${profile.out} (${data.questions.length} questions, ${data.sections.length} sections)`);
    return true;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length >= 2) {
        const pdfPath = path.resolve(args[0]);
        const outPath = path.resolve(args[1]);
        const text = await extractPdfText(pdfPath);
        const data = parsePdfTextFixed(text, { defaultQuestionType: 'select', auditLabel: path.basename(pdfPath, '.pdf') });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        console.log(`Wrote ${outPath}`);
        return;
    }
    for (const [key, profile] of Object.entries(AUDIT_PROFILES)) {
        await importPdf(key, profile);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
