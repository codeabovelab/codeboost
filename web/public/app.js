const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const credential =
  location.hash.slice(1) || sessionStorage.getItem("codeboost-token") || "";
if (location.hash) {
  sessionStorage.setItem("codeboost-token", credential);
  history.replaceState(null, "", location.pathname + location.search);
}
let data,
  selected,
  change = 0,
  mode = "question",
  // The reviewer's explicit view choice, held only for the item and server-named stale state (staleKey) it was made on; otherwise a stale item opens the comparison.
  sinceChoice = null,
  busy = false,
  busyKind = null,
  busyGeneration = 0;
let reviewGeneration = 0;
let view = "review";
let mergeGeneration = 0,
  mergeObservationGeneration = 0,
  mergePollTimer = null,
  mergePollState = null,
  mergePollDelay = 2000,
  // One merge poll chain at a time (#48): the poll in flight, by generation and sequence. A render while it runs does not
  // start another, and only the latest poll's answer or error is applied.
  mergePollSequence = 0,
  mergePollInFlight = null;
const mergePollMaximumDelay = 30000;
const drafts = new Map();
const attachments = new Map();
let snippetSelection = null;
// Kept until the server answers, so a resend after a lost response replays the same click instead of merging twice.
// The key travels with the exact request it was made for: a later Refresh changes data.token, not this request.
let mergeAction = null;
// True while a Merge PR click's request is in flight: a render meanwhile (selecting an item, a plan reload) keeps the
// control marked and labelled as pending instead of offering it again from `merge.ready`.
let mergeClickPending = false;
const statusClass = (text) =>
  text.startsWith("✓")
    ? "good"
    : text.startsWith("✕")
      ? "bad"
      : text.startsWith("!")
        ? "warn"
        : "neutral";
function beginBusy(kind) {
  busy = true;
  busyKind = kind;
  return ++busyGeneration;
}
function endBusy(owner) {
  if (owner !== busyGeneration) return;
  busy = false;
  busyKind = null;
  renderAttachment();
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      "x-codeboost-token": credential,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || "Request failed."), { status: response.status, outcomeUnknown: value.outcomeUnknown === true,
    ...(value.job && typeof value.job === "object" ? { job: value.job } : {}) });
  return value;
}
// Before the first review load no item is selected; text typed then is kept under "" until render() selects an item.
function rememberDraft() {
  drafts.set(`${selected ?? ""}:${mode}`, $("message").value);
}
function adoptUnselectedDrafts() {
  for (const kind of ["question", "change"]) {
    const text = drafts.get(`:${kind}`);
    drafts.delete(`:${kind}`);
    if (text) drafts.set(`${selected}:${kind}`, text);
  }
}
function showFailure(message, planStatusOwner) {
  mergeGeneration++;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  data = null;
  snippetSelection = null;
  renderPlans();
  const planStatusClass = view === "plans" ? "bad" : "neutral";
  const planStatusMessage = view === "plans" ? `✕ ${message}` : "";
  if (planStatusOwner === undefined) claimPlanStatus(planStatusClass, planStatusMessage);
  else setPlanStatus(planStatusOwner, planStatusClass, planStatusMessage);
  $("selection-actions").hidden = true;
  $("attachment").hidden = true;
  $("banner").textContent = message;
  $("progress").textContent = "Review unavailable";
  $("item-title").textContent = "Review unavailable";
  $("change-count").textContent = "";
  for (const id of [
    "items",
    "attention",
    "notes",
    "checks",
    "view-toggle",
    "item-details",
  ])
    $(id).innerHTML = "";
  $("approve").hidden = true;
  // Focus on a merge control about to be hidden moves to Refresh rather than falling to the page.
  if (["merge", "merge-details", "merge-cancel"].includes(document.activeElement?.id)) $("reload").focus();
  $("merge").hidden = true;
  $("merge-details").hidden = true;
  $("merge-steps-bar").hidden = true;
  if (mergeStepTimer) { clearInterval(mergeStepTimer); mergeStepTimer = null; }
  $("message").disabled = true;
  $("save-note").disabled = true;
  $("previous").disabled = true;
  $("next").disabled = true;
  $("code").innerHTML =
    '<div class="empty"><h2>Review could not load</h2><p>Refresh after resolving the error above.</p></div>';
}
async function refresh() {
  if (busy || planImportPending) return;
  supersedePlanRefresh();
  const planStatusOwner = planStatusGeneration;
  const busyOwner = beginBusy("read");
  const generation = ++reviewGeneration;
  const mergeObservationOwner = mergeObservationGeneration;
  mergeGeneration++;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  renderAttachment();
  $("banner").textContent = "Linking changes to plan items…";
  if (!data) {
    setPlanStatus(planStatusOwner, "neutral", "Loading the current plan…");
    renderPlans();
  }
  try {
    rememberDraft();
    const updated = await api("/api/review");
    if (generation !== reviewGeneration) return;
    mergeGeneration++;
    if (mergePollTimer) clearTimeout(mergePollTimer);
    mergePollTimer = null;
    mergePollState = null;
    mergePollDelay = 2000;
    rememberDraft();
    const newer = newerMergeObservations(updated, mergeObservationOwner);
    data = preserveSettledQuestionAnswers(withNewerMergeObservations(updated, newer));
    snippetSelection = null;
    render();
    showNewerMergeObservations(newer);
    setPlanStatus(planStatusOwner, "good", `✓ Revision r${data.plan.revision} is current.`);
  } catch (error) {
    if (generation !== reviewGeneration) return;
    rememberDraft();
    showFailure(
      `Could not read this branch’s history. ${error.message} Use Refresh to retry.`,
      planStatusOwner,
    );
  } finally {
    endBusy(busyOwner);
    // showFailure rendered the Plans screen while this read still counted as loading.
    if (!data) renderPlans();
  }
}
/**
 * Where focus goes when the focused merge control hides: Merge PR while it is shown and not `disabled` (an
 * `aria-disabled` Merge PR still takes focus), otherwise Refresh.
 */
function mergeFocusFallback() {
  return !$("merge").hidden && !$("merge").disabled ? $("merge") : $("reload");
}
function renderMerge() {
  // Read before rendering: hiding the focused control itself blurs it at once (hiding its parent does so at the next
  // frame). A render that hides the focused merge control, its blockers button or Cancel moves focus to the fallback once
  // every control's final state is set (AGENTS.md).
  const focused = document.activeElement;
  renderMergeControls();
  renderMergeSteps(focused);
  if ((focused === $("merge") || focused === $("merge-details")) && focused.hidden) mergeFocusFallback().focus();
}
function renderMergeControls() {
  const merge = data?.merge;
  $("merge").hidden = !merge?.available;
  // Decided once: a running job shows Merge status even with no blockers, and hiding then showing the focused button
  // would blur it (and move focus) on every poll.
  $("merge-details").hidden = !merge?.available || (!merge.blockers.length && !merge.queue && merge.job?.state !== "running");
  if (!merge?.available) return;
  // Once the attempt this retained key started has ended, a retry is a new action and needs a new key.
  if (mergeAction && merge.queue?.actionId === mergeAction.actionId && ["merged", "removed", "failed"].includes(merge.queue.state)) mergeAction = null;
  // Likewise once the merge job this key started has ended (a job is saved under its click's action ID), or a job newer
  // than the one shown when the key was made is the latest: one job runs at a time, so this key's job has ended or never
  // started. Either way a click is a new action. The job shown when the key was made says nothing about its click.
  if (mergeAction && merge.job && (merge.job.id === mergeAction.actionId ? merge.job.state !== "running" : merge.job.id !== mergeAction.jobBefore))
    mergeAction = null;
  // With merge jobs (their status carries `job`), a click's answer arrives while the control may hold focus, so it is
  // marked, never disabled; activation is ignored while the merge is not ready.
  if ("job" in merge) {
    $("merge").disabled = false;
    if (merge.ready) $("merge").removeAttribute("aria-disabled");
    else $("merge").setAttribute("aria-disabled", "true");
  } else {
    $("merge").disabled = !merge.ready;
    $("merge").removeAttribute("aria-disabled");
  }
  if (mergeClickPending) {
    if ("job" in merge) $("merge").setAttribute("aria-disabled", "true");
    else $("merge").disabled = true;
    $("merge").textContent = "Requesting merge…";
    $("merge-details").textContent = merge.queue ? "Merge status" : "Review blockers";
    scheduleMergePoll();
    return;
  }
  const job = merge.job;
  if (job?.state === "running") {
    // Keep the control focusable while its job runs; repeat activation is ignored because the merge is not ready.
    $("merge").setAttribute("aria-disabled", "true");
    $("merge").textContent = mergeJobStepLabel(job);
    $("merge-details").textContent = "Merge status";
    scheduleMergePoll();
    return;
  }
  // The page saw its job end and has not reloaded: name the outcome, not the blockers the job already resolved.
  const jobEnded = merge.blockers.some(blocker => blocker.code === "job-refresh");
  $("merge").textContent = jobEnded
    ? endedMergeJobLabel(job)
    : merge.action === "retry"
    ? "Retry merge"
    : merge.queue?.state === "submitting"
      ? "Submitting…"
      : merge.queue?.state === "queued"
        ? "Merge queued"
        : merge.queue?.state === "merged"
          ? "Merged"
          : merge.ready
            ? "Merge PR"
            : `${merge.blockers.length} blocker${merge.blockers.length === 1 ? "" : "s"}`;
  $("merge-details").textContent = merge.queue || jobEnded ? "Merge status" : "Review blockers";
  scheduleMergePoll();
}
function scheduleMergePoll() {
  // The poll in flight reschedules itself when it settles; a second chain could apply an older answer after a newer one.
  if (mergePollInFlight?.generation === mergeGeneration) return;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  const queue = data?.merge?.queue;
  const job = data?.merge?.job;
  // A new step of the list, or a cancel, polls quickly again, as a new job step does: a cancel usually ends the job at once.
  const state = job?.state === "running"
    ? `job:${job.step}:${job.steps?.find(step => step.state === "running")?.name ?? ""}:${job.cancelRequested ? "cancel" : ""}` : queue?.state;
  // A cancel's answer carried an ended job later than the one shown: polls continue until the page shows it, also when a
  // poll already on its way showed the shown job end.
  const unshownEnd = !!job && !!mergeCancelEnded && laterMergeJob(mergeCancelEnded, job);
  if (job?.state === "running" || unshownEnd || (queue?.kind === "queue" && ["submitting", "queued"].includes(state))) {
    if (state !== mergePollState) {
      mergePollState = state;
      mergePollDelay = 2000;
    }
    const generation = mergeGeneration;
    mergePollTimer = setTimeout(() => pollMergeQueue(generation), mergePollDelay);
  } else {
    mergePollState = null;
    mergePollDelay = 2000;
  }
}
function backOffMergePoll() {
  mergePollDelay = Math.min(mergePollDelay * 2, mergePollMaximumDelay);
}
async function pollMergeQueue(generation) {
  mergePollTimer = null;
  const sequence = ++mergePollSequence;
  mergePollInFlight = { generation, sequence };
  // Settles this poll's ownership and says whether its result may still be applied: only the latest poll's, and only
  // while its generation is current.
  const settle = () => {
    const latest = mergePollInFlight?.sequence === sequence;
    if (latest) mergePollInFlight = null;
    return latest && generation === mergeGeneration && !!data?.merge?.available;
  };
  // Decided once, when the request settles: an error thrown while applying a current answer is still reported, and
  // polling still continues.
  let current;
  try {
    const update = await api("/api/merge");
    current = settle();
    if (!current) return;
    const job = update.job;
    const shownJob = data.merge.job;
    // A poll read before a cancel's answer was adopted must not restore an older record of the same job, or a record
    // of an older job than the one shown (a newer job the cancel's answer carried).
    const stale = shownJob?.state === "running" && !!job
      && (job.id === shownJob.id ? job.revision < shownJob.revision : !laterMergeJob(job, shownJob));
    // A later job is followed also once the shown job ended (a cancel's answer that carried it asks this poll, or the
    // queue poll after a job that ended `queued` reads it). The shown job's queue attempt is not the later job's: it is
    // dropped, and only the later job's own attempt is kept (by its merge action ID).
    const laterJob = !!shownJob && !!job && job.id !== shownJob.id && laterMergeJob(job, shownJob);
    if (laterJob) data = { ...data, merge: { ...data.merge, queue: null } };
    if (shownJob?.state === "running" || laterJob) {
      // A full review response read before this observation must not restore an older record of this job.
      mergeObservationGeneration++;
      // A merge job (F6b): follow its step. Once it ends, update only the merge control, as the merge-queue poll does:
      // a background reload would erase the person's selection and input; Refresh shows the outcome.
      if (stale) {
        backOffMergePoll();
        renderMerge();
        return;
      }
      if (job?.state === "running") {
        // Any saved change (a step, the waiting checks, a cancel) is a later revision of the record.
        const changed = job.revision !== data.merge.job.revision || job.step !== data.merge.job.step
          || JSON.stringify(job.checks) !== JSON.stringify(data.merge.job.checks);
        // A later job is followed as a newer job is (withMergeJobObservation), without the ended job's blocker.
        data = laterJob ? withMergeJobObservation(data, job) : { ...data, merge: { ...data.merge, job } };
        // A cancel's refusal stays in the banner until the job's record changes: it is the only explanation of a Cancel
        // that stayed enabled.
        // Written again on every poll, so a reload or a failed poll that rewrote the banner meanwhile is corrected.
        if (mergeCancelRefusal?.key !== `${job.id}:${job.revision}`) mergeCancelRefusal = null;
        $("banner").textContent = mergeCancelRefusal ? mergeCancelRefusal.text : mergeJobText(job);
        if (!changed) backOffMergePoll();
        renderMerge();
        return;
      }
      // A job that ended `queued` left its attempt in GitHub's queue: follow it, as after a click answered with it.
      data = withEndedJobAndAttempt(data, job, update.queue);
      showEndedJobAndAttempt(job, update.queue);
      renderMerge();
      return;
    }
    const queue = update.queue;
    // An ended job the page shows keeps its outcome against a poll that read it, or an older job, before it ended (one
    // already on its way when a click's answer showed it end), and against an answer that is not about its own merge
    // attempt. Its own attempt (by its merge action ID: a job that ended `queued` or `submitted`) is still followed.
    if (shownJob && shownJob.state !== "running") {
      const readEarlier = !!job && laterMergeJob(shownJob, job);
      if (readEarlier || !isEndedJobQueue(shownJob, queue)) {
        backOffMergePoll();
        renderMerge();
        return;
      }
    }
    mergeObservationGeneration++;
    data = withMergeQueue(data, queue);
    showMergeQueueStatus(queue);
    if (queue?.state === mergePollState) backOffMergePoll();
    renderMerge();
  } catch (error) {
    current ??= settle();
    if (!current) return;
    $("banner").textContent = `Could not refresh merge status. ${error.message}`;
    backOffMergePoll();
    scheduleMergePoll();
  }
}
function mergeJobText(job) {
  if (job.state === "running" && job.cancelRequested) return "Cancelling the merge. The task and its pull request stay open.";
  if (job.state === "running") return job.step === "checks"
    ? `Waiting for required checks${job.checks.length ? `: ${job.checks.map(check => `${check.context} is ${check.state}`).join(", ")}` : ""}.`
    : job.step === "merging" ? "Merging the reviewed head." : "Preparing the merge: refresh, rebase, push and command checks.";
  return {
    merged: "Merged.", queued: "Merge queued. Waiting for GitHub to confirm the outcome.",
    submitted: `Merge submitted; GitHub's outcome is not confirmed yet. ${job.reason ?? ""}`.trim(),
    // The server's reason ends with the next step, which depends on the cause (a timeout waits; a failing check is fixed).
    blocked: `Approved, merge blocked. ${job.reason ?? "Retry merge when ready."}`,
    "review-required": `Review needed before merging. ${job.reason ?? ""}`.trim(),
    // A failed job's reason says why (and anything to do first); the next step is always to merge again, said once here.
    failed: `Merge stopped.${job.reason ? ` ${job.reason}` : ""} Merge again when ready.`,
    // A cancel of the merge alone says the task stays open; a cancelled task needs no more words.
    cancelled: job.reason && job.reason !== "Task cancelled." ? `Merge cancelled. ${job.reason}` : "Merge cancelled.",
  }[job.state] ?? job.state;
}
/** The running job's step, as the Merge control and its status dialog name it. */
function mergeJobStepLabel(job) {
  if (job.cancelRequested) return "Cancelling…";
  return { preparing: "Preparing…", checks: "Waiting for checks…", merging: "Merging…" }[job.step] ?? "Merging…";
}
// The design's merge step list (D16). Each state is an icon, a word and a color (DESIGN.md).
const mergeStepNames = { fetch: "Fetch", rebase: "Rebase", push: "Push", commands: "Re-run checks", checks: "GitHub checks",
  "already-fixed": "Already-fixed check", merge: "Merge" };
const mergeStepStates = { pending: ["○", "Waiting"], running: ["●", "Running"], done: ["✓", "Done"], skipped: ["–", "Skipped"],
  failed: ["✕", "Failed"], stopped: ["!", "Stopped"], unknown: ["!", "Unknown"] };
/** The ID of the job a cancel request is on its way for, or null. */
let mergeCancelPending = null;
/**
 * The latest ended job record a cancel's answer carried, or null. Any record older than it (an earlier revision of that
 * job, or an older job) is shown with Cancel requested: a poll or reload read before that job ended still reports it, or
 * the job it replaced, running.
 */
let mergeCancelEnded = null;
/** A cancel's refusal and the `id:revision` of the job record it was given for, or null. */
let mergeCancelRefusal = null;
let mergeStepTimer = null;
function mergeStepElapsed(step, now = Date.now()) {
  if (!step.startedAt) return "";
  const ms = Math.max(0, (step.endedAt ? Date.parse(step.endedAt) : now) - Date.parse(step.startedAt));
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}
/**
 * The step list under the review strip, with Cancel, while a job runs and after the page saw it end (until the review
 * reloads). A job saved before step lists existed has none: the control and banner say its step, as before. `focused` is
 * the element that had focus before the update began (the caller reads it before any control hides).
 */
function renderMergeSteps(focused = document.activeElement) {
  const job = data?.merge?.available ? data.merge.job : null;
  const ended = data?.merge?.blockers?.some(blocker => blocker.code === "job-refresh") || (!!job && data.merge.endedJobShown === job.id);
  const shown = !!job?.steps && (job.state === "running" || ended);
  $("merge-steps-bar").hidden = !shown;
  if (mergeStepTimer && !(shown && job.state === "running")) { clearInterval(mergeStepTimer); mergeStepTimer = null; }
  // Hiding a focused Cancel (or the whole bar) would drop keyboard focus to the page: it moves to the fallback instead.
  if ((!shown || job.state !== "running") && focused === $("merge-cancel")) mergeFocusFallback().focus();
  if (!shown) return;
  // Rebuilt only when a step changes; the timer below rewrites the elapsed times alone, so a screen reader keeps its place.
  const key = JSON.stringify(job.steps);
  if ($("merge-steps").dataset.steps !== key) {
    $("merge-steps").dataset.steps = key;
    $("merge-steps").innerHTML = job.steps.map(step => {
      const [icon, word] = mergeStepStates[step.state] ?? ["?", step.state];
      // Screen readers skip the mark and read the name, the word and the time (DESIGN.md).
      return `<li class="merge-step merge-step-${esc(step.state)}"><span class="mark" aria-hidden="true">${icon}</span> <span>${esc(mergeStepNames[step.name] ?? step.name)}</span> <span class="word">${esc(word)}</span><span class="mono muted elapsed"></span></li>`;
    }).join("");
  }
  updateMergeStepTimes(job);
  const cancel = $("merge-cancel");
  cancel.hidden = job.state !== "running";
  // GitHub was asked once the merge step started: stopping then could only make the outcome unknown, so the server refuses.
  const asked = job.steps.some(step => step.name === "merge" && step.state !== "pending");
  const pending = mergeCancelPending === job.id || (!!mergeCancelEnded && laterMergeJob(mergeCancelEnded, job));
  const blocked = asked || job.cancelRequested || pending;
  if (blocked) cancel.setAttribute("aria-disabled", "true"); else cancel.removeAttribute("aria-disabled");
  cancel.textContent = job.cancelRequested || pending ? "Cancel requested" : "Cancel merge";
  cancel.title = asked ? "GitHub has been asked to merge; wait for its outcome." : "Stop this merge. The task and its pull request stay open.";
  // An `aria-disabled` Cancel ignores clicks, so the reason is also written out, and describes the button only while shown (a
  // hidden element named by aria-describedby is still read).
  const noted = asked && job.state === "running";
  $("merge-cancel-note").hidden = !noted;
  if (noted) cancel.setAttribute("aria-describedby", "merge-cancel-note"); else cancel.removeAttribute("aria-describedby");
  if (job.state === "running" && !mergeStepTimer) mergeStepTimer = setInterval(() => {
    const current = data?.merge?.job;
    if (current?.steps && current.state === "running") updateMergeStepTimes(current);
  }, 1000);
}
/** Each step's elapsed time, as text after its word. */
function updateMergeStepTimes(job) {
  const items = $("merge-steps").children;
  job.steps.forEach((step, index) => {
    const elapsed = mergeStepElapsed(step), time = items[index]?.querySelector(".elapsed");
    if (time) time.textContent = elapsed ? `, ${elapsed}` : "";
  });
}
$("merge-cancel").onclick = async () => {
  const job = data?.merge?.job;
  if (!job || job.state !== "running" || $("merge-cancel").getAttribute("aria-disabled") === "true") return;
  mergeCancelPending = job.id;
  renderMergeSteps();
  // The ended record an answer carried: shown with the outcome by the poll it asks for.
  let pollNow = false, ended = null;
  const adopt = answered => {
    const shownJob = data?.merge?.job;
    if (!answered || !shownJob) return;
    if (answered.id === shownJob.id) {
      // Already observed (an older or the same record, including the ended record the poll already showed): nothing to do.
      if (!(answered.revision > shownJob.revision)) return;
      // The job ended: the poll presents the outcome, follows a queued attempt and keeps the step list, so it is asked
      // at once. A later running record is adopted.
      if (answered.state !== "running") { pollNow = true; ended = answered; return; }
      mergeObservationGeneration++;
      data = { ...data, merge: { ...data.merge, job: answered } };
      $("banner").textContent = mergeJobText(answered);
      return;
    }
    // A newer job another tab started: followed as the poll follows a job, whatever this page last saw of the older one.
    // A newer job that ended is presented by the poll (with its queue attempt), also when the shown job ended first.
    if (!laterMergeJob(answered, shownJob)) return;
    if (answered.state === "running") {
      mergeObservationGeneration++;
      // The older job's queue attempt is not the newer job's.
      data = withMergeJobObservation({ ...data, merge: { ...data.merge, queue: null } }, answered);
      $("banner").textContent = mergeJobText(answered);
    } else { pollNow = true; ended = answered; }
  };
  try { adopt((await api("/api/action", { action: "cancel-merge", jobId: job.id })).job); }
  catch (error) {
    adopt(error.job);
    // Only while the job this cancel was for is still shown running: an outcome the poll showed meanwhile, or a newer
    // job, says more than the refusal.
    if (data?.merge?.job?.id === job.id && data.merge.job.state === "running") {
      mergeCancelRefusal = { key: `${job.id}:${data.merge.job.revision}`, text: `Could not cancel the merge. ${error.message}` };
      $("banner").textContent = mergeCancelRefusal.text;
    }
  } finally {
    // Only this cancel's own pending state: a later cancel of a newer job keeps its own.
    if (mergeCancelPending === job.id) mergeCancelPending = null;
    // Answered as ended: Cancel stays unavailable for every record older than the ended one, until the page shows it. An
    // answer is newer than the record shown, not always than the one held (a late answer for an older job), so the later
    // ended record is kept.
    if (pollNow && (!mergeCancelEnded || laterMergeJob(ended, mergeCancelEnded))) mergeCancelEnded = ended;
    renderMerge();
    if (pollNow) {
      if (mergePollInFlight?.generation === mergeGeneration) {
        // That poll may have read the job before it ended: whatever it answers, the next poll comes 2 s after it.
        mergePollState = null;
        mergePollDelay = 2000;
      } else {
        // A poll in flight for an older generation is discarded when it settles, so it does not stand in for this one.
        if (mergePollTimer) clearTimeout(mergePollTimer);
        void pollMergeQueue(mergeGeneration);
      }
    }
  }
};
const mergeLifecycleBlockers = new Set(["merge-submitted", "queue-active", "queue-head", "queue-merged", "queue-refresh", "stale-merge", "job-refresh"]);
/** Outcomes of a job that asked GitHub to merge, which it does only once no blocker remains. */
const mergeJobReachedMerge = new Set(["merged", "queued", "submitted"]);
/**
 * The view once the page learns its merge job ended, without a reload: the job's outcome and "Refresh to see the
 * result". A job that reached the merge (merged, queued or submitted) settled the blockers the server lists in
 * `settledBeforeJobMerge` (preparation, a moved base, `cmd:` checks, required checks, mergeability), so a review read
 * before or during it no longer lists them. Any other outcome keeps every blocker the page last read: a blocked job's
 * failing check still fails, and Refresh shows what still applies. A job the poll no longer reports (`job` null) is
 * not known to have reached the merge, so it also keeps every blocker. The control reads the outcome, as after a queue merge.
 */
function withEndedMergeJob(view, job, message) {
  const settled = new Set(mergeJobReachedMerge.has(job?.state) ? view.merge.settledBeforeJobMerge ?? [] : []);
  const blockers = view.merge.blockers.filter(blocker => !mergeLifecycleBlockers.has(blocker.code) && !settled.has(blocker.code));
  // `endedJobShown` keeps the step list of the job seen ending on screen until the review reloads, also once the poll that follows
  // its queued attempt has replaced the `job-refresh` blocker with the attempt's own status.
  return { ...view, merge: { ...view.merge, ready: false, action: null, job, endedJobShown: job?.id ?? null,
    blockers: [{ code: "job-refresh", message }, ...blockers] } };
}
/** The merge control's label for a job the page saw end: its outcome, as the control reads a queue merge's. */
function endedMergeJobLabel(job) {
  return { merged: "Merged", queued: "Merge queued", submitted: "Merge submitted", blocked: "Merge blocked", "review-required": "Review needed",
    failed: "Merge stopped", cancelled: "Merge cancelled" }[job?.state] ?? "Merge ended";
}
function withMergeQueue(view, queue) {
  const blockers = view.merge.blockers.filter(blocker => !mergeLifecycleBlockers.has(blocker.code));
  if (queue?.state === "merged")
    blockers.unshift({ code: "queue-merged", message: "GitHub confirmed that the reviewed head was merged." });
  else if (queue?.state === "removed" || queue?.state === "failed")
    blockers.unshift({ code: "queue-refresh", message: `${queue.reason} Refresh to verify retry readiness.` });
  else
    blockers.unshift(...view.merge.blockers.filter(blocker => blocker.code === "queue-active"));
  return { ...view, merge: { ...view.merge, ready: false, action: null, queue, blockers } };
}
/**
 * The view once a job is seen ended `queued`, with the merge attempt `queue` the same poll answered. The job's attempt
 * (its action ID is the job's `mergeActionId`) is followed as the queue poll follows one: while GitHub's queue holds it,
 * the control keeps the job's outcome and the queue poll continues; once it is merged, removed or failed, the control and
 * banner read that, as they do for a queue merge. Any other job or attempt leaves the view unchanged.
 */
function withEndedJobQueue(view, job, queue) {
  if (!isEndedJobQueue(job, queue)) {
    // A job that ended otherwise (blocked, failed) is described by its outcome: a copy of its own attempt the page kept
    // while it asked GitHub is dropped, so that copy does not keep polling or replace the outcome.
    const keptOwn = !!view.merge.queue?.actionId && view.merge.queue.actionId === job?.mergeActionId;
    return keptOwn && !followsOwnAttempt(job) ? { ...view, merge: { ...view.merge, queue: null } } : view;
  }
  return ["submitting", "queued"].includes(queue.state) ? { ...view, merge: { ...view.merge, queue } } : withMergeQueue(view, queue);
}
/** Whether `queue` is the merge attempt a job that ended `queued` left in GitHub's queue (its action ID is the job's `mergeActionId`). */
/** Whether an ended job follows its own merge attempt: it left the attempt with GitHub (queued, or an unknown outcome). */
function followsOwnAttempt(job) {
  return job?.state === "queued" || job?.state === "submitted";
}
function isEndedJobQueue(job, queue) {
  return followsOwnAttempt(job) && Boolean(queue?.actionId) && queue.actionId === job.mergeActionId;
}
/** The banner text for a job the page saw end (`job` null: the poll no longer reports it). */
function endedMergeJobText(job) {
  return `${job ? mergeJobText(job) : "The merge job ended."} Refresh to see the result.`;
}
/**
 * The view once the page learns its job ended, with the job's own attempt when `queue` is it. The job poll, the click's
 * answer and a newer observation kept over a full response all present an ended job through this and
 * showEndedJobAndAttempt, so an attempt GitHub already merged, removed or failed keeps its outcome and an active one is polled.
 */
function withEndedJobAndAttempt(view, job, queue) {
  return withEndedJobQueue(withEndedMergeJob(view, job, endedMergeJobText(job)), job, queue);
}
/** The banner for withEndedJobAndAttempt: the job's outcome, then its own attempt's status, which takes precedence. */
function showEndedJobAndAttempt(job, queue) {
  $("banner").textContent = endedMergeJobText(job);
  if (isEndedJobQueue(job, queue)) showMergeQueueStatus(queue);
}
function showMergeQueueStatus(queue) {
  if (queue?.state === "merged") {
    $("banner").textContent = "GitHub confirmed the reviewed head was merged.";
  } else if (queue?.state === "removed" || queue?.state === "failed") {
    $("banner").textContent = `${queue.state === "removed" ? "Removed from merge queue" : "Merge queue failed"}. ${queue.reason} Refresh to verify retry readiness.`;
  } else if (queue?.observationError) {
    $("banner").textContent = `${queue.state === "submitting" ? "Merge submission status is unknown" : "Merge remains queued"}. ${queue.observationError}`;
  } else if (queue?.state === "queued") {
    $("banner").textContent = `Merge queued${queue.position === null ? "" : ` at position ${queue.position}`}. Waiting for GitHub.`;
  }
}
async function act(command) {
  if (busy || planImportPending || !data) return false;
  supersedePlanRefresh();
  const busyOwner = beginBusy("write");
  const generation = ++reviewGeneration;
  const mergeObservationOwner = mergeObservationGeneration;
  mergeGeneration++;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  renderAttachment();
  try {
    rememberDraft();
    // One action ID per user action: the server replays it exactly and records feedback with it.
    const updated = await api("/api/action", { ...command, token: data.token, actionId: crypto.randomUUID() });
    if (generation !== reviewGeneration) return true;
    mergeGeneration++;
    if (mergePollTimer) clearTimeout(mergePollTimer);
    mergePollTimer = null;
    mergePollState = null;
    mergePollDelay = 2000;
    rememberDraft();
    const newer = newerMergeObservations(updated, mergeObservationOwner);
    data = withNewerMergeObservations(updated, newer);
    render();
    showNewerMergeObservations(newer);
    return true;
  } catch (error) {
    if (generation !== reviewGeneration) return false;
    rememberDraft();
    showFailure(`${error.message} Refresh to review the latest state.`);
    return false;
  } finally {
    endBusy(busyOwner);
  }
}
const showSince = (item) =>
  item?.state === "stale" &&
  (sinceChoice?.item === item.id && sinceChoice.state === item.staleKey ? sinceChoice.value : true);
function select(id) {
  rememberDraft();
  selected = id;
  snippetSelection = null;
  change = 0;
  sinceChoice = null;
  render();
}
function render() {
  if (selected === undefined) {
    selected = data.items[0]?.id || "Unplanned";
    adoptUnselectedDrafts();
  }
  const item = data.items.find((item) => item.id === selected);
  const retainedItems = [...new Set([
    ...[...drafts].filter(([, text]) => text.length).map(([key]) => key.split(":")[0]),
    ...[...attachments.keys()].map((key) => key.split(":")[0]),
  ])].filter((id) => !data.items.some((entry) => entry.id === id) && !["Unplanned", "Ambiguous", "Accepted"].includes(id));
  const retained = retainedItems.includes(selected);
  if (!item && !retained && !["Unplanned", "Ambiguous", "Accepted"].includes(selected)) {
    selected = data.items[0]?.id || "Unplanned";
    return render();
  }
  $("repository").textContent = data.repository;
  renderPlans();
  $("issue").textContent =
    `#${data.plan.issue} ${data.plan.summary} · r${data.plan.revision}`;
  $("progress").textContent =
    `${data.approved} of ${data.items.length} approved`;
  renderMerge();
  $("banner").textContent = data.demo
    ? "Demo repository · real Git changes and local SQLite storage. No tests or AI review have been run for this demo."
    : "";
  const unplanned = data.segments.filter((s) => s.row === "Unplanned").length,
    ambiguous = data.segments.filter((s) => s.row === "Ambiguous").length;
  $("attention").innerHTML =
    `<button data-select="Unplanned">${unplanned} unplanned</button><span> · </span><button data-select="Ambiguous">${ambiguous} ambiguous changes</button>`;
  const symbols = { approved: "✓", stale: "!", unreviewed: "○" };
  $("items").innerHTML =
    data.items
      .map(
        (entry) =>
          `<button class="plan-row ${entry.id === selected ? "selected" : ""}" data-select="${esc(entry.id)}" aria-current="${entry.id === selected ? "true" : "false"}"><span class="row-title"><span class="${entry.state === "approved" ? "good" : entry.state === "stale" ? "warn" : "neutral"}" aria-label="${esc(entry.state)}">${symbols[entry.state]}</span><code>${esc(entry.id)}</code><span>${esc(entry.title)}</span><span class="count">${entry.count}</span></span><span class="row-sub">${Object.entries(
            entry.checks,
          )
            .map(
              ([name, text]) =>
                `<span class="${statusClass(text)}" title="${esc(name)}: ${esc(text)}" aria-label="${esc({ attributed: "Attributed", scope: "In scope", tests: "Tests", ai: "AI review" }[name])}: ${esc(text)}">${esc(text[0])} ${esc({ attributed: "Attr", scope: "Scope", tests: "Tests", ai: "AI" }[name])}</span>`,
            )
            .join(
              "",
            )}</span>${entry.state === "stale" ? '<span class="warn">Stale</span>' : ""}${data.notes.some((note) => note.item === entry.id && note.kind === "change") ? `<span class="warn"> · ${data.notes.filter((note) => note.item === entry.id && note.kind === "change").length} pending changes</span>` : ""}</button>${entry.id === selected ? `<div class="selected-files">Declared files${entry.files.map((file) => `<code>${esc(file.path)}</code>`).join("")}</div>` : ""}`,
      )
      .join("") +
    ["Ambiguous", "Unplanned", "Accepted"]
      .map(
        (row) =>
          `<button class="plan-row ${row === selected ? "selected" : ""}" data-select="${row}"><span class="row-title ${row === "Unplanned" ? "bad" : row === "Ambiguous" ? "warn" : "muted"}">${row === "Unplanned" ? "✕" : row === "Ambiguous" ? "!" : "✓"} ${row}${row === "Unplanned" ? " changes" : ""}<span class="count">${data.segments.filter((s) => s.row === row).length}</span></span></button>`,
      )
      .join("") + retainedItems.map((id) =>
        `<button class="plan-row ${id === selected ? "selected" : ""}" data-select="${esc(id)}" aria-current="${id === selected ? "true" : "false"}"><span class="warn">! ${esc(id)} · Retained draft</span></button>`,
      ).join("");
  document
    .querySelectorAll("[data-select]")
    .forEach((button) =>
      button.addEventListener("click", () => select(button.dataset.select)),
    );
  $("item-id").textContent = item?.id || "REVIEW EXCEPTIONS";
  $("item-title").textContent = item?.title || selected;
  $("item-details").innerHTML = item
    ? `<p>${esc(item.intent)}</p>${item.reasons.map((reason) => `<p class="warn">! Stale: ${esc(reason)}</p>`).join("")}`
    : retained ? '<p class="warn">This item is no longer in the plan. Your draft is retained in this page. Copy the text, select a current plan item, and reselect any code before submitting.</p>' : "";
  $("approve").hidden = !item;
  $("approve").textContent = item?.ambiguousCount
    ? "Resolve ambiguous changes"
    : item?.count
      ? `Approve ${item.id}`
      : "Confirm no change needed";
  $("approve").disabled = item?.state === "approved";
  $("view-toggle").innerHTML =
    item?.state === "stale"
      ? `<button data-since="true" aria-pressed="${showSince(item)}">Since approval</button><button data-since="false" aria-pressed="${!showSince(item)}">Full change</button>`
      : "";
  document.querySelectorAll("[data-since]").forEach((button) =>
    button.addEventListener("click", () => {
      sinceChoice = { item: item.id, state: item.staleKey, value: button.dataset.since === "true" };
      renderCode();
    }),
  );
  $("checks").innerHTML = item
    ? Object.entries(item.checks)
        .map(
          ([name, text]) =>
            `<button class="${statusClass(text)}" data-check="${name}" aria-label="${esc({ attributed: "Attributed", scope: "In scope", tests: "Tests", ai: "AI review" }[name])}: ${esc(text)}">${esc({ attributed: "Attributed", scope: "In scope", tests: "Tests", ai: "AI review" }[name])}: ${esc(text)}</button>`,
        )
        .join("")
    : "";
  document.querySelectorAll("[data-check]").forEach((button) =>
    button.addEventListener("click", () => {
      if (
        button.dataset.check === "attributed" &&
        item.checks.attributed.startsWith("!")
      )
        select("Ambiguous");
      else
        showDialog(
          `<h2>${esc(button.textContent)}</h2><pre>${esc(button.dataset.check === "scope" ? item.outside.join("\n") || "Every attributed change is inside this item’s declared files." : button.dataset.check === "tests" ? item.acceptance.map((check) => `${check.type}: ${check.text}`).join("\n") + "\n\nThis screen does not run commands." : button.dataset.check === "ai" ? "No AI review has run. This does not mean the change has no problems." : "Attribution comes from the commit ledger, not commit messages.")}</pre>`,
        );
    }),
  );
  renderNotes();
  $("message").disabled = !item && !retained;
  $("save-note").disabled = !item;
  $("message").value = drafts.get(`${selected}:${mode}`) || "";
  renderCode();
  renderAttachment();

}
function renderCode() {
  const item = data.items.find((item) => item.id === selected),
    segments = data.segments.filter((s) => s.row === selected);
  change = Math.max(0, Math.min(change, segments.length - 1));
  $("change-count").textContent = segments.length
    ? `Change ${change + 1} of ${segments.length}`
    : "No changes";
  $("previous").disabled = !segments.length || change === 0;
  $("next").disabled = !segments.length || change === segments.length - 1;
  let comparison = "";
  if (showSince(item) && item.before) {
    const prior = item.before.segments
      .map((s) => `${s.path} ${s.operation || ""}\n${s.content}`)
      .join("\n");
    const now = segments
      .map((s) => `${s.path} ${s.operation || ""}\n${s.content}`)
      .join("\n");
    comparison = `<div class="comparison"><section><h2>At approval</h2><pre>${esc(prior || "No changes")}</pre><details><summary>Approved plan item</summary><pre>${esc(JSON.stringify(item.before.item, null, 2))}</pre></details></section><section><h2>Now</h2><pre>${esc(now || "No changes")}</pre><details><summary>Current plan item</summary><pre>${esc(
      JSON.stringify(
        data.plan.items.find((p) => p.id === item.id),
        null,
        2,
      ),
    )}</pre></details></section></div>`;
  }
  $("code").innerHTML =
    comparison +
    (segments
      .map((segment, index) => {
        const provenance = `${segment.row === "Accepted" ? "Accepted" : segment.row}${segment.conflictResolved ? " · conflict resolved by agent" : ""}`;
        const unplanned = segment.row === "Unplanned";
        let content;
        if (segment.kind === "file") {
          const meta = JSON.parse(segment.content);
          const label =
            meta.oldPath !== meta.newPath && meta.oldPath && meta.newPath
              ? "Renamed file"
              : meta.oldMode === "160000" || meta.newMode === "160000"
                ? "Submodule pointer"
                : meta.oldMode === "120000" || meta.newMode === "120000"
                  ? "Symbolic link"
                  : meta.oldMode !== meta.newMode &&
                      meta.oldMode &&
                      meta.newMode
                    ? "File mode changed"
                    : "File change";
          content = `<div class="file-card"><div class="provenance ${unplanned ? "unplanned" : ""}">${esc(provenance)}</div><div class="file-values"><strong>▧ ${label}</strong><dl><dt>Path</dt><dd><code>${esc(meta.oldPath || "Absent")} → ${esc(meta.newPath || "Absent")}</code></dd><dt>Mode</dt><dd><code>${esc(meta.oldMode || "Absent")} → ${esc(meta.newMode || "Absent")}</code></dd></dl><p class="muted">Size: ${segment.file?.oldSize ?? "N/A"} → ${segment.file?.newSize ?? "N/A"} bytes</p>${segment.file?.beforePreview || segment.file?.afterPreview ? `<div class="image-previews">${segment.file.beforePreview ? `<figure><figcaption>Before</figcaption><img alt="Previous image in ${esc(segment.path)}" src="${esc(segment.file.beforePreview)}"></figure>` : ""}${segment.file.afterPreview ? `<figure><figcaption>After</figcaption><img alt="Current image in ${esc(segment.path)}" src="${esc(segment.file.afterPreview)}"></figure>` : ""}</div>` : '<p class="muted">No preview available</p>'}<details><summary>Details · content IDs</summary><pre>${esc(JSON.stringify(meta, null, 2))}</pre></details></div></div>`;
        } else {
          const lines = segment.content.split("\n");
          if (lines.at(-1) === "") lines.pop();
          const start =
            segment.operation === "+" ? segment.newLine : segment.oldLine;
          content = `<div class="diff ${segment.operation === "+" ? "added" : "removed"}" data-segment="${segment.key}"><div class="provenance ${unplanned ? "unplanned" : ""}">${esc(provenance)}</div><div class="line-numbers">${lines.map((_, i) => `<button type="button" class="line-number" data-line="${start + i}" aria-label="Select ${segment.operation === "+" ? "added" : "removed"} line ${start + i}">${start + i}</button>`).join("")}</div><div class="sign">${esc(segment.operation)}</div><pre class="code-lines">${lines.map((line,i) => `<span data-code-line="${start+i}">${esc(line) || "&#8203;"}</span>`).join("\n")}</pre></div>`;
        }
        const choices = ["Unplanned", "Ambiguous"].includes(segment.row)
          ? `<div class="choice-controls"><p>Assigning this change makes the selected item’s approval stale.</p><select aria-label="Assign change ${index + 1} to" data-target="${index}"><option value="">Assign to…</option>${data.items.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.title)}</option>`).join("")}</select><button data-assign="${index}">Assign</button><button data-accept="${index}">Accept as is</button></div>`
          : "";
        return `<article class="change ${index === change ? "active" : ""}" data-change="${index}" aria-label="Change ${index + 1}, ${esc(segment.path)}, ${esc(provenance)}"><div class="file-heading"><code>${esc(segment.path)}</code><span class="${segment.scope === "out-of-scope" ? "bad" : "muted"}">${segment.row === "Accepted" ? "Accepted outside plan" : segment.scope === "out-of-scope" ? "✕ Out of scope" : esc(segment.scope)}</span></div>${content}<div class="change-meta">${esc(segment.context || "File-level change")}${segment.sharesHunkWith.length ? ` · Shares a hunk with ${esc(segment.sharesHunkWith.join(", "))}` : ""}</div>${choices}</article>`;
      })
      .join("") ||
      (data.segments.length
        ? '<div class="empty"><h2>No changes in this row</h2><p>There are no current segments here. An item with no changes requires explicit confirmation before approval.</p></div>'
        : '<div class="empty"><h2>No code changes yet</h2><p>This branch has no changes against the selected base. Open task shows the compared commits.</p></div>'));
  paintSelection();
  document.querySelectorAll("[data-line]").forEach(button => button.onclick = event => {
    const key = button.closest("[data-segment]").dataset.segment;
    const segment = data.segments.find(s => s.key === key);
    const line = Number(button.dataset.line);
    const anchor = event.shiftKey && snippetSelection?.key === key ? snippetSelection.anchor : line;
    chooseSnippet(segment, Math.min(anchor,line), Math.max(anchor,line), anchor);
  });
  document.querySelectorAll("[data-assign]").forEach((button) =>
    button.addEventListener("click", () => {
      const index = Number(button.dataset.assign);
      const item = document.querySelector(`[data-target="${index}"]`).value;
      if (item) act({ action: "assign", key: segments[index].key, item });
    }),
  );
  document
    .querySelectorAll("[data-accept]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        act({
          action: "accept",
          key: segments[Number(button.dataset.accept)].key,
        }),
      ),
    );
  document
    .querySelectorAll("[data-since]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String((button.dataset.since === "true") === showSince(item)),
      ),
    );
}
function moveChange(delta) {
  change += delta;
  renderCode();
  document
    .querySelector(`[data-change="${change}"]`)
    ?.scrollIntoView({ block: "nearest" });
}
function setMode(value) {
  rememberDraft();
  mode = value;
  $("ask").setAttribute("aria-pressed", String(mode === "question"));
  $("request").setAttribute("aria-pressed", String(mode === "change"));
  $("composer-label").textContent =
    mode === "change" ? "Change to request" : "Question about this item";
  $("save-note").textContent =
    mode === "change" ? "Save change request" : "Ask agent";
  $("message").value = drafts.get(`${selected ?? ""}:${mode}`) || "";
  renderAttachment();
}
function showDialog(html) {
  $("dialog-body").innerHTML = html;
  $("dialog").showModal();
}
$("approve").onclick = () => {
  const item = data?.items.find((item) => item.id === selected);
  if (item?.ambiguousCount > 0) {
    select("Ambiguous");
    return;
  }
  if (item)
    act({
      action: "approve",
      item: selected,
      confirmNoChange: item.count === 0,
    });
};
$("reload").onclick = refresh;
$("merge-details").onclick = () => {
  if (!data?.merge?.available) return;
  const queue = data.merge.queue, job = data.merge.job;
  if (job?.state === "running") {
    showDialog(`<h2>Merge status</h2><p><strong>${esc(mergeJobStepLabel(job))}</strong></p><p>${esc(mergeJobText(job))}</p>${job.checks.length
      ? `<ul>${job.checks.map(check => `<li>${esc(check.context)}: ${esc(check.state)}</li>`).join("")}</ul>` : ""}`);
    return;
  }
  const jobEnded = data.merge.blockers.some(blocker => blocker.code === "job-refresh");
  showDialog(
    `<h2>${queue || jobEnded ? "Merge status" : "Merge blockers"}</h2>${queue ? `<p><strong>${esc(queue.state)}</strong> · reviewed head <code>${esc(queue.reviewedHead.slice(0, 12))}</code></p>${queue.phase ? `<p>GitHub phase: ${esc(queue.phase)}${queue.position === null ? "" : ` · position ${queue.position}`}</p>` : ""}${queue.reason ? `<p>${esc(queue.reason)}</p>` : ""}${queue.observationError ? `<p>${esc(queue.observationError)}</p>` : ""}` : ""}<ul>${data.merge.blockers.map((blocker) => `<li>${esc(blocker.message)}</li>`).join("")}</ul>`,
  );
};
/**
 * The merge click's confirmation. A direct retry merges the exact reviewed head again; a merge job's retry prepares
 * again first, and a rebase there makes a new head and snapshot (docs/implementation/merge-handoff.md, Outcomes).
 */
function mergeConfirmText(merge) {
  if (merge.action !== "retry") return "Merge this reviewed pull request?";
  return "job" in merge
    ? "Retry the merge? It prepares the merge again, which may rebase onto the current base and need a new review."
    : "Retry merging this exact reviewed head?";
}
$("merge").onclick = async () => {
  if (busy || planImportPending || !data?.merge?.ready || !window.confirm(mergeConfirmText(data.merge))) return;
  supersedePlanRefresh();
  const busyOwner = beginBusy("write");
  reviewGeneration++;
  mergeGeneration++;
  // Defensive, like every generation change: a click needs `ready`, which excludes a running job or an active attempt,
  // so no poll timer is pending here today (traced, not tested).
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  // With merge jobs, the click returns at once and the focused control must keep focus: mark it, do not disable it.
  if (data.merge && "job" in data.merge) $("merge").setAttribute("aria-disabled", "true");
  else $("merge").disabled = true;
  mergeClickPending = true;
  $("merge").textContent = "Requesting merge…";
  try {
    rememberDraft();
    mergeAction ??= { actionId: crypto.randomUUID(), token: data.token, jobBefore: data.merge.job?.id ?? null };
    const mergeObservationOwner = mergeObservationGeneration;
    const updated = await api("/api/action", { action: "merge", token: mergeAction.token, actionId: mergeAction.actionId });
    mergeClickPending = false;
    // The composer stayed editable while the request was in flight: keep what the person typed meanwhile.
    rememberDraft();
    mergeAction = null;
    if (updated.job) {
      // A merge job runs in the background (F6b); the page follows it. When the server could not reload the review after
      // starting the job, it answers only the job: keep the page's review and follow the job on it. A resend can replay
      // this click's ended job while a later one (another tab's retry) runs: the reloaded review then carries that later
      // job, and the page follows the later record (by sequence, or revision within one job).
      const job = !updated.mergeRefreshRequired && updated.merge?.job && laterMergeJob(updated.merge.job, updated.job) ? updated.merge.job : updated.job;
      const answered = updated.mergeRefreshRequired
        ? { ...data, merge: { ...data.merge, ready: false, action: null, job } }
        : { ...updated, merge: { ...updated.merge, job } };
      // A cancel's answer or a poll may have shown a later record (of this job, or a newer job) while the click was on
      // its way: it is kept over the click's answer, with only its own queue attempt, as a full review response keeps it.
      const newer = newerMergeObservations(answered, mergeObservationOwner);
      if (newer.job) {
        data = withNewerMergeObservations(answered, newer);
        render();
        showNewerMergeObservations(newer);
        return;
      }
      data = answered;
      if (job.state !== "running") {
        // The job had already ended when the click was answered: say how to see its result, as the job poll does when a
        // job ends. A job that ended `queued` is shown with its own attempt, as the poll shows it: another client's poll
        // may have seen that attempt merged, removed or failed before this click's review reload read it, or it is still
        // queued and the queue poll follows it.
        const queue = data.merge.queue;
        data = withEndedJobAndAttempt(data, job, queue);
        render();
        showEndedJobAndAttempt(job, queue);
        return;
      }
      render();
      $("banner").textContent = mergeJobText(job);
      return;
    }
    const queued = updated.mergeQueue?.state === "queued" || updated.mergeQueue?.state === "submitting";
    const blocker = { code: queued ? "queue-active" : "merge-submitted", message: queued ? "The reviewed head is queued. Waiting for GitHub to confirm the outcome." : "Merge was submitted. Refresh to confirm GitHub state." };
    data = updated.mergeRefreshRequired
      ? { ...data, merge: { ...data.merge, ready: false, action: null, queue: updated.mergeQueue ?? null, blockers: [blocker] } }
      : { ...updated, merge: { ...updated.merge, ready: false, action: null, blockers: [blocker] } };
    render();
    $("banner").textContent = `${queued ? "Merge queued" : "Merge submitted"}. ${updated.mergeResult.url}`;
  } catch (error) {
    mergeClickPending = false;
    rememberDraft();
    // Only a parsed, definite server answer resolves this click. No response, an unreadable body, 503 (nothing
    // applied) or an admitted attempt with an unknown outcome keeps the key until that attempt ends.
    if (typeof error.status === "number" && error.status !== 503 && !error.outcomeUnknown) mergeAction = null;
    // A merge-job refusal carries the task's latest job. When that is a running job later than the one this page shows
    // (another tab's click started it), follow it as the poll would, instead of asking for a refresh.
    if (error.job?.state === "running" && data.merge && "job" in data.merge && laterMergeJob(error.job, data.merge.job)) {
      data = withMergeJobObservation(data, error.job);
      render();
      $("banner").textContent = `${error.message} ${mergeJobText(error.job)}`;
      return;
    }
    // The page follows a running job: a click needs `ready`, which excludes one, so a cancel's answer or a poll showed it
    // while the click was on its way. It keeps following it, whatever job (if any) the refusal carries.
    const shown = data.merge?.job;
    if (shown?.state === "running") {
      // A later record that ended (the job ended meanwhile) is presented, as the click's answer presents an ended job.
      if (error.job && error.job.state !== "running" && laterMergeJob(error.job, shown)) {
        const queue = data.merge.queue;
        data = withMergeJobObservation(data, error.job, queue);
        render();
        showEndedJobAndAttempt(error.job, queue);
        return;
      }
      render();
      $("banner").textContent = `${error.message} ${mergeJobText(shown)}`;
      return;
    }
    data = { ...data, merge: { ...data.merge, ready: false, blockers: [{ code: "stale-merge", message: `${error.message} Refresh before trying again.` }] } };
    render();
    $("banner").textContent = `Merge blocked. ${error.message}`;
  } finally {
    endBusy(busyOwner);
  }
};
$("review-link").onclick = (event) => {
  event.preventDefault();
  if (view === "review") refresh();
  else showView("review");
};
$("next").onclick = () => moveChange(1);
$("previous").onclick = () => moveChange(-1);
$("ask").onclick = () => setMode("question");
$("request").onclick = () => setMode("change");
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !data) return;
  const item = selected,
    kind = mode;
  const submittedText = $("message").value;
  const attached = attachments.get(`${item}:${kind}`);
  if (attached && (attached.head !== data.snapshot.head || attached.base !== data.snapshot.base)) return;
  $("saved").textContent = kind === "change" ? "Saving change request…" : "Asking agent…";
  if (await act({ action: "note", item, kind, text: submittedText, ...(attached ? {reference:{key:attached.key,start:attached.start,end:attached.end}} : {}) })) {
    if (selected === item) $("notes").lastElementChild?.scrollIntoView({ block: "nearest" });
    const unchanged = drafts.get(`${item}:${kind}`) === submittedText && attachments.get(`${item}:${kind}`) === attached;
    if (unchanged) {
      drafts.delete(`${item}:${kind}`);
      attachments.delete(`${item}:${kind}`);
    }
    renderAttachment();
    $("message").value = drafts.get(`${selected}:${mode}`) || "";
    $("saved").textContent =
      kind === "change"
        ? "Saved for the next revision."
        : "Question submitted. Follow the agent’s response in Conversation.";
  } else {
    $("saved").textContent = kind === "change"
      ? "Could not save. Your draft is preserved; refresh and try again."
      : "Could not ask the agent. Your question is preserved; refresh and try again.";
  }
};
$("conversation-toggle").onclick = () => {
  document.body.classList.toggle("conversation-open");
  document.body.classList.remove("conversation-closed");
};
$("collapse-conversation").onclick = () => {
  document.body.classList.remove("conversation-open");
  document.body.classList.add("conversation-closed");
};
$("collapse-plan").onclick = () => {
  document.querySelector(".plan-pane").hidden = true;
  $("show-plan").hidden = false;
};
$("show-plan").onclick = () => {
  document.querySelector(".plan-pane").hidden = false;
  $("show-plan").hidden = true;
};
$("help").onclick = () =>
  showDialog(
    "<h2>Keyboard shortcuts</h2><p>j / k — next / previous change</p><p>n / p — next / previous item</p><p>a — approve item</p><p>r — request change</p><p>? — shortcuts</p><p>Esc — leave a text field or close this dialog</p>",
  );
$("close-dialog").onclick = () => $("dialog").close();
$("task").onclick = () =>
  showDialog(
    data
      ? `<h2>Task #${data.plan.issue}</h2><p>${esc(data.plan.summary)}</p><p>Revision ${data.plan.revision} · ${data.demo ? "Demo repository" : "Local repository"}</p><pre>Base: ${esc(data.snapshot.base)}\nHead: ${esc(data.snapshot.head)}</pre><p>Source files are read-only in this review app. Approvals and discussion are saved locally.</p>`
      : "<h2>No task loaded</h2><p>Check the CLI configuration and retry.</p>",
  );
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName)
  ) {
    document.activeElement.blur();
    return;
  }
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    $("dialog").open ||
    ["TEXTAREA", "INPUT", "SELECT"].includes(
      document.activeElement?.tagName,
    ) ||
    view !== "review" ||
    !data
  )
    return;
  if (!["j", "k", "n", "p", "a", "r", "?"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "j") moveChange(1);
  if (event.key === "k") moveChange(-1);
  if (["n", "p"].includes(event.key)) {
    const ids = data.items.map((p) => p.id);
    select(
      ids[
        Math.max(
          0,
          Math.min(
            ids.length - 1,
            ids.indexOf(selected) + (event.key === "n" ? 1 : -1),
          ),
        )
      ],
    );
  }
  if (event.key === "a") $("approve").click();
  if (event.key === "r") {
    document.body.classList.add("conversation-open");
    document.body.classList.remove("conversation-closed");
    setMode("change");
    $("message").focus();
  }
  if (event.key === "?") $("help").click();
});

function chooseSnippet(segment, start, end, anchor = start) {
  if (!data.items.some(item => item.id === selected)) {
    $("saved").textContent = "Assign this change to a plan item before adding feedback.";
    return;
  }
  const first = segment.operation === "+" ? segment.newLine : segment.oldLine;
  const text = segment.content.split("\n").slice(start-first,end-first+1).join("\n");
  if (end-start >= 200 || text.length > 16000) {
    $("saved").textContent = "Select at most 200 lines and 16000 characters.";
    return;
  }
  snippetSelection = {key:segment.key,start,end,anchor,text,path:segment.operation === "-" ? segment.oldPath || segment.path : segment.path,side:segment.operation === "+" ? "new" : "old",head:data.snapshot.head,base:data.snapshot.base};
  paintSelection();
}
function referenceLabel(ref) {
  return `${ref.path} · ${ref.side === "new" ? "Added" : "Removed"} L${ref.start}–${ref.end}`;
}
function paintSelection() {
  const ref = snippetSelection;
  $("selection-actions").hidden = !ref;
  $("selection-label").textContent = ref ? referenceLabel(ref) : "";
  document.querySelectorAll("[data-code-line], [data-line]").forEach(element => {
    const line = Number(element.dataset.codeLine ?? element.dataset.line);
    const active = !!ref && element.closest("[data-segment]").dataset.segment === ref.key && line >= ref.start && line <= ref.end;
    element.classList.toggle("selected-line",active);
    if (element.matches("button")) element.setAttribute("aria-pressed",String(active));
  });
  positionSelectionActions();
}
function positionSelectionActions() {
  const toolbar = $("selection-actions");
  if (!snippetSelection) { toolbar.hidden = true; return; }
  const bounds = $("code").getBoundingClientRect();
  const visible = [...document.querySelectorAll("[data-code-line].selected-line")]
    .map(line => line.getBoundingClientRect())
    .filter(rect => rect.bottom > bounds.top && rect.top < bounds.bottom);
  if (!visible.length || bounds.width < 1) { toolbar.hidden = true; return; }
  const anchor = visible[visible.length - 1];
  toolbar.hidden = false;
  const inset = Math.min(140, bounds.width / 3);
  toolbar.style.width = `${Math.min(440, bounds.width - inset - 8)}px`;
  const height = toolbar.getBoundingClientRect().height;
  const below = anchor.bottom + 8;
  const top = below + height <= bounds.bottom - 8 ? below : anchor.top - height - 8;
  toolbar.style.left = `${bounds.left + inset}px`;
  toolbar.style.top = `${Math.max(bounds.top + 8, Math.min(top, bounds.bottom - height - 8))}px`;
}
$("code").addEventListener("scroll", positionSelectionActions);
window.addEventListener("resize", positionSelectionActions);
new ResizeObserver(positionSelectionActions).observe($("code"));

function renderAttachment() {
  const ref = attachments.get(`${selected}:${mode}`);
  $("attachment").hidden = !ref;
  const stale = ref && (!data || ref.head !== data.snapshot.head || ref.base !== data.snapshot.base || !data.segments.some(s => s.key === ref.key && s.row === selected));
  $("attachment").innerHTML = ref ? `<strong>${esc(referenceLabel(ref))}</strong><small>Commit ${esc(ref.head.slice(0,8))}${stale ? " · ! Outdated — remove and select again" : ""}</small><pre class="snippet-preview">${esc(ref.text)}</pre><button type="button" id="remove-reference">Remove snippet</button>` : "";
  $("save-note").disabled = busy || !!stale || !data?.items.some(item=>item.id === selected);
  if (ref) $("remove-reference").onclick = () => {attachments.delete(`${selected}:${mode}`);renderAttachment();};
}
function attachSelection(kind) {
  if (!snippetSelection) return;
  setMode(kind);
  attachments.set(`${selected}:${mode}`, {...snippetSelection});
  document.body.classList.add("conversation-open");
  document.body.classList.remove("conversation-closed");
  renderAttachment();
  $("message").focus();
}
$("snippet-ask").onclick = () => attachSelection("question");
$("snippet-request").onclick = () => attachSelection("change");
$("selection-clear").onclick = () => {
  window.getSelection()?.removeAllRanges();
  snippetSelection = null;
  paintSelection();
};
function captureHighlightedLines() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const element = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const first = element(range.startContainer)?.closest("[data-code-line]");
  const last = element(range.endContainer)?.closest("[data-code-line]");
  if (!first || !last) return;
  const block = first.closest("[data-segment]");
  if (block !== last.closest("[data-segment]")) {
    snippetSelection=null;paintSelection();
    $("saved").textContent="Select lines within one changed block and diff side.";
    return;
  }
  let end=Number(last.dataset.codeLine);
  if (range.endOffset===0 && last!==first) end--;
  chooseSnippet(data.segments.find(s=>s.key===block.dataset.segment),Number(first.dataset.codeLine),end);
}
$("code").addEventListener("mouseup",captureHighlightedLines);
$("code").addEventListener("keyup",captureHighlightedLines);

function answerMarkup(note) {
  if(note.kind!=="question") return "";
  const answer=note.answer;
  if(answer?.status==="complete") return `<section class="agent-answer"><strong>${answer.provider === "claude" ? "Claude Code" : answer.provider === "codex" ? "Codex" : "Agent"}</strong><p>${esc(answer.text)}</p>${note.answerOutdated || note.outdated ? '<small>! Answer refers to earlier code or review context.</small>' : ""}</section>`;
  if(note.answerOutdated || note.outdated) return '<p class="warn">This question refers to an earlier review. Ask again against the current code.</p>';
  if(answer?.status==="pending" && answer.expiresAt>Date.now()) return '<p role="status">Agent · Answering…</p>';
  if(note.answerActive) return '<p role="status">Agent · Finishing cancellation…</p>';
  const error=answer?.status==="failed"?answer.error:answer?.status==="pending"?"Agent was interrupted or timed out.":"Answer not started. Choose an agent in Settings or retry when capacity is available.";
  return `<p class="warn">! ${esc(error)}</p><button data-retry-question="${esc(note.id)}">Retry answer</button>`;
}
function renderNotes({ follow = false } = {}) {
  const notes = $("notes");
  const scrollTop = notes.scrollTop;
  const atBottom = notes.scrollHeight - notes.clientHeight - scrollTop <= 32;
  const item=data.items.find(item=>item.id===selected);
  $("notes").innerHTML = item
    ? data.notes
        .filter((note) => note.item === selected)
        .map(
          (note) =>
            `<div class="note"><strong>You · ${note.kind === "change" ? "Change requested" : "Question"}</strong><p>${esc(note.text)}</p>${note.reference ? `<button class="note-reference" data-note="${esc(note.id)}">${esc(note.reference.path)} · ${note.reference.side === "new" ? "Added" : "Removed"} L${note.reference.start}–${note.reference.end}${note.outdated ? " · ! Outdated" : ""}</button><pre class="snippet-preview">${esc(note.reference.text)}</pre>` : ""}<small>r${note.revision} · ${esc(new Date(note.createdAt).toLocaleString())}${note.kind === "change" ? " · Pending" : ""}</small>${answerMarkup(note)}</div>`,
        )
        .join("") ||
      '<p class="muted">No conversation yet. Keep questions and requested changes beside the evidence.</p>'
    : '<p class="muted">Select a plan item to add a question or request a change.</p>';
  if (follow) notes.scrollTop = atBottom ? notes.scrollHeight : scrollTop;
  document.querySelectorAll("[data-note]").forEach(button => button.onclick = () => {
    const note = data.notes.find(note => note.id === button.dataset.note);
    const ref = note.reference;
    if (note.outdated) {
      showDialog(`<h2>! Outdated code reference</h2><p>${esc(ref.path)} · ${ref.side} L${ref.start}–${ref.end}</p><p>Reviewed commit ${esc(ref.head)} · base ${esc(ref.base)}</p><pre>${esc(ref.text)}</pre>`);
      return;
    }
    select(note.item);
    const segment = data.segments.find(s => s.key === ref.key);
    chooseSnippet(segment, ref.start, ref.end);
    document.querySelector(`[data-segment="${ref.key}"]`)?.scrollIntoView({block:"center"});
  });
  document.querySelectorAll("[data-retry-question]").forEach(button=>button.onclick=()=>act({action:"retry-question",id:button.dataset.retryQuestion}));
}
let pollingQuestions=false;
function preserveSettledQuestionAnswers(updated) {
  if (!data) return updated;
  const current = new Map(data.notes.map(note => [note.id, note]));
  return { ...updated, notes: updated.notes.map(note => {
    const newer = current.get(note.id);
    const sameAttempt = newer?.answer?.attempt !== undefined && newer.answer.attempt === note.answer?.attempt;
    const settledFromPending = note.answer?.status === "pending";
    const cancellationSettled = note.answerActive && newer?.answerActive === false &&
      newer.answer?.status === note.answer?.status;
    return sameAttempt && ["complete", "failed"].includes(newer.answer.status) &&
      (settledFromPending || cancellationSettled)
      ? { ...note, answer: newer.answer, answerActive: newer.answerActive }
      : note;
  }) };
}
/**
 * A poll's record of the task's latest job, when the poll saw it later than a full response read before it. Records of
 * one job order by the server's per-job revision; a later job (another tab's click) outranks any record of an earlier one, by the
 * server's per-task job sequence, never by clock time.
 */
function newerMergeJob(updated, observationOwner) {
  const newer = data?.merge?.job, older = updated.merge?.job;
  if (observationOwner === mergeObservationGeneration || !newer || !older) return null;
  return laterMergeJob(newer, older) ? newer : null;
}
/**
 * Whether `newer` is a later record than `older` (none counts as earliest): by revision within a job, else by sequence.
 * Never by clock time: two saves can share an update time, and the clock can step back between them.
 */
function laterMergeJob(newer, older) {
  if (!older) return true;
  return newer.id === older.id ? Number.isSafeInteger(newer.revision) && Number.isSafeInteger(older.revision) && newer.revision > older.revision
    : Number.isSafeInteger(newer.sequence) && Number.isSafeInteger(older.sequence) && newer.sequence > older.sequence;
}
/**
 * The view with a newer observation of its job, as the job poll shows it: a running job is not ready to merge (the
 * full response may offer Retry for an earlier job), and an ended job asks for a refresh, with its own attempt `queue`.
 */
function withMergeJobObservation(view, job, queue = null) {
  // Removing `job-refresh` here is defensive: the server never sends it, and the page adds it only once it saw a job
  // end, after which nothing makes the merge ready again (so no refused click carries a running job) until Refresh.
  if (job.state === "running") return { ...view, merge: { ...view.merge, ready: false, action: null, job,
    blockers: view.merge.blockers.filter(blocker => blocker.code !== "job-refresh") } };
  return withEndedJobAndAttempt(view, job, queue);
}
/**
 * The poll's observations that a full response read before them must keep: the merge attempt (`queue`), the task's latest
 * job (`job`), and, for a kept job that ended `queued`, the attempt the poll followed for it (`jobQueue`, whose action ID
 * is the job's `mergeActionId`). The full response's own queue may be none or another attempt's, so `queue` alone would
 * drop the attempt the poll saw merged, removed or failed, or still queued and polled.
 */
function newerMergeObservations(updated, observationOwner) {
  const queue = newerMergeQueue(updated, observationOwner), job = newerMergeJob(updated, observationOwner), followed = data?.merge?.queue;
  const jobQueue = isEndedJobQueue(job, followed) ? followed : null;
  return { queue, job, jobQueue };
}
/** The full response `view` with the newer observations kept, as the poll presented them. */
function withNewerMergeObservations(view, { queue, job, jobQueue }) {
  const kept = queue ? withMergeQueue(view, queue) : view;
  if (!job) return kept;
  // A kept job other than the response's: the response's queue attempt is the older job's (the response was read before
  // the kept job), so it is dropped. A kept job's own attempt the page followed is `jobQueue`.
  const sameJob = job.id === kept.merge.job?.id;
  return withMergeJobObservation(sameJob ? kept : { ...kept, merge: { ...kept.merge, queue: null } }, job, jobQueue);
}
/** The banner for the newer observations kept, as the poll showed them; call after render. */
function showNewerMergeObservations({ queue, job, jobQueue }) {
  if (queue) showMergeQueueStatus(queue);
  if (job?.state === "running") $("banner").textContent = mergeJobText(job);
  else if (job) showEndedJobAndAttempt(job, jobQueue);
}
function newerMergeQueue(updated, observationOwner) {
  const newer = data?.merge?.queue, older = updated.merge?.queue;
  const fullResponseIsTerminal = ["merged", "removed", "failed"].includes(older?.state);
  const pollRegressesQueued = older?.state === "queued" && newer?.state === "submitting";
  return observationOwner !== mergeObservationGeneration &&
    newer?.actionId &&
    newer.actionId === older?.actionId &&
    newer.reviewedHead === older.reviewedHead &&
    !fullResponseIsTerminal &&
    !pollRegressesQueued
    ? newer
    : null;
}
setInterval(async()=>{
  if(pollingQuestions || busy || !data || !data.notes.some(n=>n.answer?.status==="pending" || n.answerActive)) return;
  pollingQuestions=true;
  const generation = reviewGeneration;
  try {const response=await api("/api/questions");if(data && generation === reviewGeneration){const statuses=new Map(response.notes.map(note=>[note.id,note]));data.notes=data.notes.map(note=>{const status=statuses.get(note.id);if(!status)return note;const answer=status.answer?.status==="pending" && status.answer.expiresAt<=Date.now() && !status.answerActive ? {...status.answer,status:"failed",error:"Agent was interrupted or timed out. Retry the question."} : status.answer;return {...note,answer,answerActive:status.answerActive};});renderNotes({ follow: true });}}
  catch { if (generation === reviewGeneration) $("saved").textContent="Could not refresh agent answers. Use Refresh to reconnect."; }
  finally {pollingQuestions=false;}
},2000);
$("settings").onclick=async()=>{
  showDialog('<h2>Settings</h2><p>Loading…</p>');
  try {
    const settings=await api("/api/settings");
    $("dialog-body").innerHTML=`<h2>Settings</h2><label for="question-provider">Question agent</label><select id="question-provider"><option value="">Not configured</option><option value="claude">Claude Code</option></select><p>Ask runs this agent in a locked-down Docker container. It gets a read-only copy of the reviewed code, cannot run commands, and can reach only its vendor. Claude Code needs <code>CLAUDE_CODE_OAUTH_TOKEN</code> (create it with <code>claude setup-token</code>). Set it before starting codeboost. This choice is saved for this review database.</p><p>Codex cannot answer questions yet: it can read the code only by running commands.</p><button id="save-settings">Save settings</button><p id="settings-status" role="status"></p>`;
    $("question-provider").value=settings.questionProvider==="claude"?"claude":"";
    if(settings.questionProvider==="codex"){$("settings-status").className="warn";$("settings-status").textContent="! Unavailable: this review was set to Codex, which cannot answer questions yet. Choose Claude Code.";}
    $("save-settings").onclick=async()=>{try{await api("/api/settings",{questionProvider:$("question-provider").value||null});$("settings-status").className="";$("settings-status").textContent="Settings saved.";}catch(error){$("settings-status").className="bad";$("settings-status").textContent=`✕ Could not save settings. ${error.message}`;}};
  } catch(error){$("dialog-body").textContent=error.message;}
};

const conversationResize = $("conversation-resize");
const conversationPane = $("conversation-pane");
function resizeConversation(width) {
  const bounded = Math.round(Math.max(280, Math.min(480, width)));
  conversationPane.style.width = `${bounded}px`;
  conversationResize.setAttribute("aria-valuenow", String(bounded));
}
let conversationDrag;
conversationResize.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  conversationDrag = { x: event.clientX, width: conversationPane.getBoundingClientRect().width };
  conversationResize.setPointerCapture(event.pointerId);
  conversationResize.focus();
  document.body.classList.add("resizing-conversation");
};
conversationResize.onpointermove = event => {
  if (conversationDrag) resizeConversation(conversationDrag.width + conversationDrag.x - event.clientX);
};
function endConversationResize() {
  conversationDrag = null;
  document.body.classList.remove("resizing-conversation");
}
conversationResize.onpointerup = event => {
  if (conversationResize.hasPointerCapture(event.pointerId)) conversationResize.releasePointerCapture(event.pointerId);
  endConversationResize();
};
conversationResize.onpointercancel = endConversationResize;
conversationResize.onlostpointercapture = endConversationResize;
conversationResize.onkeydown = event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  resizeConversation(event.key === "Home" ? 280 : event.key === "End" ? 480 : conversationPane.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 20 : -20));
};
new ResizeObserver(() => {
  const width = conversationPane.getBoundingClientRect().width;
  if (width) conversationResize.setAttribute("aria-valuenow", String(Math.round(width)));
}).observe(conversationPane);

let issuesGeneration = 0,
  issuesView = null,
  issuesRequested = false,
  issuesLoading = false,
  issuesRefreshError = null,
  issueErrorOrder = 0;
let planImportPending = false,
  planImportRetries = new Map(),
  planRefreshPending = false,
  planOperationGeneration = 0,
  planStatusGeneration = 0;
let planAuthorGeneration = 0,
  planAuthorRequest = null;
const planAuthorHistory = [];
const planAuthorPollInitial = 500,
  planAuthorPollMaximum = 5000;
function claimPlanStatus(className, text) {
  const owner = ++planStatusGeneration;
  $("plans-status").className = className;
  $("plans-status").textContent = text;
  return owner;
}
function setPlanStatus(owner, className, text) {
  if (owner !== planStatusGeneration) return;
  $("plans-status").className = className;
  $("plans-status").textContent = text;
}
function supersedePlanRefresh() {
  if (!planRefreshPending) return;
  planOperationGeneration++;
  planRefreshPending = false;
  $("plans-refresh").removeAttribute("aria-disabled");
  $("plans-refresh").textContent = "Refresh plan";
  claimPlanStatus("neutral", "");
}
function planAuthorBusy() {
  return ["starting", "pending", "cancelling", "applying"].includes(planAuthorRequest?.state);
}
function planAuthorStale(request = planAuthorRequest) {
  return !!request && (["invalidated", "consumed"].includes(request.state) || !data?.plan ||
    request.revision !== data.plan.revision || request.snapshotId !== data.snapshot?.id);
}
function describePlanEdit(edit) {
  switch (edit.op) {
    case "add_item": return `Add ${edit.item}`;
    case "remove_item": return `Remove ${edit.item}`;
    case "set_field": return `Set ${edit.item}.${edit.field} to ${edit.value}`;
    case "add_file": return `Add ${edit.file?.path} to ${edit.item}`;
    case "update_file": return `Update ${edit.file?.path} in ${edit.item}`;
    case "remove_file": return `Remove ${edit.value} from ${edit.item}`;
    case "add_check": return `Add ${edit.check?.type} check to ${edit.item}`;
    case "remove_check": return `Remove check ${Number(edit.check_index) + 1} from ${edit.item}`;
    case "set_depends": return `Set ${edit.item} dependencies to ${(edit.depends_on || []).join(", ") || "none"}`;
    default: return "Change the plan";
  }
}
function exactObject(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function boundedText(value, minimum, maximum) {
  if (typeof value !== "string") return false;
  let length = 0;
  for (const _point of value) {
    if (++length > maximum) return false;
  }
  return length >= minimum;
}
function validPlanId(value) {
  return typeof value === "string" && /^P[1-9][0-9]{0,2}$/.test(value);
}
function validPlanFileForDisplay(file) {
  return exactObject(file, ["path", "kind", "renamed_from", "change"]) &&
    boundedText(file.path, 1, 300) && /^[^/\\][^\\]*$/.test(file.path) &&
    ["edit", "add", "delete", "rename"].includes(file.kind) &&
    (file.renamed_from === null || boundedText(file.renamed_from, 0, 300)) &&
    boundedText(file.change, 1, 1200);
}
function validPlanCheckForDisplay(check) {
  return exactObject(check, ["type", "text"]) && ["cmd", "check"].includes(check.type) &&
    boundedText(check.text, 1, 400);
}
function validPlanItemForDisplay(item) {
  return exactObject(item, ["id", "title", "intent", "files", "acceptance", "depends_on"]) &&
    validPlanId(item.id) && boundedText(item.title, 1, 120) && boundedText(item.intent, 1, 600) &&
    Array.isArray(item.files) && item.files.length >= 1 && item.files.length <= 40 && item.files.every(validPlanFileForDisplay) &&
    Array.isArray(item.acceptance) && item.acceptance.length >= 1 && item.acceptance.length <= 10 && item.acceptance.every(validPlanCheckForDisplay) &&
    Array.isArray(item.depends_on) && item.depends_on.length <= 29 && item.depends_on.every(validPlanId);
}
function validPlanForDisplay(plan) {
  return exactObject(plan, ["schema_version", "issue", "revision", "summary", "items", "questions"]) &&
    plan.schema_version === 1 && Number.isSafeInteger(plan.issue) && plan.issue >= 1 &&
    Number.isSafeInteger(plan.revision) && plan.revision >= 1 && boundedText(plan.summary, 1, 600) &&
    Array.isArray(plan.items) && plan.items.length >= 1 && plan.items.length <= 30 && plan.items.every(validPlanItemForDisplay) &&
    Array.isArray(plan.questions) && plan.questions.length <= 10 && plan.questions.every((question) => boundedText(question, 1, 400));
}
function validPlanEditForDisplay(edit) {
  const payloads = ["field", "value", "file", "check", "check_index", "depends_on", "new_item"];
  const used = {
    add_item: ["new_item"], remove_item: [], set_field: ["field", "value"],
    add_file: ["file"], update_file: ["file"], remove_file: ["value"],
    add_check: ["check"], remove_check: ["check_index"], set_depends: ["depends_on"],
  };
  const operationPayloads = Object.hasOwn(used, edit?.op) ? used[edit.op] : null;
  if (!exactObject(edit, ["op", "item", "summary", "reason", ...payloads]) || !operationPayloads ||
      !validPlanId(edit.item) || !boundedText(edit.summary, 1, 160) || !boundedText(edit.reason, 1, 400) ||
      payloads.some((key) => operationPayloads.includes(key) ? edit[key] === null : edit[key] !== null)) return false;
  switch (edit.op) {
    case "add_item": return validPlanItemForDisplay(edit.new_item) && edit.new_item.id === edit.item;
    case "remove_item": return true;
    case "set_field": return ["title", "intent"].includes(edit.field) && boundedText(edit.value, 0, 1200);
    case "add_file":
    case "update_file": return validPlanFileForDisplay(edit.file);
    case "remove_file": return boundedText(edit.value, 0, 1200);
    case "add_check": return validPlanCheckForDisplay(edit.check);
    case "remove_check": return Number.isSafeInteger(edit.check_index) && edit.check_index >= 0;
    case "set_depends": return Array.isArray(edit.depends_on) && edit.depends_on.length <= 29 && edit.depends_on.every(validPlanId);
    default: return false;
  }
}
function validEditReplyForDisplay(reply, revision) {
  return exactObject(reply, ["schema_version", "base_revision", "reply", "edits"]) && reply.schema_version === 1 &&
    Number.isSafeInteger(reply.base_revision) && reply.base_revision === revision && boundedText(reply.reply, 0, 4000) &&
    Array.isArray(reply.edits) && reply.edits.length <= 10 && reply.edits.every(validPlanEditForDisplay);
}
function validPlanAuthorStatus(status, request) {
  const states = ["pending", "ready", "failed", "cancelled", "invalidated", "consumed"];
  const statusKeys = request.mode === "suggest" ? ["mode", "state", "revision", "snapshotId", "reply", "reason"]
    : ["state", "revision", "snapshotId", "plan", "reason"];
  const validShape = exactObject(status, statusKeys);
  const validMode = validShape && (request.mode === "suggest" ? status.mode === "suggest" : !("mode" in status));
  if (!validShape || !validMode || !states.includes(status.state) ||
      !Number.isSafeInteger(status.revision) || status.revision < 1 ||
      typeof status.snapshotId !== "string" || !status.snapshotId ||
      status.revision !== request.revision || status.snapshotId !== request.snapshotId ||
      !(status.reason === null || typeof status.reason === "string")) return false;
  const terminalReason = ["failed", "cancelled", "invalidated"].includes(status.state);
  if (terminalReason ? !(typeof status.reason === "string" && status.reason.length > 0) : status.reason !== null) return false;
  const result = request.mode === "draft" ? status.plan : status.reply;
  const validDraft = validPlanForDisplay(result) && result.issue === request.issue && result.revision === status.revision + 1;
  const validReply = validEditReplyForDisplay(result, status.revision);
  const validResult = request.mode === "draft" ? validDraft : validReply;
  if (["pending", "failed"].includes(status.state)) return result === null;
  if (["ready", "consumed"].includes(status.state)) return !!validResult;
  return result === null || !!validResult;
}
function planApplyButton(request, index, stale) {
  const selectedApply = request.applyingIndex === index;
  const uncertain = request.state === "apply-uncertain";
  const visible = (request.state === "ready" && !stale) || request.state === "applying" || uncertain;
  if (!visible) return "";
  const disabled = request.state === "applying" || (uncertain && !selectedApply);
  const label = request.state === "applying" && selectedApply ? "Applying…"
    : uncertain && selectedApply ? "Retry Apply"
    : index === null ? "Apply draft" : "Apply this edit";
  const suffix = index === null ? "draft" : String(index);
  return `<button type="button" id="plan-author-apply-${suffix}" data-plan-apply="${suffix}"${disabled ? ' aria-disabled="true"' : ""}>${label}</button>`;
}
function planAuthorResultMarkup(request, historical = false) {
  if (request.state === "cancelled") return "";
  const stale = planAuthorStale(request);
  const historyMark = historical ? ` <span class="${stale ? "warn" : "muted"}">${stale ? "! Stale" : "– Earlier result"}</span>` : "";
  let result = "";
  if (request.mode === "suggest" && request.reply) {
    result = `<div class="plan-author-result-heading"><strong>${historical ? "Earlier suggested edits" : "Suggested edits"}</strong> <span class="mono muted">r${esc(request.revision)}</span>${historyMark}</div>
      ${request.reply.reply ? `<p class="plan-author-reply">${esc(request.reply.reply)}</p>` : ""}
      ${request.reply.edits.map((edit, index) => `<article class="suggestion-row" aria-label="${esc(edit.summary)}"><header><code>${esc(edit.item)}</code><h3>${esc(edit.summary)}</h3></header><p>${esc(edit.reason)}</p><p class="suggestion-change">${esc(describePlanEdit(edit))}</p>${historical ? "" : `<div class="suggestion-actions">${planApplyButton(request, index, stale)}</div>`}</article>`).join("") || '<p class="plan-author-reply muted">No edits were suggested.</p>'}`;
  } else if (request.mode === "draft" && request.plan) {
    result = `<div class="plan-author-result-heading"><strong>${historical ? "Earlier draft revision" : "Draft revision"}</strong> <span class="mono muted">r${esc(request.plan.revision)}</span>${historyMark}</div>
      <section class="draft-preview" aria-label="Draft ${esc(request.plan.summary)}"><header><h3>${esc(request.plan.summary)}</h3></header>
      <ul class="draft-items">${request.plan.items.map((item) => `<li><code>${esc(item.id)}</code> ${esc(item.title)}</li>`).join("")}</ul>${historical ? "" : `<div class="suggestion-actions">${planApplyButton(request, null, stale)}</div>`}</section>`;
  }
  const dismissible = request.state === "cancelling" || (request.state === "ready" && !stale);
  if (!historical && result && request.requestId && dismissible)
    result += `<div class="plan-author-result-actions"><button type="button" id="plan-author-dismiss"${request.state === "cancelling" ? ' aria-disabled="true"' : ""}>${request.state === "cancelling" ? "Dismissing…" : `Dismiss ${request.mode === "draft" ? "draft" : "suggestions"}`}</button></div>`;
  const remaining = request.mode === "suggest" && request.state === "consumed" && Number.isSafeInteger(request.appliedIndex)
      && data?.plan?.revision >= request.revision + 1
    ? request.reply.edits.filter((_, index) => index !== request.appliedIndex) : [];
  if (!historical && remaining.length)
    result += '<div class="plan-author-result-actions"><span class="warn">! Plan changed — refresh suggestions</span><button type="button" id="plan-author-refresh-suggestions">Refresh suggestions</button></div>';
  return result;
}
function renderPlanAuthor() {
  const restoreDismissFocus = document.activeElement?.id === "plan-author-dismiss";
  const restoreApplyFocus = document.activeElement?.id?.startsWith("plan-author-apply-") ? document.activeElement.id : null;
  const request = planAuthorRequest, unavailable = !data?.plan;
  const busyAuthor = planAuthorBusy(), uncertain = request?.state === "uncertain", applyUncertain = request?.state === "apply-uncertain";
  const appliedReloadPending = request?.state === "consumed" && !(data?.plan?.revision >= request.revision + 1);
  for (const [id, mode, label] of [["plan-draft", "draft", "Draft next revision"], ["plan-suggest", "suggest", "Suggest edits"]]) {
    const button = $(id);
    const blocked = unavailable || busyAuthor || applyUncertain || appliedReloadPending || (uncertain && request.mode !== mode);
    if (blocked) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
    button.textContent = request?.state === "starting" && request.mode === mode ? "Starting…"
      : request?.state === "pending" && request.mode === mode ? "Working…"
      : request?.state === "cancelling" && request.mode === mode ? "Cancelling…"
      : uncertain && request.mode === mode ? `Retry ${mode === "draft" ? "draft" : "suggestion"} request`
      : label;
  }
  if (!request) {
    $("plan-author-status").className = "neutral";
    $("plan-author-status").textContent = !unavailable ? "" : reviewLoading()
      ? "The plan is still loading. Ask the agent after it appears." : "Load a plan before asking the agent.";
    $("plan-author-result").innerHTML = "";
    return;
  }
  const noun = request.mode === "draft" ? "draft" : "suggestions", stale = planAuthorStale(request);
  const hasResult = !!(request.reply || request.plan);
  let tone = "neutral", message = "";
  if (request.state === "starting") message = `Starting ${noun}…`;
  else if (request.state === "uncertain") { tone = "warn"; message = `! The ${noun} request outcome is unknown. Retry the exact request.`; }
  else if (request.state === "applying") message = `Applying ${request.mode === "draft" ? "draft" : "suggestion"} to r${request.revision}…`;
  else if (request.state === "apply-uncertain") { tone = "warn"; message = `! The Apply outcome is unknown. Retry the exact Apply action.`; }
  else if (request.state === "failed") { tone = "bad"; message = `✕ ${request.mode === "draft" ? "Draft" : "Suggestion"} failed. ${request.reason || "Try again."}`; }
  else if (request.state === "cancelling") message = `Cancelling ${noun}…`;
  else if (request.state === "cancelled") message = `– ${request.mode === "draft" ? "Draft" : "Suggestions"} dismissed. ${request.reason || ""}`.trim();
  else if (request.state === "invalidated") { tone = "warn"; message = `! ${request.mode === "draft" ? "Draft" : "Suggestions"} became stale. ${request.reason || "Reload and ask again."}`; }
  else if (stale) { tone = "warn"; message = `! Stale ${hasResult ? `${noun} · generated` : `${noun} request · started`} for r${request.revision}`; }
  else if (request.state === "pending") message = `Agent is preparing ${noun} for r${request.revision}…`;
  else if (request.state === "ready") { tone = "good"; message = `✓ ${request.mode === "draft" ? "Draft" : "Suggestions"} ready for r${request.revision}.`; }
  if (request.observationError) message += ` Status check failed: ${request.observationError}`;
  $("plan-author-status").className = tone;
  $("plan-author-status").textContent = message;
  $("plan-author-result").innerHTML = [planAuthorResultMarkup(request), ...planAuthorHistory.map(entry => planAuthorResultMarkup(entry, true))].join("");
  $("plan-author-dismiss")?.addEventListener("click", dismissPlanAuthor);
  document.querySelectorAll("[data-plan-apply]").forEach(button => button.addEventListener("click", () =>
    applyPlanAuthor(button.dataset.planApply === "draft" ? null : Number(button.dataset.planApply))));
  $("plan-author-refresh-suggestions")?.addEventListener("click", refreshPlanSuggestions);
  if (restoreDismissFocus) $("plan-author-dismiss")?.focus();
  else if (restoreApplyFocus) ($(restoreApplyFocus) ?? $("plan-author-refresh-suggestions") ?? $("plans-refresh"))?.focus();
}
function renderPlans() {
  renderPlanImport();
  if (!data?.plan) {
    $("plans-summary").textContent = reviewLoading() ? "Loading plan…" : "Plan unavailable";
    $("plans-revision").textContent = "";
    $("plans-items").innerHTML = "";
    $("plans-questions").innerHTML = "";
    renderPlanAuthor();
    return;
  }
  const plan = data.plan;
  $("plans-identity").textContent = `#${plan.issue}`;
  $("plans-summary").textContent = plan.summary;
  $("plans-revision").textContent = `r${plan.revision}`;
  $("plans-questions").innerHTML = plan.questions.length
    ? `<section class="plan-questions"><h2>Open questions</h2><ul>${plan.questions.map((question) => `<li>${esc(question)}</li>`).join("")}</ul></section>`
    : "";
  $("plans-items").innerHTML = plan.items.map((item) => `
    <article class="plan-card" aria-labelledby="plan-${esc(item.id)}">
      <header><code>${esc(item.id)}</code><h2 id="plan-${esc(item.id)}">${esc(item.title)}</h2></header>
      <p>${esc(item.intent)}</p>
      ${item.depends_on.length ? `<p class="plan-dependencies"><span class="muted">Depends on</span> ${item.depends_on.map((dependency) => `<code>${esc(dependency)}</code>`).join(" ")}</p>` : ""}
      <div class="plan-card-grid">
        <section><h3>Files</h3><ul class="plan-detail-list">${item.files.map((file) => `<li><span class="plan-file-path">${file.kind === "rename" ? `<code>${esc(file.renamed_from)}</code><span aria-hidden="true">→</span>` : ""}<code>${esc(file.path)}</code></span><span>${esc(file.kind)} · ${esc(file.change)}</span></li>`).join("")}</ul></section>
        <section><h3>Acceptance</h3><ul class="plan-detail-list">${item.acceptance.map((check) => `<li><code>${esc(check.type)}</code><span>${esc(check.text)}</span></li>`).join("")}</ul></section>
      </div>
    </article>`).join("");
  renderPlanAuthor();
}
// A plan or review is being read: the page's review read, or Refresh plan, which reads without taking the busy flag.
const reviewLoading = () => busyKind === "read" || planRefreshPending;
// aria-disabled, not disabled: focus stays on the button, and a click with no plan loaded still reaches importPlan,
// which says why nothing was imported. The form is novalidate so the browser's file check cannot answer first;
// importPlan reports a missing file itself. (During an import, the button's "Importing…" label shows the state.)
function renderPlanImport() {
  if (planImportPending || !data?.plan) $("plan-import").setAttribute("aria-disabled", "true");
  else $("plan-import").removeAttribute("aria-disabled");
}
function planFileFormat(name) {
  return /\.ya?ml$/i.test(name) ? "yaml" : /\.json$/i.test(name) ? "json" : null;
}
function renderPlanFile() {
  const file = $("plan-file").files[0];
  const format = file && planFileFormat(file.name);
  $("plan-file-details").textContent = file
    ? `${file.name} · ${format ? format.toUpperCase() : "Choose a .json, .yaml, or .yml file"}`
    : "No file selected";
}
async function importPlan(event) {
  event.preventDefault();
  if (planImportPending) return;
  // The busy refusal and the "still loading" refusal keep the current status ownership, so a running Apply, review read
  // or Refresh plan replaces them with its result instead of being hidden by them. The "no plan" refusal claims the line
  // only when nothing is running. The file refusal below always claims it, like the import itself: feedback on the
  // file just chosen is newer than any read already running, so that read's result must not replace it.
  if (busy && busyKind !== "read") {
    setPlanStatus(planStatusGeneration, "warn", "! Wait for the current review action before importing a plan.");
    return;
  }
  if (!data?.plan) {
    if (reviewLoading()) setPlanStatus(planStatusGeneration, "warn", "! The plan is still loading. Nothing was imported. Import after it appears.");
    else claimPlanStatus("bad", "✕ No plan is loaded, so nothing was imported. Use Refresh plan, then import.");
    return;
  }
  const file = $("plan-file").files[0], format = file && planFileFormat(file.name);
  if (!file || !format) {
    claimPlanStatus("bad", "✕ Choose a JSON or YAML plan file.");
    return;
  }
  supersedePlanRefresh();
  planOperationGeneration++;
  const sharedGeneration = ++reviewGeneration;
  mergeGeneration++;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  const busyOwner = beginBusy("write");
  planImportPending = true;
  $("plan-import").setAttribute("aria-disabled", "true");
  $("plan-import").textContent = "Importing…";
  const statusOwner = claimPlanStatus("neutral", "Reading the plan file…");
  let source;
  try {
    source = await file.text();
  } catch (error) {
    planImportPending = false;
    endBusy(busyOwner);
    renderPlanImport();
    $("plan-import").textContent = "Import next revision";
    setPlanStatus(statusOwner, "bad", `✕ Could not read the plan file. ${error.message}`);
    renderMerge();
    return;
  }
  const expectedRevision = data.plan.revision;
  const retryKey = JSON.stringify([format, source]);
  const request = planImportRetries.get(retryKey) ?? { source, format, expectedRevision, actionId: crypto.randomUUID() };
  planImportRetries.set(retryKey, request);
  setPlanStatus(statusOwner, "neutral", "Importing the next revision…");
  try {
    const response = await api("/api/plan/import", request);
    const revision = Number.isSafeInteger(response.result?.revision) ? response.result.revision : null;
    planImportRetries.delete(retryKey);
    if (data?.merge?.available) data = { ...data, merge: { ...data.merge, ready: false, action: null,
      blockers: [{ code: "plan-changed", message: "The plan changed. Refresh before merging." }] } };
    renderMerge();
    setPlanStatus(statusOwner, revision === null ? "warn" : "good", revision === null
      ? "! The import returned success without a revision. Reloading the current plan…"
      : `✓ Imported revision r${revision}. Reloading…`);
    try {
      rememberDraft();
      const mergeObservationOwner = mergeObservationGeneration;
      const updated = await api("/api/review");
      if (sharedGeneration !== reviewGeneration) return;
      mergeGeneration++;
      if (mergePollTimer) clearTimeout(mergePollTimer);
      mergePollTimer = null;
      mergePollState = null;
      mergePollDelay = 2000;
      rememberDraft();
      const newer = newerMergeObservations(updated, mergeObservationOwner);
      data = preserveSettledQuestionAnswers(withNewerMergeObservations(updated, newer));
      render();
      showNewerMergeObservations(newer);
      if ($("plan-file").files[0] === file) $("plan-file").value = "";
      renderPlanFile();
      setPlanStatus(statusOwner, "good", `✓ Revision r${data.plan.revision} is current.`);
    } catch (error) {
      setPlanStatus(statusOwner, "warn", `! ${revision === null ? "The import returned success" : `Revision r${revision} was imported`}, but the current plan could not reload. ${error.message}`);
      renderMerge();
    }
  } catch (error) {
    const ambiguous = !Number.isSafeInteger(error?.status) || error.status === 503 || error.outcomeUnknown === true;
    if (!ambiguous) planImportRetries.delete(retryKey);
    if (ambiguous && data?.merge?.available) data = { ...data, merge: { ...data.merge, ready: false, action: null,
      blockers: [{ code: "plan-import-unknown", message: "The plan import outcome is unknown. Refresh before merging." }] } };
    setPlanStatus(statusOwner, "bad", `✕ Could not import the plan. ${error.message}`);
    renderMerge();
  } finally {
    planImportPending = false;
    endBusy(busyOwner);
    renderPlanImport();
    $("plan-import").textContent = "Import next revision";
  }
}
function schedulePlanAuthorPoll(generation, delay = planAuthorRequest?.pollDelay ?? planAuthorPollInitial) {
  const request = planAuthorRequest;
  if (!request || request.generation !== generation || !request.requestId) return;
  if (request.pollTimer) clearTimeout(request.pollTimer);
  request.pollTimer = setTimeout(() => pollPlanAuthor(generation), delay);
}
async function pollPlanAuthor(generation) {
  const request = planAuthorRequest;
  if (!request || request.generation !== generation || !request.requestId) return;
  request.pollTimer = null;
  const operationGeneration = request.operationGeneration;
  try {
    const status = await api(`/api/plan/${request.mode === "draft" ? "drafts" : "suggestions"}/${request.requestId}`);
    if (planAuthorRequest !== request || request.generation !== generation || request.operationGeneration !== operationGeneration) return;
    if (!validPlanAuthorStatus(status, request)) throw new Error("Planning status response was incomplete, invalid, or belonged to another plan context.");
    const changed = request.state !== status.state;
    const previous = { state: request.state, reason: request.reason, reply: request.reply, plan: request.plan,
      observationError: request.observationError, pollDelay: request.pollDelay };
    request.state = status.state;
    request.reason = status.reason;
    request.observationError = null;
    if (request.mode === "draft") request.plan = status.plan;
    else request.reply = status.reply;
    request.pollDelay = changed ? planAuthorPollInitial : Math.min(request.pollDelay * 2, planAuthorPollMaximum);
    try { renderPlanAuthor(); }
    catch (error) { Object.assign(request, previous); throw error; }
    request.operationGeneration++;
    if (request.state === "pending") schedulePlanAuthorPoll(generation);
  } catch (error) {
    if (planAuthorRequest !== request || request.generation !== generation || request.operationGeneration !== operationGeneration) return;
    request.observationError = error.message;
    request.pollDelay = Math.min(request.pollDelay * 2, planAuthorPollMaximum);
    renderPlanAuthor();
    schedulePlanAuthorPoll(generation);
  }
}
async function startPlanAuthor(mode, feedbackOverride = null) {
  if (!data?.plan || planAuthorBusy() || planAuthorRequest?.state === "apply-uncertain" ||
      (planAuthorRequest?.state === "consumed" && data.plan.revision < planAuthorRequest.revision + 1)) return;
  if (planImportPending || planRefreshPending || busy) {
    $("plan-author-status").className = "warn";
    $("plan-author-status").textContent = "! Wait for the current plan or review action before asking the agent.";
    return;
  }
  if (planAuthorRequest?.state === "uncertain" && planAuthorRequest.mode !== mode) return;
  const retry = planAuthorRequest?.state === "uncertain" && planAuthorRequest.mode === mode;
  const requestBody = retry ? planAuthorRequest.request : {
    expectedRevision: data.plan.revision,
    snapshotId: data.snapshot.id,
    feedback: feedbackOverride ?? $("plan-feedback").value,
    actionId: crypto.randomUUID(),
  };
  if (planAuthorRequest?.reply || planAuthorRequest?.plan)
    planAuthorHistory.unshift({ ...planAuthorRequest, pollTimer: null });
  const request = {
    generation: ++planAuthorGeneration,
    mode,
    state: "starting",
    revision: requestBody.expectedRevision,
    snapshotId: requestBody.snapshotId,
    issue: data.plan.issue,
    request: requestBody,
    requestId: null,
    reason: null,
    reply: null,
    plan: null,
    observationError: null,
    pollDelay: planAuthorPollInitial,
    pollTimer: null,
    cancelActionId: null,
    applyAction: null,
    applyingIndex: null,
    appliedIndex: null,
    operationGeneration: 0,
  };
  planAuthorRequest = request;
  renderPlanAuthor();
  try {
    const response = await api(`/api/plan/${mode === "draft" ? "drafts" : "suggestions"}`, requestBody);
    if (planAuthorRequest !== request) return;
    const requestId = response.result?.requestId;
    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))
      throw new Error("The planning request started without a valid ID.");
    request.requestId = requestId;
    request.state = "pending";
    renderPlanAuthor();
    schedulePlanAuthorPoll(request.generation, 0);
  } catch (error) {
    if (planAuthorRequest !== request) return;
    const ambiguous = !Number.isSafeInteger(error?.status) || error.status === 503 || error.outcomeUnknown === true;
    request.state = ambiguous ? "uncertain" : "failed";
    request.reason = error.message;
    renderPlanAuthor();
  }
}
function refreshPlanSuggestions() {
  const request = planAuthorRequest;
  if (!request || request.mode !== "suggest" || request.state !== "consumed" || !Number.isSafeInteger(request.appliedIndex)) return;
  const remaining = request.reply.edits.filter((_, index) => index !== request.appliedIndex);
  if (!remaining.length) return;
  const feedback = `Re-evaluate these unapplied suggestions against the current plan. Do not assume their old indexes or payloads are still valid:\n${remaining.map(edit => `- ${edit.op} ${edit.item}: ${edit.summary}`).join("\n")}`;
  startPlanAuthor("suggest", feedback);
}
async function applyPlanAuthor(index) {
  const request = planAuthorRequest;
  const retry = request?.state === "apply-uncertain" && request.applyingIndex === index;
  if (!request?.requestId || (!retry && (request.state !== "ready" || planAuthorStale(request))) ||
      (request.mode === "draft" ? index !== null : !Number.isSafeInteger(index) || !request.reply.edits[index])) return;
  if (planImportPending || planRefreshPending || busy) {
    $("plan-author-status").className = "warn";
    $("plan-author-status").textContent = "! Wait for the current plan or review action before applying this result.";
    return;
  }
  supersedePlanRefresh();
  const generation = ++planOperationGeneration;
  const sharedGeneration = ++reviewGeneration;
  const mergeObservationOwner = mergeObservationGeneration;
  mergeGeneration++;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  const busyOwner = beginBusy("write");
  request.operationGeneration++;
  if (request.pollTimer) clearTimeout(request.pollTimer);
  request.pollTimer = null;
  request.applyAction ??= { actionId: crypto.randomUUID(), index };
  request.applyingIndex = index;
  request.state = "applying";
  request.reason = null;
  request.observationError = null;
  const statusOwner = claimPlanStatus("neutral", `Applying ${request.mode === "draft" ? "draft" : "suggestion"}…`);
  rememberDraft();
  renderPlanAuthor();
  try {
    const response = await api(`/api/plan/${request.mode === "draft" ? "drafts" : "suggestions"}/${request.requestId}/apply`, {
      actionId: request.applyAction.actionId,
      ...(request.mode === "suggest" ? { index } : {}),
    });
    const revision = response.result?.revision;
    if (!Number.isSafeInteger(revision) || revision !== request.revision + 1)
      throw Object.assign(new Error("Apply returned success without the expected revision."), { outcomeUnknown: true });
    request.state = "consumed";
    request.appliedIndex = index;
    request.applyAction = null;
    request.reason = null;
    if (data?.merge?.available) data = { ...data, merge: { ...data.merge, ready: false, action: null,
      blockers: [{ code: "plan-changed", message: "The plan changed. Refresh before merging." }] } };
    renderMerge();
    setPlanStatus(statusOwner, "good", `✓ Applied revision r${revision}. Reloading…`);
    try {
      const updated = await api("/api/review");
      if (generation !== planOperationGeneration || sharedGeneration !== reviewGeneration || planAuthorRequest !== request) return;
      if (!updated?.plan || updated.plan.revision < revision)
        throw new Error(`The authoritative review did not include applied revision r${revision}.`);
      rememberDraft();
      mergeGeneration++;
      if (mergePollTimer) clearTimeout(mergePollTimer);
      mergePollTimer = null;
      mergePollState = null;
      mergePollDelay = 2000;
      const newer = newerMergeObservations(updated, mergeObservationOwner);
      data = preserveSettledQuestionAnswers(withNewerMergeObservations(updated, newer));
      render();
      showNewerMergeObservations(newer);
      setPlanStatus(statusOwner, "good", `✓ Revision r${data.plan.revision} is current.`);
    } catch (error) {
      request.observationError = `Revision r${revision} was applied, but the current plan could not reload. ${error.message}`;
      renderPlanAuthor();
      setPlanStatus(statusOwner, "warn", `! Revision r${revision} was applied, but the current plan could not reload. ${error.message}`);
      renderMerge();
    }
  } catch (error) {
    if (generation !== planOperationGeneration || sharedGeneration !== reviewGeneration || planAuthorRequest !== request) return;
    const ambiguous = !Number.isSafeInteger(error?.status) || error.status === 503 || error.outcomeUnknown === true;
    request.state = ambiguous ? "apply-uncertain" : "invalidated";
    request.reason = error.message;
    if (!ambiguous) request.applyAction = null;
    if (data?.merge?.available) data = { ...data, merge: { ...data.merge, ready: false, action: null,
      blockers: [{ code: ambiguous ? "plan-apply-unknown" : "plan-apply-refused", message: `${error.message} Refresh before merging.` }] } };
    renderPlanAuthor();
    renderMerge();
    setPlanStatus(statusOwner, ambiguous ? "warn" : "bad", `${ambiguous ? "!" : "✕"} Could not confirm Apply. ${error.message}`);
  } finally {
    endBusy(busyOwner);
  }
}
async function dismissPlanAuthor() {
  const request = planAuthorRequest;
  if (!request?.requestId || planAuthorBusy()) return;
  request.cancelActionId ??= crypto.randomUUID();
  request.operationGeneration++;
  request.state = "cancelling";
  renderPlanAuthor();
  try {
    await api(`/api/plan/${request.mode === "draft" ? "drafts" : "suggestions"}/${request.requestId}/cancel`, { actionId: request.cancelActionId });
    if (planAuthorRequest !== request) return;
    request.observationError = null;
    schedulePlanAuthorPoll(request.generation, 0);
  } catch (error) {
    if (planAuthorRequest !== request) return;
    const ambiguous = !Number.isSafeInteger(error?.status) || error.status === 503 || error.outcomeUnknown === true;
    if (!ambiguous) request.cancelActionId = null;
    request.observationError = error.message;
    renderPlanAuthor();
    schedulePlanAuthorPoll(request.generation);
  }
}
function showView(next) {
  view = next;
  $("review-view").hidden = next !== "review";
  $("issues-view").hidden = next !== "issues";
  $("plans-view").hidden = next !== "plans";
  for (const [id, name] of [["review-link", "review"], ["issues-link", "issues"], ["plans-link", "plans"]]) {
    if (name === next) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  const title = next === "issues" ? "Issues" : next === "plans" ? "Plans" : "Review";
  document.title = `${title} · codeboost`;
  history.replaceState(null, "", next === "review" ? "/" : `/?view=${next}`);
  if (next === "issues" && !issuesRequested) loadIssues();
  if (next === "plans") renderPlans();
}
const issueTime = (value) => esc(new Date(value).toLocaleString());
function issueStatus() {
  if (!issuesView) return ["neutral", "Loading issues…"];
  if (!issuesView.configured) return ["neutral", `– Not configured. ${esc(issuesView.reason)}`];
  const state = issuesView.state;
  if (!state) return ["neutral", issuesView.refreshing ? "Loading issues…" : "– Not loaded yet"];
  if (state.state === "fresh")
    return ["good", `✓ Current · retrieved ${issueTime(state.retrievedAt)} · ${state.issues.length} open issue${state.issues.length === 1 ? "" : "s"}`];
  if (state.state === "stale")
    return ["warn", `! Stale · showing issues retrieved ${issueTime(state.retrievedAt)}. Refresh failed at ${issueTime(state.failedAt)}: ${esc(state.error)}`];
  return ["bad", `✕ Unavailable · ${esc(state.error)}`];
}
function trustMark(issue) {
  if (issue.trust === "trusted") return `<span class="good" aria-label="Trust: author is a repository collaborator">✓ Collaborator</span>
    <button class="issue-trust" data-action="trust" data-issue="${issue.number}">Trust all comments</button>`;
  if (issue.trust === "approved") return `<span class="good" aria-label="Trust: trusted by you on ${esc(issue.trustedAt)}">✓ Trusted by you on ${esc(new Date(issue.trustedAt).toLocaleDateString())}</span>
    <button class="issue-trust" data-action="untrust" data-issue="${issue.number}">Remove trust</button>`;
  return `<span class="warn" aria-label="Trust: needs your trust before queueing, author is not a repository collaborator">! Needs trust</span>
    <button class="issue-trust" data-action="trust" data-issue="${issue.number}">Trust this issue</button>`;
}
function renderIssues() {
  const [tone, text] = issueStatus();
  const errors = [...trustErrors.values(), ...(issuesRefreshError ? [issuesRefreshError] : [])].sort((a, b) => a.order - b.order);
  $("issues-status").className = errors.length ? "bad" : tone;
  if (errors.length) $("issues-status").textContent = errors.map(error => error.message).join(" ");
  else $("issues-status").innerHTML = text;
  $("issues-repository").textContent = issuesView?.configured ? issuesView.repository : "";
  const state = issuesView?.configured ? issuesView.state : null;
  if (!state) {
    $("issues-list").innerHTML = "";
    return;
  }
  if (!state.issues.length) {
    $("issues-list").innerHTML =
      state.state === "unavailable"
        ? '<div class="empty"><h2>Issues could not load</h2><p>Resolve the error above, then refresh.</p></div>'
        : '<div class="empty"><h2>No open issues</h2><p>This repository has no open issues to rank.</p></div>';
    return;
  }
  $("issues-list").innerHTML = `<table class="issues-table"><thead><tr><th scope="col">Rank</th><th scope="col">Issue and reasons</th><th scope="col" class="numeric">Score</th><th scope="col">Trust</th><th scope="col">Opened</th></tr></thead><tbody>${state.issues
    .map(
      (issue, index) =>
        `<tr data-issue="${issue.number}"><td class="mono">${index + 1}</td><td><div class="issue-title"><span class="mono muted">#${issue.number}</span> ${/^https:\/\/github\.com\//.test(issue.url) ? `<a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">${esc(issue.title)}</a>` : esc(issue.title)}${issue.labels.length ? ` <span class="issue-labels mono">${issue.labels.map(esc).join(" · ")}</span>` : ""}</div><ul class="issue-reasons" aria-label="Why #${issue.number} ranks here">${issue.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul></td><td class="mono numeric">${issue.score}</td><td>${trustMark(issue)}</td><td class="mono">${esc(issue.createdAt.slice(0, 10))}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}
const trustGenerations = new Map(), trustPending = new Map(), trustRetries = new Map(), committedTrustRows = new Map(), trustErrors = new Map();
let trustCommitGeneration = 0;
function renderIssuesWithPending(focusIssue) {
  const active = document.activeElement;
  const activeRow = active?.closest?.("tr[data-issue]");
  const activeSelector = active?.matches?.("button.issue-trust") ? "button.issue-trust"
    : active?.matches?.(".issue-title a") ? ".issue-title a" : null;
  const focused = Number.isSafeInteger(focusIssue) ? { number: focusIssue, selector: "button.issue-trust" }
    : activeSelector && activeRow ? { number: Number(activeRow.dataset.issue), selector: activeSelector } : null;
  renderIssues();
  for (const [number, pending] of trustPending) {
    const control = document.querySelector(`.issue-trust[data-issue="${number}"]`);
    if (!control) continue;
    control.setAttribute("aria-disabled", "true");
    control.textContent = pending.action === "trust" ? "Trusting…" : "Removing…";
  }
  if (focused && Number.isSafeInteger(focused.number))
    document.querySelector(`tr[data-issue="${focused.number}"] ${focused.selector}`)?.focus();
}
function withIssueTrust(issue, trust) {
  const { trust: _trust, trustedAt: _trustedAt, trustedBy: _trustedBy, trustChangedAt: _trustChangedAt, ...metadata } = issue;
  return { ...metadata, trust: trust.trust,
    ...(trust.trustedAt === undefined ? {} : { trustedAt: trust.trustedAt }),
    ...(trust.trustedBy === undefined ? {} : { trustedBy: trust.trustedBy }),
    ...(trust.trustChangedAt === undefined ? {} : { trustChangedAt: trust.trustChangedAt }) };
}
function trustCanReplace(replacement, current) {
  return replacement.authorLogin === current.authorLogin
    && (current.trustChangedAt === undefined
      || (replacement.trustChangedAt !== undefined && replacement.trustChangedAt > current.trustChangedAt));
}
function mergeIssueTrustView(updated, number) {
  const currentState = issuesView?.configured ? issuesView.state : null;
  const updatedState = updated?.configured ? updated.state : null;
  const replacement = updatedState?.issues.find((issue) => issue.number === number);
  const current = currentState?.issues.find((issue) => issue.number === number);
  // A refresh may have completed while this trust request was in flight. Trust responses own only trust fields, and
  // only for the same author; they must never restore an older title, rank, author, or a row the refresh removed.
  if (!issuesView?.configured || !currentState || !updated?.configured || !updatedState || !replacement || !current
      || !trustCanReplace(replacement, current)) return null;
  const merged = currentState.issues.map((issue) => issue.number === number ? withIssueTrust(issue, replacement) : issue);
  issuesView = { ...issuesView, state: { ...currentState, issues: merged } };
  return merged.find((issue) => issue.number === number) ?? null;
}
function mergeTrustCommittedDuring(updated, generation) {
  if (!updated?.configured || !updated.state) return updated;
  return { ...updated, state: { ...updated.state, issues: updated.state.issues.map((issue) => {
    const committed = committedTrustRows.get(issue.number);
    return committed && committed.generation > generation && trustCanReplace(committed, issue)
      ? withIssueTrust(issue, committed) : issue;
  }) } };
}
async function changeIssueTrust(button) {
  if (button.getAttribute("aria-disabled") === "true") return;
  const number = Number(button.dataset.issue), action = button.dataset.action;
  const issue = issuesView?.configured && issuesView.state?.issues.find((entry) => entry.number === number);
  if (!issue || !["trust", "untrust"].includes(action)) return;
  const retained = trustRetries.get(number);
  const request = retained?.action === action && retained.authorLogin === issue.authorLogin ? retained
    : { action, actionId: crypto.randomUUID(), number, authorLogin: issue.authorLogin };
  trustRetries.set(number, request);
  const generation = (trustGenerations.get(number) ?? 0) + 1;
  trustGenerations.set(number, generation);
  trustErrors.delete(number);
  trustPending.set(number, { action, generation });
  renderIssuesWithPending(number);
  try {
    const updated = await api("/api/issues", request);
    if (trustRetries.get(number) === request) trustRetries.delete(number);
    if (trustGenerations.get(number) !== generation) return;
    trustPending.delete(number);
    trustErrors.delete(number);
    const committed = mergeIssueTrustView(updated, number);
    if (committed) committedTrustRows.set(number, { generation: ++trustCommitGeneration, authorLogin: committed.authorLogin,
      trust: committed.trust, trustedAt: committed.trustedAt, trustedBy: committed.trustedBy, trustChangedAt: committed.trustChangedAt });
    renderIssuesWithPending();
  } catch (error) {
    // A transport failure or 503 proves nothing was returned. Keep the exact request and idempotency key for retry.
    const ambiguous = !Number.isSafeInteger(error?.status) || error.status === 503 || error.outcomeUnknown === true;
    if (!ambiguous && trustRetries.get(number) === request) trustRetries.delete(number);
    if (trustGenerations.get(number) !== generation) return;
    trustPending.delete(number);
    trustErrors.set(number, { generation, order: ++issueErrorOrder,
      message: `✕ Could not ${action === "trust" ? "trust" : "remove trust from"} issue #${number}. ${error.message}` });
    renderIssuesWithPending();
  }
}
async function loadIssues() {
  if (issuesLoading) return;
  const generation = ++issuesGeneration;
  const trustGeneration = trustCommitGeneration;
  const trustErrorOrder = issueErrorOrder;
  issuesRequested = true;
  issuesLoading = true;
  issuesRefreshError = null;
  // aria-disabled, not disabled: disabling the focused button would drop keyboard focus to the page.
  $("issues-refresh").setAttribute("aria-disabled", "true");
  $("issues-refresh").textContent = "Refreshing…";
  if (issuesView?.configured) issuesView = { ...issuesView, refreshing: true };
  renderIssuesWithPending();
  try {
    const updated = await api("/api/issues", { action: "refresh" });
    if (generation !== issuesGeneration) return;
    issuesView = mergeTrustCommittedDuring(updated, trustGeneration);
    for (const [number, error] of trustErrors) if (error.order <= trustErrorOrder) trustErrors.delete(number);
    renderIssuesWithPending();
  } catch (error) {
    if (generation !== issuesGeneration) return;
    if (issuesView?.configured) issuesView = { ...issuesView, refreshing: false };
    issuesRefreshError = { generation, order: ++issueErrorOrder, message: `✕ Could not refresh issues. ${error.message}` };
    renderIssuesWithPending();
  } finally {
    if (generation === issuesGeneration) {
      issuesLoading = false;
      $("issues-refresh").removeAttribute("aria-disabled");
      $("issues-refresh").textContent = "Refresh issues";
    }
  }
}
$("issues-link").onclick = (event) => {
  event.preventDefault();
  showView("issues");
};
$("plans-link").onclick = (event) => {
  event.preventDefault();
  showView("plans");
};
$("plans-refresh").onclick = async () => {
  if (planRefreshPending || planImportPending) return;
  if (busy) return;
  const generation = ++planOperationGeneration;
  let sharedGeneration = ++reviewGeneration;
  const mergeObservationOwner = mergeObservationGeneration;
  mergeGeneration++;
  if (mergePollTimer) clearTimeout(mergePollTimer);
  mergePollTimer = null;
  mergePollState = null;
  mergePollDelay = 2000;
  planRefreshPending = true;
  $("plans-refresh").setAttribute("aria-disabled", "true");
  $("plans-refresh").textContent = "Refreshing…";
  const statusOwner = claimPlanStatus("neutral", "Refreshing the current plan…");
  if (!data) renderPlans();
  try {
    rememberDraft();
    const updated = await api("/api/review");
    if (generation !== planOperationGeneration || sharedGeneration !== reviewGeneration) return;
    sharedGeneration = ++reviewGeneration;
    mergeGeneration++;
    if (mergePollTimer) clearTimeout(mergePollTimer);
    mergePollTimer = null;
    mergePollState = null;
    mergePollDelay = 2000;
    rememberDraft();
    const newer = newerMergeObservations(updated, mergeObservationOwner);
    data = preserveSettledQuestionAnswers(withNewerMergeObservations(updated, newer));
    render();
    showNewerMergeObservations(newer);
    setPlanStatus(statusOwner, "good", `✓ Revision r${data.plan.revision} is current.`);
  } catch (error) {
    if (generation !== planOperationGeneration || sharedGeneration !== reviewGeneration) return;
    setPlanStatus(statusOwner, "bad", `✕ Could not refresh the current plan. ${error.message}`);
    renderMerge();
  } finally {
    const current = generation === planOperationGeneration && sharedGeneration === reviewGeneration;
    if (!current)
      setPlanStatus(statusOwner, "neutral", "");
    if (generation === planOperationGeneration) {
      planRefreshPending = false;
      $("plans-refresh").removeAttribute("aria-disabled");
      $("plans-refresh").textContent = "Refresh plan";
      if (!data) renderPlans();
    }
  }
};
$("plan-file").onchange = renderPlanFile;
$("plan-import-form").onsubmit = importPlan;
$("plan-draft").onclick = () => startPlanAuthor("draft");
$("plan-suggest").onclick = () => startPlanAuthor("suggest");
$("issues-refresh").onclick = () => loadIssues();
$("issues-list").onclick = (event) => {
  const button = event.target.closest("button.issue-trust");
  if (button) changeIssueTrust(button);
};
const initialView = new URLSearchParams(location.search).get("view");
showView(["issues", "plans"].includes(initialView) ? initialView : "review");

await refresh();
