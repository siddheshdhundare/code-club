const zlib = require("zlib");

const HEADERS = [
  "Student Name",
  "Email",
  "Roll Number / Team ID",
  "Year",
  "Competition",
  "Problem",
  "Language",
  "Submitted Code",
  "Score",
  "Total Score",
  "Rank",
  "Submission Time",
  "Result / Status"
];

const MAX_ROWS = 1048576;
const MAX_CELL_LENGTH = 32767;

function valueOrBlank(...values) {
  const value = values.find(item => item !== undefined && item !== null && item !== "");
  return value === undefined ? "" : value;
}

function findProblem(db, submission, competition, participant) {
  const problemId = submission.problemId;
  const year = submission.problemYear || submission.year || participant?.year;
  const candidates = [
    competition?.problem,
    competition?.problems?.[year],
    db.problems?.[year]
  ];

  return candidates.find(problem => problem && (!problemId || problem.id === problemId));
}

function buildExportRows(db) {
  const participants = Object.entries(db.participants || {});
  const participantsById = new Map();
  for (const [key, participant] of participants) {
    if (participant?.id) participantsById.set(participant.id, participant);
    participantsById.set(key, participant);
  }

  const competitionsById = new Map(
    (db.competitions || []).filter(competition => competition?.id)
      .map(competition => [competition.id, competition])
  );
  const includedParticipants = new Set();
  const rows = [];

  for (const submission of db.submissions || []) {
    const participant = participantsById.get(submission.participantId);
    if (participant) includedParticipants.add(participant.id || submission.participantId);
    const competitionId = submission.competitionId || participant?.competitionId;
    const competition = competitionsById.get(competitionId);
    const problem = findProblem(db, submission, competition, participant);

    rows.push([
      valueOrBlank(submission.name, participant?.name),
      valueOrBlank(submission.email, participant?.email),
      valueOrBlank(submission.team, participant?.team),
      valueOrBlank(submission.problemYear, submission.year, participant?.year),
      valueOrBlank(submission.competitionName, participant?.competitionName, competition?.name),
      valueOrBlank(submission.problemTitle, submission.problemSnapshot?.title, problem?.title),
      valueOrBlank(submission.language),
      valueOrBlank(submission.code),
      valueOrBlank(submission.score, submission.passed),
      valueOrBlank(submission.totalScore, submission.total),
      valueOrBlank(submission.rank, participant?.rank),
      valueOrBlank(submission.createdAt),
      valueOrBlank(submission.result, submission.status)
    ]);
  }

  for (const [key, participant] of participants) {
    const participantId = participant?.id || key;
    if (includedParticipants.has(participantId)) continue;
    const competition = competitionsById.get(participant?.competitionId);
    rows.push([
      valueOrBlank(participant?.name),
      valueOrBlank(participant?.email),
      valueOrBlank(participant?.team),
      valueOrBlank(participant?.year),
      valueOrBlank(participant?.competitionName, competition?.name),
      "",
      "",
      "",
      "",
      "",
      valueOrBlank(participant?.rank),
      "",
      valueOrBlank(participant?.result, participant?.status)
    ]);
    includedParticipants.add(participantId);
  }

  return rows;
}

function xmlEscape(value) {
  const text = String(value);
  if (!/^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u.test(text)) {
    throw new Error("A value contains characters that cannot be represented in an Excel workbook.");
  }
  if (text.length > MAX_CELL_LENGTH) {
    throw new Error("A value exceeds Excel's 32,767-character cell limit.");
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnName(number) {
  let name = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function cellXml(reference, value, header = false) {
  const style = header ? ' s="1"' : "";
  if (value === "" || value === undefined || value === null) {
    return `<c r="${reference}"${style}/>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }

  const text = xmlEscape(value);
  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
}

function worksheetXml(rows) {
  if (rows.length + 1 > MAX_ROWS) {
    throw new Error("This export exceeds Excel's worksheet row limit.");
  }

  const allRows = [HEADERS, ...rows];
  const sheetRows = allRows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) =>
      cellXml(`${columnName(columnIndex + 1)}${rowNumber}`, value, rowIndex === 0)
    ).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const widths = [22, 26, 22, 10, 26, 28, 14, 60, 13, 16, 10, 24, 22];
  const columns = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  ).join("");
  const lastRow = allRows.length;
  const lastColumn = columnName(HEADERS.length);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columns}</cols>
  <sheetData>${sheetRows}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
</worksheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, contents] of files) {
    const fileName = Buffer.from(name, "utf8");
    const source = Buffer.from(contents, "utf8");
    const compressed = zlib.deflateRawSync(source);
    const checksum = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    localParts.push(local, fileName, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createResultsWorkbook(db) {
  const rows = buildExportRows(db);
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE91E63"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`],
    ["xl/worksheets/sheet1.xml", worksheetXml(rows)]
  ];

  return createZip(files);
}

module.exports = { buildExportRows, createResultsWorkbook };
