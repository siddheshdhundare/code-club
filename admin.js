async function api(url, options={}) {
  const r = await fetch(url, {...options, credentials:"same-origin", headers:{"Content-Type":"application/json", ...(options.headers||{})}});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error || "Request failed");
  return d;
}

let problemYear = "SY";
let selectedCompetitionId = "";
let competitions = [];
let managedProblems = { SY:null, TY:null };
let currentSubmissions = [];
let submissionYearFilter = "ALL";

async function login() {
  document.getElementById("err").textContent = "";
  try {
    await api("/api/admin/login", {method:"POST", body:JSON.stringify({
      username:document.getElementById("user").value,
      password:document.getElementById("pass").value
    })});
    document.getElementById("login").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    await loadCompetitions();
    await load();
    renderProblemEditor();
  } catch(e) { document.getElementById("err").textContent = e.message; }
}

async function logout() {
  await api("/api/admin/logout", {method:"POST"});
  location.reload();
}

async function load() {
  try {
    const competitionQuery = document.getElementById("submissionCompetitionFilter").value;
    const d = await api("/api/admin/dashboard" + (competitionQuery ? `?competitionId=${encodeURIComponent(competitionQuery)}` : ""));
    if (Array.isArray(d.competitions)) {
      const detailedCompetitions = new Map(competitions.map(item => [item.id, item]));
      competitions = d.competitions.map(item => ({
        ...item,
        SY:detailedCompetitions.get(item.id)?.SY,
        TY:detailedCompetitions.get(item.id)?.TY
      }));
      renderCompetitionRows(d.competitions);
      refreshCompetitionControls();
      refreshCompetitionOptions();
    }
    document.getElementById("sCompetitions").textContent = d.stats.competitions;
    document.getElementById("sActiveCompetitions").textContent = d.stats.activeCompetitions;
    document.getElementById("sParticipants").textContent = d.stats.participants;
    document.getElementById("sOnline").textContent = d.stats.online;
    document.getElementById("sSubmissions").textContent = d.stats.submissions;
    document.getElementById("sAccepted").textContent = d.stats.accepted;
    document.getElementById("sWrongAnswer").textContent = d.stats.wrongAnswer;
    document.getElementById("sCompilationErrors").textContent = d.stats.compilationErrors;
    document.getElementById("sRuntimeErrors").textContent = d.stats.runtimeErrors;
    document.getElementById("sViolations").textContent = d.stats.violations;

    document.getElementById("participants").innerHTML = d.participants.length ? d.participants.map(p => `
      <tr><td><b>${esc(p.name)}</b></td><td>${esc(p.team)}</td><td>${esc(p.year || "—")}</td><td>${esc(p.competitionName || "—")}</td>
      <td class="${p.online?"online":"offline"}">${p.online?"● Online":"○ Offline"}</td>
      <td>${p.violations||0}</td><td>${new Date(p.lastSeenAt).toLocaleTimeString()}</td></tr>`).join("")
      : `<tr><td colspan="7">No participants yet.</td></tr>`;

    currentSubmissions = d.submissions;
    renderSubmissions();

    document.getElementById("violations").innerHTML = d.violations.length ? d.violations.map(v => `
      <tr><td>${new Date(v.createdAt).toLocaleTimeString()}</td><td>${esc(v.name)}</td><td>${esc(v.team)}</td><td>${esc(v.year || "—")}</td><td>${esc(v.competitionName || "—")}</td><td>${esc(v.reason)}</td></tr>`).join("")
      : `<tr><td colspan="6">No violation events.</td></tr>`;
  } catch(e) {
    if (e.message.includes("Admin login")) location.reload();
    else document.getElementById("err").textContent = e.message;
  }
}

function renderSubmissions() {
  const selectedLanguage = document.getElementById("submissionLanguageFilter").value;
  const selectedResult = document.getElementById("submissionResultFilter").value;
  const matchesResult = status => {
    if (selectedResult === "ALL") return true;
    if (selectedResult === "COMPILE_ERROR") return status === "Compilation Error";
    if (selectedResult === "RUNTIME_ERROR") return status.startsWith("Runtime Error");
    if (selectedResult === "TIME_LIMIT") return status === "Time Limit Exceeded";
    return status === selectedResult;
  };
  const filtered = currentSubmissions.filter(s =>
    (submissionYearFilter === "ALL" || (s.problemYear || s.year) === submissionYearFilter) &&
    (selectedLanguage === "ALL" || s.language === selectedLanguage) &&
    matchesResult(s.status)
  );
  document.querySelectorAll(".filter-button").forEach(button => {
    button.classList.toggle("selected", button.dataset.year === submissionYearFilter);
  });
  document.getElementById("submissions").innerHTML = filtered.length ? filtered.map(s => `
    <tr><td>${new Date(s.createdAt).toLocaleString()}</td><td><b>${esc(s.name)}</b></td><td>${esc(s.team)}</td>
    <td>${esc(s.year || "—")}</td><td>${s.language==="cpp"?"C++":"Java"}</td><td>${esc(s.competitionName)}<br>${esc(s.competitionCode || "")}<br>${esc(s.problemTitle || "Previous problem")}</td>
    <td class="${s.status==="Accepted"?"accepted":"wrong"}">${esc(s.status)}</td>
    <td>${s.passed}/${s.total}</td><td><button class="view" onclick="viewSubmission('${esc(s.id)}')">View Details</button></td></tr>`).join("")
    : `<tr><td colspan="9">No submissions for this filter.</td></tr>`;
}

function statusLabel(status) {
  if (status === "ACTIVE") return "🟢 ACTIVE";
  if (status === "ENDED") return "🔴 ENDED";
  return "🟡 NOT STARTED";
}

function renderCompetitionRows(rows) {
  const selected = rows.find(item => item.id === selectedCompetitionId);
  document.getElementById("competitionLifecycleSummary").textContent = selected
    ? `${statusLabel(selected.status)} • ${selected.name} • ${selected.duration} minutes`
    : "Select a competition";
  const renderRows = year => {
    const yearRows = rows.filter(item => item.year === year);
    return yearRows.length ? yearRows.map(item => `
    <tr><td><b>${esc(item.name)}</b></td><td>${item.year} / ${item.language === "cpp" ? "C++" : "Java"}</td><td>${esc(item.code || "Not generated")}</td>
    <td class="competition-status ${item.status.toLowerCase()}">${statusLabel(item.status)}</td>
    <td>${item.duration} min</td><td>${item.startTime ? new Date(item.startTime).toLocaleString() : "—"}</td>
    <td>${item.endTime ? new Date(item.endTime).toLocaleString() : "—"}</td>
    <td>${item.participantCount || 0}</td><td>${item.submissionCount || 0}</td>
    <td class="competition-row-actions">
      <button type="button" data-comp-action="manage" data-comp-id="${esc(item.id)}">Manage Problem / Hidden Tests</button>
      <button type="button" data-comp-action="generate" data-comp-id="${esc(item.id)}" ${item.status !== "NOT_STARTED" || !item.year ? "disabled" : ""}>Generate Code</button>
      <button type="button" data-comp-action="start" data-comp-id="${esc(item.id)}" ${item.status !== "NOT_STARTED" || !item.code || !item.problems[year] ? "disabled" : ""}>Start</button>
      <button type="button" data-comp-action="end" data-comp-id="${esc(item.id)}" ${item.status !== "ACTIVE" ? "disabled" : ""}>End</button>
    </td></tr>`).join("")
      : `<tr><td colspan="10">No ${year} competition created yet.</td></tr>`;
  };
  document.getElementById("syCompetitionRows").innerHTML = renderRows("SY");
  document.getElementById("tyCompetitionRows").innerHTML = renderRows("TY");
  const unassigned = rows.filter(item => !["SY", "TY"].includes(item.year));
  document.getElementById("legacyCompetitionSection").classList.toggle("hidden", unassigned.length === 0);
  document.getElementById("legacyCompetitionRows").innerHTML = unassigned.map(item => `
    <tr><td>${esc(item.name)}</td><td>${esc(item.code || "—")}</td><td>${statusLabel(item.status)}</td>
    <td><select data-legacy-year="${esc(item.id)}"><option value="">Select year</option><option value="SY">SY / C++</option><option value="TY">TY / Java</option></select>
    <button type="button" data-comp-action="assign" data-comp-id="${esc(item.id)}">Assign</button></td></tr>`).join("");
}

function refreshCompetitionOptions() {
  const options = competitions.map(item =>
    `<option value="${esc(item.id)}">${esc(item.name)} • ${item.year || "Unassigned"} • ${item.status}</option>`
  ).join("");
  const selectedSubmissionCompetition = document.getElementById("submissionCompetitionFilter").value;
  document.getElementById("competitionSelect").innerHTML = options || `<option value="">No competitions</option>`;
  document.getElementById("problemCompetitionSelect").innerHTML =
    `<option value="">Select a competition</option>${options}`;
  document.getElementById("submissionCompetitionFilter").innerHTML =
    `<option value="">All competitions</option>${competitions.map(item =>
      `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}`;
  document.getElementById("competitionSelect").value = selectedCompetitionId;
  document.getElementById("problemCompetitionSelect").value = selectedCompetitionId;
  document.getElementById("submissionCompetitionFilter").value = selectedSubmissionCompetition;
}

function refreshCompetitionControls() {
  const current = competitions.find(item => item.id === selectedCompetitionId);
  document.getElementById("competitionStatus").textContent = current
    ? statusLabel(current.status)
    : "No competition selected";
  document.getElementById("competitionCodeDisplay").textContent = current?.code || "—";
  document.getElementById("competitionDescriptionDisplay").textContent = current?.description || current?.name || "";
  document.getElementById("generateCompetitionCodeButton").disabled = !current || !current.year || current.status !== "NOT_STARTED";
  document.getElementById("generateCompetitionCodeButton").textContent = "Generate Code";
  document.getElementById("startCompetitionButton").disabled =
    !current || current.status !== "NOT_STARTED" || !current.code || !current.year || !current[current.year];
  document.getElementById("endCompetitionButton").disabled = !current || current.status !== "ACTIVE";
  document.getElementById("problemForm").querySelectorAll("input,textarea,button").forEach(control => {
    control.disabled = !current || !current.year || current.status !== "NOT_STARTED";
  });
}

async function competitionRowAction(action, id) {
  const item = competitions.find(competition => competition.id === id);
  if (!item) return;
  selectCompetition(id, false);
  if (action === "manage") {
    document.getElementById("problemManager").scrollIntoView({behavior:"smooth"});
    return;
  }
  if (action === "generate") return generateCompetitionCode();
  if (action === "start") return startCompetition();
  if (action === "end") return endCompetition();
  if (action === "assign") {
    const year = [...document.querySelectorAll("[data-legacy-year]")]
      .find(select => select.dataset.legacyYear === id)?.value;
    if (!year) {
      document.getElementById("competitionError").textContent = "Select SY or TY before assigning the competition.";
      return;
    }
    try {
      await api(`/api/admin/competitions/${id}/year`, {method:"PUT", body:JSON.stringify({year})});
      await refreshCompetitions();
    } catch(e) {
      document.getElementById("competitionError").textContent = e.message;
    }
  }
}

document.getElementById("syCompetitionRows").addEventListener("click", event => {
  const button = event.target.closest("[data-comp-action]");
  if (button) competitionRowAction(button.dataset.compAction, button.dataset.compId);
});
document.getElementById("tyCompetitionRows").addEventListener("click", event => {
  const button = event.target.closest("[data-comp-action]");
  if (button) competitionRowAction(button.dataset.compAction, button.dataset.compId);
});
document.getElementById("legacyCompetitionRows").addEventListener("click", event => {
  const button = event.target.closest("[data-comp-action]");
  if (button) competitionRowAction(button.dataset.compAction, button.dataset.compId);
});

function filterSubmissions(year) {
  if (typeof year === "string") submissionYearFilter = year;
  renderSubmissions();
}

async function loadCompetitions() {
  try {
    const data = await api("/api/admin/competitions");
    competitions = data.competitions;
    if (!competitions.some(item => item.id === selectedCompetitionId)) {
      selectedCompetitionId = competitions[0]?.id || "";
    }
    refreshCompetitionOptions();
    selectCompetition(selectedCompetitionId, false);
  } catch(e) {
    document.getElementById("competitionError").textContent = e.message;
  }
}

async function refreshCompetitions() {
  await loadCompetitions();
  await load();
}

function selectCompetition(id, refresh=true) {
  selectedCompetitionId = id;
  const current = competitions.find(item => item.id === id);
  document.getElementById("competitionSelect").value = id;
  document.getElementById("problemCompetitionSelect").value = id;
  managedProblems = current ? {SY:current.SY, TY:current.TY} : {SY:null, TY:null};
  if (current?.year) problemYear = current.year;
  refreshCompetitionControls();
  if (current) renderProblemEditor();
  else clearProblemInputs();
  if (refresh) load();
}

function selectProblemCompetition(id) {
  selectCompetition(id);
}

document.getElementById("competitionForm").addEventListener("submit", async event => {
  event.preventDefault();
  document.getElementById("competitionError").textContent = "";
  try {
    const data = await api("/api/admin/competitions", {method:"POST", body:JSON.stringify({
      name:document.getElementById("competitionName").value,
      year:document.getElementById("competitionYear").value,
      description:document.getElementById("competitionDescription").value,
      duration:document.getElementById("competitionDuration").value
    })});
    selectedCompetitionId = data.competition.id;
    document.getElementById("competitionForm").reset();
    document.getElementById("competitionDuration").value = 30;
    await refreshCompetitions();
    document.getElementById("competitionError").textContent =
      `Competition created as NOT STARTED for ${data.competition.year}. Add its problem, generate its code separately, then start it.`;
    document.getElementById("competitionError").classList.add("success-message");
  } catch(e) {
    document.getElementById("competitionError").classList.remove("success-message");
    document.getElementById("competitionError").textContent = e.message;
  }
});

async function generateCompetitionCode() {
  if (!selectedCompetitionId) return;
  const message = document.getElementById("competitionError");
  message.textContent = "";
  try {
    const data = await api(`/api/admin/competitions/${selectedCompetitionId}/code`, {method:"POST"});
    await refreshCompetitions();
    message.textContent = `Competition code generated: ${data.competition.code}. Status remains NOT STARTED until you start it.`;
    message.classList.add("success-message");
  } catch(e) {
    message.classList.remove("success-message");
    message.textContent = e.message;
  }
}

async function startCompetition() {
  if (!selectedCompetitionId) return;
  try {
    await api(`/api/admin/competitions/${selectedCompetitionId}/start`, {method:"POST"});
    await refreshCompetitions();
  } catch(e) {
    document.getElementById("competitionError").textContent = e.message;
  }
}

async function endCompetition() {
  const current = competitions.find(item => item.id === selectedCompetitionId);
  if (!current || !confirm(`Are you sure you want to end this competition?\nStudents will no longer be able to submit code.`)) return;
  try {
    await api(`/api/admin/competitions/${selectedCompetitionId}/end`, {method:"POST"});
    await refreshCompetitions();
  } catch(e) {
    document.getElementById("competitionError").textContent = e.message;
  }
}

async function selectProblemYear(year) {
  const current = competitions.find(item => item.id === selectedCompetitionId);
  if (!["SY", "TY"].includes(year)) return;
  if (current?.year === year && year === problemYear) return;

  if (current && !current.year) {
    const language = year === "SY" ? "C++" : "Java";
    if (!confirm(`Assign "${current.name}" to ${year} / ${language}? This assignment cannot be changed later.`)) return;
    try {
      await api(`/api/admin/competitions/${current.id}/year`, {
        method:"PUT",
        body:JSON.stringify({year})
      });
      problemYear = year;
      await refreshCompetitions();
      const error = document.getElementById("problemError");
      error.textContent = `Competition assigned to ${year} / ${language}. You can now manage its problem.`;
      error.classList.add("success-message");
    } catch(e) {
      const error = document.getElementById("problemError");
      error.textContent = e.message;
      error.classList.remove("success-message");
    }
    return;
  }

  if (current?.year && current.year !== year) {
    const matchingCompetition = competitions.find(item => item.year === year);
    if (!matchingCompetition) {
      const error = document.getElementById("problemError");
      error.textContent = `No ${year} competition exists yet. Create a ${year} competition or select an unassigned one to assign it.`;
      error.classList.remove("success-message");
      return;
    }
    problemYear = year;
    selectCompetition(matchingCompetition.id);
    return;
  }

  if (!current) {
    const error = document.getElementById("problemError");
    error.textContent = `Select a competition, or create a ${year} competition, before managing its problem.`;
    error.classList.remove("success-message");
    return;
  }

  problemYear = year;
  renderProblemEditor();
}

function renderProblemEditor() {
  const language = problemYear === "SY" ? "C++" : "Java";
  const selectedCompetition = competitions.find(item => item.id === selectedCompetitionId);
  const locked = selectedCompetition?.status !== "NOT_STARTED";
  const disableEditor = () => document.getElementById("problemForm")
    .querySelectorAll("input,textarea,button")
    .forEach(control => { control.disabled = !selectedCompetitionId || !selectedCompetition?.year || locked; });
  document.getElementById("tabSY").classList.toggle("selected", problemYear === "SY");
  document.getElementById("tabSY").setAttribute("aria-selected", String(problemYear === "SY"));
  document.getElementById("tabTY").classList.toggle("selected", problemYear === "TY");
  document.getElementById("tabTY").setAttribute("aria-selected", String(problemYear === "TY"));
  document.getElementById("problemYearHeading").textContent = `${problemYear} — ${language}`;
  document.getElementById("clearActiveProblemButton").textContent = `Clear ${problemYear} Problem`;
  document.getElementById("clearActiveProblemButton").disabled =
    !selectedCompetitionId || locked;
  const problem = managedProblems[problemYear];
  document.getElementById("problemError").textContent = "";
  document.getElementById("problemError").classList.remove("success-message");

    if (!problem) {
      clearProblemInputs();
      document.getElementById("problemState").textContent = `No ${problemYear} problem saved`;
      document.getElementById("saveProblemButton").textContent = "Save Problem";
      addHiddenTest();
      disableEditor();
      document.getElementById("clearActiveProblemButton").disabled = true;
      return;
    }
    document.getElementById("problemTitle").value = problem.title;
    document.getElementById("problemStatement").value = problem.statement;
    document.getElementById("problemInputFormat").value = problem.inputFormat;
    document.getElementById("problemOutputFormat").value = problem.outputFormat;
    document.getElementById("problemConstraints").value = problem.constraints;
    document.getElementById("sampleInput").value = problem.sampleInput;
    document.getElementById("sampleOutput").value = problem.sampleOutput;
    document.getElementById("hiddenTestsEditor").replaceChildren();
    problem.hiddenTests.forEach(test => addHiddenTest(test));
    document.getElementById("problemState").textContent =
      `Saved: ${problem.title} • ${problem.hiddenTests.length} hidden test(s) • ${language}`;
    document.getElementById("saveProblemButton").textContent = "Update Problem";
    disableEditor();
}

function addHiddenTest(test={input:"", expected:""}) {
  const root = document.getElementById("hiddenTestsEditor");
  const card = document.createElement("div");
  card.className = "hidden-test-card";
  const title = document.createElement("div");
  title.className = "hidden-test-title";
  const label = document.createElement("b");
  label.textContent = `Test Case ${root.children.length + 1}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-test";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    card.remove();
    renumberHiddenTests();
  });
  title.append(label, remove);

  const fields = document.createElement("div");
  fields.className = "form-grid";
  fields.append(
    testField("Test Input", "test-input", test.input),
    testField("Expected Output", "test-expected", test.expected)
  );
  card.append(title, fields);
  root.append(card);
}

function testField(labelText, className, value) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const textarea = document.createElement("textarea");
  textarea.className = className;
  textarea.required = true;
  textarea.rows = 4;
  textarea.value = value;
  label.append(textarea);
  return label;
}

function renumberHiddenTests() {
  document.querySelectorAll(".hidden-test-title b").forEach((label, index) => {
    label.textContent = `Test Case ${index + 1}`;
  });
}

function clearProblemInputs() {
  document.getElementById("problemForm").reset();
  document.getElementById("hiddenTestsEditor").replaceChildren();
}

function resetProblemFields() {
  if (!confirm("Clear the problem editor fields? This does not remove the currently active problem.")) return;
  clearProblemInputs();
  addHiddenTest();
  document.getElementById("problemError").textContent = "";
}

async function clearActiveProblem() {
  if (!selectedCompetitionId || !confirm(`Remove the ${problemYear} problem? Students cannot join as ${problemYear} until it is saved again.`)) return;
  try {
    await api(`/api/admin/competitions/${selectedCompetitionId}/problems/${problemYear}`, {method:"DELETE"});
    managedProblems[problemYear] = null;
    await refreshCompetitions();
  } catch(e) {
    document.getElementById("problemError").textContent = e.message;
  }
}

document.getElementById("problemForm").addEventListener("submit", async event => {
  event.preventDefault();
  const error = document.getElementById("problemError");
  error.textContent = "";
  const hiddenTests = [...document.querySelectorAll(".hidden-test-card")].map(card => ({
    input:card.querySelector(".test-input").value,
    expected:card.querySelector(".test-expected").value
  }));
  try {
    if (!selectedCompetitionId) throw new Error("Create or select a competition first.");
    const data = await api(`/api/admin/competitions/${selectedCompetitionId}/problems/${problemYear}`, {method:"PUT", body:JSON.stringify({
      title:document.getElementById("problemTitle").value,
      statement:document.getElementById("problemStatement").value,
      inputFormat:document.getElementById("problemInputFormat").value,
      outputFormat:document.getElementById("problemOutputFormat").value,
      constraints:document.getElementById("problemConstraints").value,
      sampleInput:document.getElementById("sampleInput").value,
      sampleOutput:document.getElementById("sampleOutput").value,
      hiddenTests
    })});
    managedProblems[problemYear] = {
      ...data.problem,
      statement:document.getElementById("problemStatement").value,
      inputFormat:document.getElementById("problemInputFormat").value,
      outputFormat:document.getElementById("problemOutputFormat").value,
      constraints:document.getElementById("problemConstraints").value,
      sampleInput:document.getElementById("sampleInput").value,
      sampleOutput:document.getElementById("sampleOutput").value,
      hiddenTests
    };
    document.getElementById("problemState").textContent =
      `Saved: ${data.problem.title} • ${data.hiddenTestCount} hidden test(s) • ${problemYear === "SY" ? "C++" : "Java"}`;
    document.getElementById("saveProblemButton").textContent = "Update Problem";
    document.getElementById("clearActiveProblemButton").disabled = false;
    await refreshCompetitions();
    error.textContent = "Problem saved. This competition will serve the updated problem when it starts.";
    error.classList.add("success-message");
  } catch(e) {
    error.classList.remove("success-message");
    error.textContent = e.message;
  }
});

async function viewSubmission(id) {
  try {
    const d = await api("/api/admin/submissions/" + encodeURIComponent(id));
    const s = d.submission;
    document.getElementById("detailTitle").textContent = `${s.name} • ${s.team} • ${s.year || "—"} • ${s.status}`;
    document.getElementById("detailStudent").textContent =
      `Student: ${s.name}\nRoll / Team ID: ${s.team}\nYear: ${s.year || "—"}\nCompetition: ${s.competitionName || "—"}\nCompetition Code: ${s.competitionCode || "—"}\nLanguage: ${s.language==="cpp"?"C++":"Java"}\nSubmitted: ${new Date(s.createdAt).toLocaleString()}`;
    document.getElementById("detailMeta").innerHTML =
      `<p>Competition: <b>${esc(s.competitionName || "—")}</b> &nbsp; | &nbsp; Year: <b>${esc(s.problemYear || s.year || "—")}</b> &nbsp; | &nbsp; Language: <b>${s.language==="cpp"?"C++":"Java"}</b> &nbsp; | &nbsp; Score: <b>${s.passed}/${s.total}</b></p>`;
    document.getElementById("detailProblem").textContent =
      `Problem: ${d.problem?.title || "Problem"}\nYear: ${s.problemYear || s.year || "—"}\n\n${d.problem?.statement || ""}`;
    document.getElementById("detailInputFormat").textContent = d.problem?.input || "";
    document.getElementById("detailOutputFormat").textContent = d.problem?.output || "";
    document.getElementById("detailConstraints").textContent = (d.problem?.constraints || []).join("\n");
    document.getElementById("detailSample").textContent = d.problem?.examples?.length
      ? `Input:\n${d.problem.examples[0].input}\n\nOutput:\n${d.problem.examples[0].output}` : "";
    document.getElementById("detailCode").textContent = s.code;
    document.getElementById("detailTests").innerHTML = s.tests.map(t => `
      <div class="test-detail"><b>Test Case ${t.number}</b> —
      <span class="${t.passed?"pass":"fail"}">${t.passed?"PASSED":esc(t.status)}</span>
      <br><br>Input:<pre>${esc(t.input)}</pre>
      Expected:<pre>${esc(t.expectedOutput)}</pre>
      Actual:<pre>${esc(t.actualOutput)}</pre>
      <p>Execution time: ${esc(t.time ?? "N/A")} s &nbsp; | &nbsp; Memory: ${esc(t.memory ?? "N/A")} KB</p>
      ${t.stderr?`Error:<pre>${esc(t.stderr)}</pre>`:""}
      ${t.compileOutput?`Compiler:<pre>${esc(t.compileOutput)}</pre>`:""}
      ${t.message?`Message:<pre>${esc(t.message)}</pre>`:""}
      </div>`).join("");
    document.getElementById("detailViolations").innerHTML = d.violations.length
      ? d.violations.map(v => `<div class="violation-detail">${esc(v.reason)}<small>${new Date(v.createdAt).toLocaleString()} • Monitoring signal, not proof of cheating.</small></div>`).join("")
      : `<div class="violation-detail">No security signals recorded for this participant.</div>`;
    document.getElementById("detail").classList.remove("hidden");
  } catch(e) {
    document.getElementById("err").textContent = e.message;
  }
}

function closeDetail() { document.getElementById("detail").classList.add("hidden"); }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

setInterval(() => {
  if (!document.getElementById("dashboard").classList.contains("hidden")) load();
}, 5000);
