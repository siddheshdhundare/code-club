require("dotenv").config();

const express = require("express");
const cookieSession = require("cookie-session");
const fs = require("fs");
const path = require("path");
const { checkSupabaseConnection } = require("./supabase");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET;
const DB_FILE = path.join(__dirname, "data", "db.json");
if (isProduction && !sessionSecret) {
  throw new Error("SESSION_SECRET must be set in production so login sessions remain valid.");
}
const DEFAULT_DB = {
  participants: {},
  submissions: [],
  violations: [],
  problems: { SY: null, TY: null },
  competitions: []
};

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: "codeclub_session",
  keys: [sessionSecret || "change-this-session-secret"],
  httpOnly: true,
  sameSite: "lax",
  secure: isProduction,
  maxAge: 1000 * 60 * 60 * 12
}));
const LANGUAGES = {
  cpp: 54,
  java: 62
};

function readDB() {
  try {
    const stored = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      ...DEFAULT_DB,
      ...stored,
      participants: stored.participants || {},
      submissions: stored.submissions || [],
      violations: stored.violations || [],
      problems: { SY: null, TY: null, ...(stored.problems || {}) },
      competitions: Array.isArray(stored.competitions) ? stored.competitions : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULT_DB };
    throw error;
  }
}

function writeDB(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function requireAdmin(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: "Admin login required" });
  next();
}

function normalizeOutput(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function decodeJudgeText(value) {
  return value ? Buffer.from(value, "base64").toString("utf8") : "";
}

function publicProblem(problem) {
  if (!problem) return null;
  return {
    id: problem.id,
    year: problem.year,
    language: problem.language,
    competitionId: problem.competitionId,
    title: problem.title,
    statement: problem.statement,
    input: problem.inputFormat ?? problem.input,
    output: problem.outputFormat ?? problem.output,
    constraints: Array.isArray(problem.constraints)
      ? problem.constraints
      : String(problem.constraints || "").split(/\r?\n/).filter(Boolean),
    examples: [{
      input: problem.sampleInput ?? problem.examples?.[0]?.input ?? "",
      output: problem.sampleOutput ?? problem.examples?.[0]?.output ?? ""
    }]
  };
}

function adminProblem(problem) {
  if (!problem) return null;
  return {
    ...problem,
    inputFormat: problem.inputFormat ?? problem.input ?? "",
    outputFormat: problem.outputFormat ?? problem.output ?? "",
    constraints: Array.isArray(problem.constraints)
      ? problem.constraints.join("\n")
      : problem.constraints || "",
    sampleInput: problem.sampleInput ?? problem.examples?.[0]?.input ?? "",
    sampleOutput: problem.sampleOutput ?? problem.examples?.[0]?.output ?? "",
    hiddenTests: problem.hiddenTests || []
  };
}

function normalizeProblem(body, year) {
  const title = String(body.title || "").trim();
  const statement = String(body.statement || "").trim();
  const inputFormat = String(body.inputFormat || "").trim();
  const outputFormat = String(body.outputFormat || "").trim();
  const constraintsText = String(body.constraints || "").trim();
  const sampleInput = String(body.sampleInput || "");
  const sampleOutput = String(body.sampleOutput || "");
  const hiddenTests = Array.isArray(body.hiddenTests) ? body.hiddenTests : [];

  if (!title || !statement || !inputFormat || !outputFormat || !constraintsText) {
    throw new Error("Title, statement, input format, output format, and constraints are required.");
  }
  if (body.sampleInput === undefined || body.sampleOutput === undefined) {
    throw new Error("Sample input and sample output are required.");
  }
  if (hiddenTests.length === 0) throw new Error("Add at least one hidden test case.");
  if (hiddenTests.length > 100) throw new Error("A problem can have at most 100 hidden test cases.");

  const tests = hiddenTests.map((test, index) => {
    if (!test || test.input === undefined || test.expected === undefined) {
      throw new Error(`Hidden test case ${index + 1} needs both input and expected output.`);
    }
    const testInput = String(test.input);
    const expected = String(test.expected);
    return { input: testInput, expected };
  });

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    year,
    language: year === "SY" ? "cpp" : "java",
    title,
    statement,
    inputFormat,
    outputFormat,
    constraints: constraintsText,
    sampleInput,
    sampleOutput,
    hiddenTests: tests,
    updatedAt: new Date().toISOString()
  };
}

function competitionPublic(competition) {
  const problem = competition.problem || competition.problems?.[competition.year] || null;
  return {
    id: competition.id,
    name: competition.name,
    year: competition.year || null,
    language: competition.year === "SY" ? "cpp" : competition.year === "TY" ? "java" : null,
    description: competition.description,
    code: competition.code,
    duration: competition.duration,
    status: competition.status,
    createdAt: competition.createdAt,
    startTime: competition.startTime || null,
    endTime: competition.endTime || null,
    startedAt: competition.startTime || null,
    endedAt: competition.endedAt || null,
    problems: {
      SY: competition.year === "SY" && Boolean(problem),
      TY: competition.year === "TY" && Boolean(problem)
    }
  };
}

function competitionIsActive(competition) {
  return Boolean(competition && competition.status === "ACTIVE");
}

function synchronizeCompetitionStatuses(db, now = Date.now()) {
  let changed = false;
  for (const competition of db.competitions) {
    const status = String(competition.status || "NOT_STARTED").toUpperCase();
    if (status !== competition.status) {
      competition.status = status === "DRAFT" ? "NOT_STARTED" : status;
      changed = true;
    }
    if (!["NOT_STARTED", "ACTIVE", "ENDED"].includes(competition.status)) {
      competition.status = "NOT_STARTED";
      changed = true;
    }
    const legacyProblems = competition.problems && typeof competition.problems === "object"
      ? competition.problems
      : null;
    if (!["SY", "TY"].includes(competition.year)) {
      const savedYears = ["SY", "TY"].filter(year => legacyProblems?.[year]);
      if (savedYears.length === 1) {
        competition.year = savedYears[0];
        changed = true;
      } else if (["SY", "TY"].includes(competition.problem?.year)) {
        competition.year = competition.problem.year;
        changed = true;
      }
    }
    if (!competition.problem && ["SY", "TY"].includes(competition.year) && legacyProblems?.[competition.year]) {
      competition.problem = legacyProblems[competition.year];
      changed = true;
    }
    if (["SY", "TY"].includes(competition.year) && legacyProblems) {
      const otherYear = competition.year === "SY" ? "TY" : "SY";
      if (!legacyProblems[otherYear]) {
        delete competition.problems;
        changed = true;
      }
    }

    if (!competition.startTime && competition.startedAt) {
      competition.startTime = competition.startedAt;
      changed = true;
    }
    if (!competition.startedAt && competition.startTime) {
      competition.startedAt = competition.startTime;
      changed = true;
    }

    if (competition.status === "ACTIVE" && !Number.isFinite(Date.parse(competition.endTime || ""))) {
      const startedAt = Date.parse(competition.startTime || "");
      const duration = Number(competition.duration);
      if (Number.isFinite(startedAt) && Number.isFinite(duration) && duration > 0) {
        competition.endTime = new Date(startedAt + duration * 60_000).toISOString();
        changed = true;
      } else {
        competition.status = "ENDED";
        competition.endedAt = new Date(now).toISOString();
        changed = true;
      }
    }

    if (competition.status === "ACTIVE" && Date.parse(competition.endTime) <= now) {
      competition.status = "ENDED";
      competition.endedAt = new Date(now).toISOString();
      changed = true;
    }
  }
  return changed;
}

function refreshCompetitionStatuses(db) {
  if (synchronizeCompetitionStatuses(db)) writeDB(db);
}

function remainingCompetitionSeconds(competition) {
  return Math.max(0, Math.ceil((Date.parse(competition.endTime) - Date.now()) / 1000));
}

function competitionAccessError(competition) {
  if (!competition) {
    return { status: 404, error: "COMPETITION_NOT_FOUND", message: "Competition was not found." };
  }
  if (competition.status === "NOT_STARTED") {
    return { status: 403, error: "COMPETITION_NOT_STARTED", message: "Competition has not started yet." };
  }
  if (competition.status === "ENDED") {
    return { status: 403, error: "COMPETITION_ENDED", message: "Competition has ended. Submission is no longer allowed." };
  }
  return null;
}

function sendCompetitionAccessError(res, error) {
  return res.status(error.status).json({
    success: false,
    error: error.error,
    message: error.message
  });
}

function createCompetitionCode(competitions) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    if (!competitions.some(competition => competition.code === code)) return code;
  }
  throw new Error("Unable to generate a unique competition code. Please try again.");
}

async function judgeOne({ sourceCode, languageId, stdin }) {
  const base = (process.env.JUDGE0_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("JUDGE0_URL is not configured.");

  const headers = { "Content-Type": "application/json" };
  if (process.env.JUDGE0_AUTH_TOKEN) headers["X-Auth-Token"] = process.env.JUDGE0_AUTH_TOKEN;
  if (process.env.JUDGE0_AUTH_USER) headers["X-Auth-User"] = process.env.JUDGE0_AUTH_USER;

  const create = await fetch(`${base}/submissions?base64_encoded=false&wait=false`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source_code: sourceCode,
      language_id: languageId,
      stdin,
      cpu_time_limit: 2,
      wall_time_limit: 5,
      memory_limit: 128000,
      max_file_size: 1024
    })
  });

  if (!create.ok) {
    const body = await create.text();
    throw new Error(`Judge0 create failed (${create.status}): ${body}`);
  }

  const created = await create.json();
  if (!created.token) throw new Error("Judge0 did not return a submission token.");

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));

    const result = await fetch(
      `${base}/submissions/${created.token}?base64_encoded=true`,
      { headers }
    );

    if (!result.ok) {
      const body = await result.text();
      throw new Error(`Judge0 result failed (${result.status}): ${body}`);
    }

    const data = await result.json();
    const statusId = data.status?.id;

    if (statusId !== 1 && statusId !== 2) {
      return {
        token: data.token,
        status: data.status?.description || "Unknown",
        stdout: decodeJudgeText(data.stdout),
        stderr: decodeJudgeText(data.stderr),
        compileOutput: decodeJudgeText(data.compile_output),
        message: decodeJudgeText(data.message),
        time: data.time ?? null,
        memory: data.memory ?? null,
        exitCode: data.exit_code ?? null
      };
    }
  }

  return {
    status: "Judge timeout",
    stdout: "",
    stderr: "The judge did not finish within the server polling window.",
    compileOutput: "",
    message: "",
    time: null,
    memory: null
  };
}

app.get("/api/problem", (req, res) => {
  if (!req.session?.student) return res.status(401).json({ error: "Student login required." });
  const db = readDB();
  const competition = db.competitions.find(item => item.id === req.session.student.competitionId);
  refreshCompetitionStatuses(db);
  const accessError = competitionAccessError(competition);
  if (accessError) return sendCompetitionAccessError(res, accessError);
  if (competition.year !== req.session.student.year) {
    return res.status(403).json({ success: false, error: "YEAR_MISMATCH", message: "This competition is not assigned to your year." });
  }
  const problem = competition.problem || competition.problems?.[req.session.student.year];
  if (!problem) {
    return res.status(404).json({ error: `The admin has not published a ${req.session.student.year} problem yet.` });
  }
  res.json(publicProblem(problem));
});

app.post("/api/student/join", (req, res) => {
  const code = String(req.body.code || "").trim();
  if (req.session) {
    delete req.session.student;
    delete req.session.joinedCompetitionId;
  }
  const db = readDB();
  const competition = db.competitions.find(item => item.code === code);
  refreshCompetitionStatuses(db);
  if (!competition) return res.status(404).json({ success: false, error: "INVALID_COMPETITION_CODE", message: "Invalid Competition Code." });
  const accessError = competitionAccessError(competition);
  if (accessError) return sendCompetitionAccessError(res, accessError);
  if (!["SY", "TY"].includes(competition.year)) {
    return res.status(409).json({ success: false, error: "COMPETITION_YEAR_UNASSIGNED", message: "This competition has not been assigned to SY or TY." });
  }
  req.session.joinedCompetitionId = competition.id;
  res.json({
    competition: {
      id: competition.id,
      name: competition.name,
      description: competition.description,
      duration: competition.duration,
      year: competition.year,
      language: competitionPublic(competition).language,
      startTime: competition.startTime,
      endTime: competition.endTime,
      endAt: competition.endTime,
      serverTime: new Date().toISOString()
    }
  });
});

app.get("/api/student/joined", (req, res) => {
  if (!req.session?.joinedCompetitionId) return res.status(401).json({ error: "Join a competition first." });
  const db = readDB();
  const competition = db.competitions.find(item => item.id === req.session.joinedCompetitionId);
  refreshCompetitionStatuses(db);
  const accessError = competitionAccessError(competition);
  if (accessError) {
    req.session = null;
    return sendCompetitionAccessError(res, accessError);
  }
  if (!["SY", "TY"].includes(competition.year)) {
    req.session = null;
    return res.status(409).json({ success: false, error: "COMPETITION_YEAR_UNASSIGNED", message: "This competition has not been assigned to SY or TY." });
  }
  res.json({
    competition: {
      id: competition.id,
      name: competition.name,
      description: competition.description,
      duration: competition.duration,
      year: competition.year,
      language: competitionPublic(competition).language,
      startTime: competition.startTime,
      endTime: competition.endTime,
      endAt: competition.endTime,
      serverTime: new Date().toISOString()
    }
  });
});

app.post("/api/student/login", (req, res) => {
  const name = String(req.body.name || "").trim();
  const team = String(req.body.team || "").trim();
  const year = String(req.body.year || "");
  const competitionId = req.session?.joinedCompetitionId;

  if (!name || !team || !["SY", "TY"].includes(year)) {
    return res.status(400).json({ error: "Name, roll/team ID, and a valid year (SY or TY) are required." });
  }
  if (!competitionId) return res.status(401).json({ error: "Enter a valid Competition Code first." });

  const db = readDB();
  const competition = db.competitions.find(item => item.id === competitionId);
  refreshCompetitionStatuses(db);
  const accessError = competitionAccessError(competition);
  if (accessError) return sendCompetitionAccessError(res, accessError);
  if (competition.year !== year) {
    return res.status(403).json({
      success: false,
      error: "YEAR_MISMATCH",
      message: `This code belongs to the ${competition.year || "unassigned"} competition, not ${year}.`
    });
  }
  if (!(competition.problem || competition.problems?.[year])) return res.status(409).json({ error: `The admin has not published a ${year} problem for this competition yet.` });

  const participantId = `${competitionId}-${team.toUpperCase()}`;

  if (!db.participants[participantId]) {
    db.participants[participantId] = {
      id: participantId,
      name,
      team,
      year,
      competitionId,
      competitionName: competition.name,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      violations: 0
    };
  } else {
    if (db.participants[participantId].name.toLowerCase() !== name.toLowerCase()) {
      return res.status(409).json({ error: "This roll/team ID is already registered to another name for this competition." });
    }
    if (db.participants[participantId].year !== year) {
      return res.status(409).json({ error: "This roll/team ID is already registered with a different year for this competition." });
    }
    db.participants[participantId].year = year;
    db.participants[participantId].competitionId = competitionId;
    db.participants[participantId].competitionName = competition.name;
    db.participants[participantId].lastSeenAt = new Date().toISOString();
  }

  writeDB(db);
  req.session.student = { id: participantId, name, team, year, competitionId };
  const activeParticipant = db.participants[participantId];
  res.json({
    participant: activeParticipant,
    competition: {
      id: competition.id,
      name: competition.name,
      duration: competition.duration,
      year: competition.year,
      language: competitionPublic(competition).language,
      startTime: competition.startTime,
      endTime: competition.endTime,
      endAt: competition.endTime,
      serverTime: new Date().toISOString()
    }
  });
});

app.get("/api/student/me", (req, res) => {
  if (!req.session?.student) return res.status(401).json({ error: "Student login required" });
  const db = readDB();
  const competition = db.competitions.find(item => item.id === req.session.student.competitionId);
  refreshCompetitionStatuses(db);
  const accessError = competitionAccessError(competition);
  if (accessError) return sendCompetitionAccessError(res, accessError);
  if (competition.year !== req.session.student.year) {
    return res.status(403).json({ success: false, error: "YEAR_MISMATCH", message: "This competition is not assigned to your year." });
  }
  const participant = db.participants[req.session.student.id];
  if (!participant) return res.status(404).json({ error: "Student participant record not found." });
  res.json({
    participant,
    competition: {
      id: competition.id,
      name: competition.name,
      duration: competition.duration,
      year: competition.year,
      language: competitionPublic(competition).language,
      startTime: competition.startTime,
      endTime: competition.endTime,
      endAt: competition.endTime,
      serverTime: new Date().toISOString(),
    },
    remainingSeconds: remainingCompetitionSeconds(competition)
  });
});

app.post("/api/student/heartbeat", (req, res) => {
  if (!req.session?.student) return res.status(401).json({ error: "Student login required" });
  const db = readDB();
  const competition = db.competitions.find(item => item.id === req.session.student.competitionId);
  refreshCompetitionStatuses(db);
  const accessError = competitionAccessError(competition);
  if (accessError) return sendCompetitionAccessError(res, accessError);
  if (competition.year !== req.session.student.year) {
    return res.status(403).json({ success: false, error: "YEAR_MISMATCH", message: "This competition is not assigned to your year." });
  }
  const p = db.participants[req.session.student.id];
  if (p) {
    p.lastSeenAt = new Date().toISOString();
    writeDB(db);
  }
  res.json({
    ok: true,
    status: competition.status,
    endTime: competition.endTime,
    serverTime: new Date().toISOString(),
    remainingSeconds: remainingCompetitionSeconds(competition)
  });
});

app.post("/api/student/violation", (req, res) => {
  if (!req.session?.student) return res.status(401).json({ error: "Student login required" });

  const reason = String(req.body.reason || "Unknown event").slice(0, 250);
  const db = readDB();
  const participant = db.participants[req.session.student.id];

  const event = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    participantId: req.session.student.id,
    name: participant?.name || req.session.student.name,
    team: participant?.team || req.session.student.team,
    year: participant?.year || req.session.student.year,
    competitionId: req.session.student.competitionId,
    competitionName: participant?.competitionName || "",
    reason,
    createdAt: new Date().toISOString()
  };

  db.violations.push(event);
  if (participant) participant.violations = (participant.violations || 0) + 1;
  writeDB(db);

  res.json({ ok: true, violationCount: participant?.violations || 1 });
});

app.post("/api/student/submit", async (req, res) => {
  if (!req.session?.student) return res.status(401).json({ error: "Student login required" });

  const sourceCode = String(req.body.code || "");
  const year = req.session.student.year;
  const competitionId = req.session.student.competitionId;
  const language = year === "SY" ? "cpp" : year === "TY" ? "java" : "";

  if (!sourceCode.trim()) return res.status(400).json({ error: "Code cannot be empty." });
  if (!LANGUAGES[language]) return res.status(400).json({ error: "Unsupported language." });

  const db = readDB();
  const competition = db.competitions.find(item => item.id === competitionId);
  refreshCompetitionStatuses(db);
  const accessError = competitionAccessError(competition);
  if (accessError) return sendCompetitionAccessError(res, accessError);
  const participant = db.participants[req.session.student.id];
  if (!participant) return res.status(404).json({ error: "Student participant record not found." });
  const problem = competition.problem || competition.problems?.[year];
  if (!problem) return res.status(409).json({ error: `There is no ${year} problem for this competition.` });

  const submission = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    participantId: req.session.student.id,
    competitionId,
    competitionName: competition.name,
    competitionCode: competition.code,
    name: participant?.name || req.session.student.name,
    team: participant?.team || req.session.student.team,
    year,
    language,
    code: sourceCode,
    problemId: problem.id,
    problemYear: year,
    problemTitle: problem.title,
    problemSnapshot: publicProblem(problem),
    createdAt: new Date().toISOString(),
    status: "Judging",
    passed: 0,
    total: problem.hiddenTests.length,
    tests: []
  };

  db.submissions.unshift(submission);
  writeDB(db);

  try {
    for (let i = 0; i < problem.hiddenTests.length; i++) {
      const test = problem.hiddenTests[i];

      const result = await judgeOne({
        sourceCode,
        languageId: LANGUAGES[language],
        stdin: test.input
      });

      const actual = normalizeOutput(result.stdout);
      const expected = normalizeOutput(test.expected);
      const accepted = result.status === "Accepted" && actual === expected;

      submission.tests.push({
        number: i + 1,
        passed: accepted,
        status: result.status,
        input: test.input,
        expectedOutput: test.expected,
        actualOutput: result.stdout,
        stderr: result.stderr,
        compileOutput: result.compileOutput,
        message: result.message,
        time: result.time,
        memory: result.memory
      });

      if (accepted) submission.passed++;
    }

    submission.status =
      submission.passed === submission.total ? "Accepted" : "Wrong Answer";

    const exceptionalTest = submission.tests.find(t =>
      t.status === "Compilation Error" ||
      t.status.startsWith("Runtime Error") ||
      ["Time Limit Exceeded", "Memory Limit Exceeded", "Output Limit Exceeded"].includes(t.status)
    );
    if (exceptionalTest) {
      submission.status = exceptionalTest.status;
    } else if (submission.tests.some(t => t.status === "Judge timeout" || t.status === "Unknown")) {
      submission.status = "Judge Error";
    } else if (submission.tests.some(t =>
      !["Accepted", "Wrong Answer"].includes(t.status)
    )) {
      submission.status = "Judge Error";
    }

    const latestDB = readDB();
    const submissionIndex = latestDB.submissions.findIndex(item => item.id === submission.id);
    if (submissionIndex === -1) latestDB.submissions.unshift(submission);
    else latestDB.submissions[submissionIndex] = submission;
    writeDB(latestDB);
    res.json({
      submissionId: submission.id,
      status: submission.status,
      passed: submission.passed,
      total: submission.total,
      tests: submission.tests.map(t => ({
        number: t.number,
        passed: t.passed,
        status: t.status,
        time: t.time,
        memory: t.memory,
        stderr: t.stderr,
        compileOutput: t.compileOutput
      }))
    });
  } catch (error) {
    submission.status = "Judge Error";
    submission.judgeError = error.message;
    const latestDB = readDB();
    const submissionIndex = latestDB.submissions.findIndex(item => item.id === submission.id);
    if (submissionIndex === -1) latestDB.submissions.unshift(submission);
    else latestDB.submissions[submissionIndex] = submission;
    writeDB(latestDB);
    res.status(502).json({ error: error.message, submissionId: submission.id });
  }
});

app.get("/api/admin/competitions", requireAdmin, (req, res) => {
  const db = readDB();
  refreshCompetitionStatuses(db);
  res.json({
    competitions: db.competitions.map(competition => ({
      ...competitionPublic(competition),
      participantCount: Object.values(db.participants).filter(participant => participant.competitionId === competition.id).length,
      submissionCount: db.submissions.filter(submission => submission.competitionId === competition.id).length,
      SY: competition.year === "SY" ? adminProblem(competition.problem || competition.problems?.SY) : null,
      TY: competition.year === "TY" ? adminProblem(competition.problem || competition.problems?.TY) : null
    }))
  });
});

app.post("/api/admin/competitions", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const year = String(req.body.year || "");
  const duration = Number(req.body.duration);
  if (!name) return res.status(400).json({ error: "Competition name is required." });
  if (!["SY", "TY"].includes(year)) return res.status(400).json({ error: "Competition year must be SY or TY." });
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    return res.status(400).json({ error: "Duration must be a whole number from 1 to 1440 minutes." });
  }
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    year,
    description,
    code: null,
    duration,
    status: "NOT_STARTED",
    createdAt: new Date().toISOString(),
    startTime: null,
    endTime: null,
    startedAt: null,
    endedAt: null,
    problem: null
  };
  db.competitions.unshift(competition);
  writeDB(db);
  res.status(201).json({ competition: competitionPublic(competition) });
});

app.put("/api/admin/competitions/:id/year", requireAdmin, (req, res) => {
  const year = String(req.body.year || "");
  if (!["SY", "TY"].includes(year)) return res.status(400).json({ error: "Competition year must be SY or TY." });
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = db.competitions.find(item => item.id === req.params.id);
  if (!competition) return res.status(404).json({ error: "Competition not found." });
  if (competition.status !== "NOT_STARTED") return res.status(409).json({ error: "Only a not-started competition can be assigned to a year." });
  if (competition.year && competition.year !== year) return res.status(409).json({ error: "The competition year cannot be changed after assignment." });
  if (competition.problems?.[year === "SY" ? "TY" : "SY"]) {
    return res.status(409).json({ error: "This competition contains a problem for the other year; clear it before assigning the year." });
  }
  competition.year = year;
  competition.problem = competition.problems?.[year] || competition.problem || null;
  delete competition.problems;
  writeDB(db);
  res.json({ competition: competitionPublic(competition) });
});

app.post("/api/admin/competitions/:id/code", requireAdmin, (req, res) => {
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = db.competitions.find(item => item.id === req.params.id);
  if (!competition) return res.status(404).json({ error: "Competition not found." });
  if (!["SY", "TY"].includes(competition.year)) {
    return res.status(409).json({ error: "Assign this competition to SY or TY before generating its code." });
  }
  if (competition.status !== "NOT_STARTED") {
    return res.status(409).json({ error: "A code can only be generated for a not-started competition." });
  }
  try {
    competition.code = createCompetitionCode(db.competitions);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  writeDB(db);
  res.json({ competition: competitionPublic(competition) });
});

app.put("/api/admin/competitions/:id/problems/:year", requireAdmin, (req, res) => {
  const year = req.params.year;
  if (!["SY", "TY"].includes(year)) return res.status(400).json({ error: "Year must be SY or TY." });
  let problem;
  try {
    problem = normalizeProblem(req.body, year);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = db.competitions.find(item => item.id === req.params.id);
  if (!competition) return res.status(404).json({ error: "Competition not found." });
  if (!competition.year) return res.status(409).json({ error: "Assign this competition to SY or TY before adding its problem." });
  if (competition.year !== year) {
    return res.status(409).json({ error: `This is a ${competition.year} competition; it can only have a ${competition.year} problem.` });
  }
  if (competition.status !== "NOT_STARTED") return res.status(409).json({ error: "Problems can only be changed before the competition starts." });
  problem.competitionId = competition.id;
  competition.problem = problem;
  delete competition.problems;
  writeDB(db);
  res.json({
    problem: {
      id: problem.id,
      year,
      language: problem.language,
      title: problem.title
    },
    hiddenTestCount: problem.hiddenTests.length
  });
});

app.delete("/api/admin/competitions/:id/problems/:year", requireAdmin, (req, res) => {
  const year = req.params.year;
  if (!["SY", "TY"].includes(year)) return res.status(400).json({ error: "Year must be SY or TY." });
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = db.competitions.find(item => item.id === req.params.id);
  if (!competition) return res.status(404).json({ error: "Competition not found." });
  if (!competition.year || competition.year !== year) {
    return res.status(409).json({ error: `This competition is not assigned to ${year}.` });
  }
  if (competition.status !== "NOT_STARTED") return res.status(409).json({ error: "Problems can only be changed before the competition starts." });
  if (!(competition.problem || competition.problems?.[year])) return res.status(404).json({ error: `There is no ${year} problem to clear.` });
  competition.problem = null;
  delete competition.problems;
  writeDB(db);
  res.json({ ok: true, year });
});

app.post("/api/admin/competitions/:id/start", requireAdmin, (req, res) => {
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = db.competitions.find(item => item.id === req.params.id);
  if (!competition) return res.status(404).json({ error: "Competition not found." });
  if (competition.status !== "NOT_STARTED") return res.status(409).json({ error: "Only a not-started competition can be started." });
  if (!["SY", "TY"].includes(competition.year)) {
    return res.status(409).json({ error: "Assign this competition to SY or TY before starting." });
  }
  if (!competition.code) return res.status(409).json({ error: "Generate a competition code before starting." });
  if (!(competition.problem || competition.problems?.[competition.year])) {
    return res.status(409).json({ error: `Save the ${competition.year} problem before starting.` });
  }
  const now = new Date();
  competition.status = "ACTIVE";
  competition.startTime = now.toISOString();
  competition.startedAt = competition.startTime;
  competition.endTime = new Date(now.getTime() + competition.duration * 60_000).toISOString();
  competition.endedAt = null;
  writeDB(db);
  res.json({ competition: competitionPublic(competition), endAt: competition.endTime });
});

app.post("/api/admin/competitions/:id/end", requireAdmin, (req, res) => {
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competition = db.competitions.find(item => item.id === req.params.id);
  if (!competition) return res.status(404).json({ error: "Competition not found." });
  if (competition.status !== "ACTIVE") return res.status(409).json({ error: "Competition is not active." });
  competition.status = "ENDED";
  competition.endedAt = new Date().toISOString();
  writeDB(db);
  res.json({ competition: competitionPublic(competition) });
});

app.post("/api/admin/login", (req, res) => {
  const username = String(req.body.username || "");
  const password = String(req.body.password || "");

  if (
    username === (process.env.ADMIN_USERNAME || "admin") &&
    password === (process.env.ADMIN_PASSWORD || "change-this-password")
  ) {
    req.session = { admin: true };
    return res.json({ ok: true });
  }

  res.status(401).json({ error: "Invalid admin credentials." });
});

app.post("/api/admin/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  const db = readDB();
  refreshCompetitionStatuses(db);
  const competitionId = String(req.query.competitionId || "");
  const competitions = db.competitions;
  const participants = Object.values(db.participants)
    .filter(p => !competitionId || p.competitionId === competitionId)
    .map(p => ({
    ...p,
    online: Date.now() - new Date(p.lastSeenAt).getTime() < 15000
  }));

  const storedSubmissions = db.submissions.filter(s =>
    !competitionId || s.competitionId === competitionId
  );
  const storedViolations = db.violations.filter(v =>
    !competitionId || v.competitionId === competitionId
  );
  const submissions = storedSubmissions.map(s => ({
    id: s.id,
    participantId: s.participantId,
    competitionId: s.competitionId || "",
    name: s.name,
    team: s.team,
    year: s.year || "—",
    language: s.language,
    problemYear: s.problemYear || s.year || "—",
    problemTitle: s.problemSnapshot?.title || "Previous problem",
    competitionName: s.competitionName || "Previous competition",
    competitionCode: s.competitionCode || db.competitions.find(competition => competition.id === s.competitionId)?.code || "",
    createdAt: s.createdAt,
    status: s.status,
    passed: s.passed,
    total: s.total
  }));

  res.json({
    problemStatus: {
      SY: Boolean(db.problems.SY),
      TY: Boolean(db.problems.TY)
    },
    competitions: competitions.map(competition => ({
      ...competitionPublic(competition),
      participantCount: Object.values(db.participants).filter(participant => participant.competitionId === competition.id).length,
      submissionCount: db.submissions.filter(submission => submission.competitionId === competition.id).length
    })),
    participants,
    submissions,
    violations: storedViolations.slice(0, 200),
    stats: {
      competitions: competitions.length,
      activeCompetitions: competitions.filter(competitionIsActive).length,
      participants: participants.length,
      online: participants.filter(p => p.online).length,
      submissions: storedSubmissions.length,
      accepted: storedSubmissions.filter(s => s.status === "Accepted").length,
      wrongAnswer: storedSubmissions.filter(s => s.status === "Wrong Answer").length,
      compilationErrors: storedSubmissions.filter(s => s.status === "Compilation Error").length,
      runtimeErrors: storedSubmissions.filter(s => s.status.startsWith("Runtime Error")).length,
      violations: storedViolations.length
    }
  });
});

app.get("/api/admin/submissions/:id", requireAdmin, (req, res) => {
  const db = readDB();
  const submission = db.submissions.find(s => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found." });

  res.json({
    submission: {
      ...submission,
      competitionCode: submission.competitionCode ||
        db.competitions.find(competition => competition.id === submission.competitionId)?.code || ""
    },
    problem: submission.problemSnapshot ||
      (db.problems[submission.problemYear || submission.year]?.id === submission.problemId
        ? publicProblem(db.problems[submission.problemYear || submission.year])
        : null),
    violations: db.violations.filter(v =>
      v.participantId === submission.participantId &&
      (!submission.competitionId || v.competitionId === submission.competitionId)
    )
  });
});

app.get("/api/admin/violations", requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.violations.slice(0, 500));
});

app.get("/api/admin/participants/:id", requireAdmin, (req, res) => {
  const db = readDB();
  const participant = db.participants[req.params.id];
  if (!participant) return res.status(404).json({ error: "Participant not found." });

  res.json({
    participant,
    submissions: db.submissions.filter(s => s.participantId === req.params.id),
    violations: db.violations.filter(v => v.participantId === req.params.id)
  });
});

app.get("/api/health/supabase", async (req, res) => {
  try {
    const result = await checkSupabaseConnection();
    res.status(result.connected ? 200 : 503).json(result);
  } catch (error) {
    console.error("Supabase connectivity check failed:", error.message);
    res.status(503).json({ connected: false, error: "Supabase connectivity check failed." });
  }
});

app.get(["/style.css", "/app.js", "/admin.css", "/admin.js"], (req, res) => {
  res.sendFile(path.join(__dirname, req.path.slice(1)));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).send("Not found");
});

function expireCompetitions() {
  try {
    const db = readDB();
    refreshCompetitionStatuses(db);
  } catch (error) {
    console.error("Unable to update competition lifecycle status:", error);
  }
}

expireCompetitions();
setInterval(expireCompetitions, 1000).unref();

app.listen(PORT, () => {
  console.log(`Code Club server running on http://localhost:${PORT}`);
});
