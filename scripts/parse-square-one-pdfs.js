/**
 * One-off: parse Square One PDFs from Downloads into area question JSON.
 * Run: node scripts/parse-square-one-pdfs.js
 */
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const DOWNLOADS = path.join(process.env.USERPROFILE || '', 'Downloads');
const OUT = path.join(__dirname, '../src/services/squareOne/squareOneQuestions.generated.json');

const AREA_MAP = [
    { file: 'Square One  Week 1 Dining Room.pdf', id: 'dining-room', dashboardLabel: 'Dining Room', week: 1 },
    { file: 'Square One  Week 1 Restrooms.pdf', id: 'restrooms', dashboardLabel: 'Restrooms', week: 1 },
    { file: 'Square One  Week 2 Production Line.pdf', id: 'production-line', dashboardLabel: 'Production Line', week: 2 },
    {
        file: 'Square One  Week 2 BOH Walls Floors  Shelving.pdf',
        id: 'boh-walls-floors',
        dashboardLabel: 'Walls, Floors, Drains, Shelves...',
        week: 2,
    },
    { file: 'Square One  Week 3 External.pdf', id: 'external', dashboardLabel: 'External', week: 3 },
    {
        file: 'Square One  Week 3 Bins Bin Room  Miscellaneous.pdf',
        id: 'bins-bin-room',
        dashboardLabel: 'Bins, Bin Room, Office...',
        week: 3,
    },
    { file: 'Square One  Week 4 Drink Stations.pdf', id: 'drink-stations', dashboardLabel: 'Drink Station', week: 4 },
    {
        file: 'Square One  Week 4 Prep Equipment  Wash Up.pdf',
        id: 'prep-washup',
        dashboardLabel: 'Prep and Washup',
        week: 4,
    },
];

function slugify(text, index) {
    const base = String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 48);
    return `${base || 'q'}_${index}`;
}

function parseAreaText(text, meta) {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    const titleMatch = text.match(/Square One \| Week \d+: ([^\n]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : meta.dashboardLabel;

    const questions = [];
    let currentGroup = title.split(':')[0].trim();
    let buffer = '';
    let qIndex = 0;

    function flushQuestion() {
        const label = buffer.replace(/\s+/g, ' ').trim();
        buffer = '';
        if (!label || label.length < 8) return;
        if (/^(Title Page|Select one|If answer|If checkbox|\[\s*\]|Enter Date|Date:|-- \d)/i.test(label)) return;
        if (/^(Completed to Standard|Not Complete|Not Completed|N\/A|Required Cleaning)/i.test(label)) return;
        if (/^Instruction$/i.test(label)) return;

        const allowNa = /\bN\/A\b/.test(
            text.slice(text.indexOf(label), text.indexOf(label) + label.length + 120)
        );

        qIndex += 1;
        questions.push({
            id: slugify(label.slice(0, 40), qIndex),
            label,
            group: currentGroup,
            allowNa,
        });
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^-- \d+ of \d+ --$/.test(line)) continue;
        if (/^\d+\/\d+$/.test(line)) continue;
        if (/^Square One \|/i.test(line)) continue;
        if (/^Last (updated|Update)/i.test(line)) continue;
        if (/^Title Page$/i.test(line)) continue;
        if (/^\* Site conducted/i.test(line)) continue;
        if (/^\* Conducted on/i.test(line)) continue;
        if (/^Enter Date and Time/i.test(line)) continue;
        if (/^\/ \/$/.test(line)) continue;
        if (/^: AM \/ PM$/i.test(line)) continue;
        if (/^\* Date & Time Completed/i.test(line)) continue;
        if (/^\* Signature/i.test(line)) continue;
        if (/^Date: \/ \/$/.test(line)) continue;

        if (/^Instruction$/i.test(line)) {
            flushQuestion();
            continue;
        }

        if (/^(DINING ROOM|RESTROOMS|PRODUCTION LINE|BOH WALLS|EXTERNAL|BINS, BIN ROOM|DRINK STATIONS|PREP EQUIPMENT|SHELVING|WALLS|FLOORS|POST MIX|FROZEN DRINKS)/i.test(line)) {
            flushQuestion();
            currentGroup = line.replace(/:.*$/, '').trim();
            if (/SAFETY ALERT/i.test(line)) {
                buffer = line;
            }
            continue;
        }

        if (/^Select one$/i.test(line) || /^Checkbox$/i.test(line)) {
            flushQuestion();
            continue;
        }

        if (/^If (answer|checkbox)/i.test(line)) continue;
        if (/^\[\s*\]/.test(line)) continue;
        if (/^Completed to Standard/i.test(line)) continue;
        if (/^Not Complete/i.test(line)) continue;
        if (/^Required Cleaning/i.test(line)) continue;

        if (line.startsWith('* ')) {
            flushQuestion();
            buffer = line.slice(2);
        } else if (buffer && !/^--/.test(line)) {
            buffer += ` ${line}`;
        }
    }
    flushQuestion();

    return { ...meta, title, questions };
}

async function main() {
    const areas = [];
    for (const meta of AREA_MAP) {
        const filePath = path.join(DOWNLOADS, meta.file);
        if (!fs.existsSync(filePath)) {
            console.error('Missing:', filePath);
            process.exit(1);
        }
        const buf = fs.readFileSync(filePath);
        const parsed = await pdf(buf);
        const area = parseAreaText(parsed.text, meta);
        console.log(`${meta.id}: ${area.questions.length} questions`);
        areas.push(area);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify({ areas }, null, 2)}\n`, 'utf8');
    console.log('Wrote', OUT);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
