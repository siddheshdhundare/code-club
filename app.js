let participant = null;
let competition = null;
let competitionEndAt = null;
let serverClockOffset = 0;
let timeLeft = 0;
let violationCount = 0;
let lastViolation = 0;
let activeProblemId = null;
let timerInterval = null;
let competitionEnded = false;

const cppTemplate = `#include <bits/stdc++.h>
using namespace std;

int main() {
    // Write your solution here
    return 0;
}`;

const javaTemplate = `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws Exception {
        // Write your solution here
    }
}`;

async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {"Content-Type":"application/json", ...(options.headers || {})}
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(data.message || data.error || "Request failed");
    error.code = data.error;
    throw error;
  }
  return data;
}

async function studentLogin() {
  const name = document.getElementById("studentName").value.trim();
  const team = document.getElementById("teamName").value.trim();
  const year = document.getElementById("studentYear").value;
  const err = document.getElementById("loginError");
  err.textContent = "";
  try {
    const data = await api("/api/student/login", {
      method:"POST",
      body:JSON.stringify({name, team, year})
    });
    participant = data.participant;
    await showStudentCompetition(data.competition);
  } catch(e) { err.textContent = e.message; }
}

async function joinCompetition() {
  const error = document.getElementById("competitionCodeError");
  error.textContent = "";
  try {
    const data = await api("/api/student/join", {
      method:"POST",
      body:JSON.stringify({code:document.getElementById("competitionCode").value.trim()})
    });
    competition = data.competition;
    setCompetitionYear(competition);
    document.getElementById("competitionCodeScreen").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("joinedCompetitionLabel").textContent = competition.name;
  } catch(e) {
    error.textContent = e.message;
  }
}

function setCompetitionYear(info) {
  const year = document.getElementById("studentYear");
  if (!["SY", "TY"].includes(info?.year)) {
    year.value = "";
    year.disabled = true;
    document.getElementById("joinedCompetitionLabel").textContent = "This competition has no assigned year. Contact the administrator.";
    return;
  }
  year.value = info.year;
  year.disabled = true;
  const language = info.year === "SY" ? "C++" : "Java";
  document.getElementById("joinedCompetitionLabel").textContent =
    `${info.name} • ${info.year} • ${language}`;
}

async function showStudentCompetition(competitionInfo) {
  competition = competitionInfo || competition;
  if (!competition) throw new Error("Competition session information is unavailable.");
  competitionEnded = false;
  if (competition.serverTime) serverClockOffset = Date.parse(competition.serverTime) - Date.now();
  competitionEndAt = new Date(competition.endTime || competition.endAt).getTime();
  await loadProblem();
  document.getElementById("competitionCodeScreen").classList.add("hidden");
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("participantLabel").textContent =
    `${participant.team} • ${participant.name} • ${participant.year}`;
  document.getElementById("competitionLabel").textContent = `${competition.name} • Round 3`;
  document.getElementById("languageName").textContent = participant.year === "SY" ? "C++" : "Java";
  document.getElementById("code").value = participant.year === "SY" ? cppTemplate : javaTemplate;
  violationCount = participant.violations || 0;
  renderViolations();
  startTimer();
  setInterval(() => loadProblem().catch(e => {
    document.getElementById("securityLog").textContent = `Problem refresh failed: ${e.message}`;
  }), 10000);
}

async function loadProblem() {
  const p = await api("/api/problem");
  if (activeProblemId === p.id) return;
  activeProblemId = p.id;
  document.getElementById("problemTitle").textContent = p.title;
  document.getElementById("statement").textContent = p.statement;
  document.getElementById("inputFormat").textContent = p.input;
  document.getElementById("outputFormat").textContent = p.output;
  document.getElementById("constraints").innerHTML = p.constraints.map(x => `<li>${escapeHtml(x)}</li>`).join("");
  document.getElementById("exampleInput").textContent = "Input\n" + p.examples[0].input;
  document.getElementById("exampleOutput").textContent = "Output\n" + p.examples[0].output;
}

async function submitCode() {
  if (!competitionEndAt || Date.now() + serverClockOffset >= competitionEndAt) {
    showCompetitionEnded();
    return;
  }
  const btn = document.getElementById("submitBtn");
  const code = document.getElementById("code").value;
  if (!code.trim()) return;
  btn.disabled = true;
  btn.textContent = "Judging…";
  document.getElementById("status").className = "status waiting";
  document.getElementById("status").textContent = "Judging";
  document.getElementById("resultSummary").textContent = "Your code is being compiled and tested on the server.";
  document.getElementById("tests").innerHTML = "";
  document.getElementById("console").textContent = "Server-side execution in progress…";

  try {
    const data = await api("/api/student/submit", {
      method:"POST",
      body:JSON.stringify({code})
    });

    const accepted = data.status === "Accepted";
    document.getElementById("status").className = "status " + (accepted ? "accepted" : "wrong");
    document.getElementById("status").textContent = data.status;
    document.getElementById("resultSummary").textContent =
      `${data.passed}/${data.total} hidden test cases passed. ${accepted ? "Solution accepted." : "Solution is not accepted."}`;

    document.getElementById("tests").innerHTML = data.tests.map(t =>
      `<div class="test"><span>Test Case ${t.number}</span><b class="${t.passed ? "pass":"fail"}">${t.passed ? "PASSED" : t.status}</b></div>`
    ).join("");

    const errors = data.tests
      .map(t => t.stderr || t.compileOutput)
      .filter(Boolean);
    document.getElementById("console").textContent =
      `Status: ${data.status}\n\n${errors.length ? `Error:\n${errors.join("\n")}` : "No compilation or runtime errors."}`;
  } catch(e) {
    document.getElementById("status").className = "status wrong";
    document.getElementById("status").textContent = "Judge Error";
    document.getElementById("resultSummary").textContent = e.message;
    if (e.code === "COMPETITION_ENDED") showCompetitionEnded();
  } finally {
    if (!competitionEnded && Date.now() + serverClockOffset < competitionEndAt) {
      btn.disabled = false;
      btn.textContent = "Submit Solution";
    }
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  const update = () => {
    timeLeft = Math.max(0, Math.ceil((competitionEndAt - Date.now() - serverClockOffset) / 1000));
    const m = Math.floor(timeLeft/60), s = timeLeft%60;
    document.getElementById("timer").textContent =
      String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
    if (timeLeft === 0) showCompetitionEnded();
  };
  update();
  timerInterval = setInterval(update, 1000);
}

function showCompetitionEnded(message = "Competition Ended") {
  competitionEnded = true;
  const button = document.getElementById("submitBtn");
  button.disabled = true;
  button.textContent = "Competition Ended";
  document.getElementById("code").disabled = true;
  document.getElementById("timer").textContent = "00:00";
  document.getElementById("competitionLabel").textContent = `${competition?.name || "Competition"} • 🔴 ENDED`;
  document.getElementById("resultSummary").textContent = `🔴 ${message}`;
}

async function reportViolation(reason) {
  if (!participant) return;
  const now = Date.now();
  if (now - lastViolation < 1200) return;
  lastViolation = now;
  try {
    const data = await api("/api/student/violation", {
      method:"POST", body:JSON.stringify({reason})
    });
    violationCount = data.violationCount;
    renderViolations();
    document.getElementById("securityLog").textContent =
      `Recorded: ${reason} • ${new Date().toLocaleTimeString()}`;
  } catch(e) {
    document.getElementById("securityLog").textContent =
      `Could not record event: ${e.message}`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

function renderViolations() {
  document.getElementById("violations").textContent =
    `${violationCount} violation${violationCount === 1 ? "" : "s"}`;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) reportViolation("Competition page became hidden / participant left the page.");
});

window.addEventListener("blur", () => {
  reportViolation("Competition window lost focus.");
});

document.addEventListener("contextmenu", e => {
  e.preventDefault();
  reportViolation("Right-click attempted.");
});

document.addEventListener("copy", e => {
  e.preventDefault();
  reportViolation("Copy attempted.");
});

document.addEventListener("cut", e => {
  e.preventDefault();
  reportViolation("Cut attempted.");
});

document.addEventListener("keydown", e => {
  const k = e.key.toLowerCase();
  if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (k === "i" || k === "j")) || (e.ctrlKey && k === "u")) {
    e.preventDefault();
    reportViolation("Developer tools / page-source shortcut attempted.");
  }
});

setInterval(() => {
  if (!participant) return;
  api("/api/student/heartbeat", {method:"POST"}).then(data => {
    if (data.serverTime) serverClockOffset = Date.parse(data.serverTime) - Date.now();
    if (data.status !== "ACTIVE" || data.remainingSeconds <= 0) showCompetitionEnded();
  }).catch(e => {
    if (e.code === "COMPETITION_ENDED") showCompetitionEnded();
    else document.getElementById("securityLog").textContent = `Heartbeat failed: ${e.message}`;
  });
}, 5000);

(async function restoreCompetitionSession() {
  try {
    const data = await api("/api/student/me");
    participant = data.participant;
    await showStudentCompetition(data.competition);
    return;
  } catch(e) {
    if (!e.message.includes("Student login required")) {
      document.getElementById("competitionCodeError").textContent = e.message;
      return;
    }
  }
  try {
    const data = await api("/api/student/joined");
    competition = data.competition;
    setCompetitionYear(competition);
    document.getElementById("competitionCodeScreen").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
  } catch(e) {
    if (!e.message.includes("Join a competition first")) {
      document.getElementById("competitionCodeError").textContent = e.message;
    }
  }
})();
