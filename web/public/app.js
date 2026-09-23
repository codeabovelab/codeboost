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
  history.replaceState(null, "", location.pathname);
}
let data,
  selected,
  change = 0,
  mode = "question",
  since = false,
  busy = false;
let reviewGeneration = 0;
const drafts = new Map();
const attachments = new Map();
let snippetSelection = null;
const statusClass = (text) =>
  text.startsWith("✓")
    ? "good"
    : text.startsWith("✕")
      ? "bad"
      : text.startsWith("!")
        ? "warn"
        : "neutral";
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
  if (!response.ok) throw new Error(value.error || "Request failed.");
  return value;
}
function rememberDraft() {
  if (selected) drafts.set(`${selected}:${mode}`, $("message").value);
}
function showFailure(message) {
  data = null;
  snippetSelection = null;
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
  $("message").disabled = true;
  $("save-note").disabled = true;
  $("previous").disabled = true;
  $("next").disabled = true;
  $("code").innerHTML =
    '<div class="empty"><h2>Review could not load</h2><p>Refresh after resolving the error above.</p></div>';
}
async function refresh() {
  if (busy) return;
  busy = true;
  reviewGeneration++;
  renderAttachment();
  $("banner").textContent = "Linking changes to plan items…";
  try {
    rememberDraft();
    data = await api("/api/review");
    snippetSelection = null;
    selected ??= data.items[0]?.id || "Unplanned";
    since = data.items.find((item) => item.id === selected)?.state === "stale";
    render();
  } catch (error) {
    showFailure(
      `Could not read this branch’s history. ${error.message} Use Refresh to retry.`,
    );
  } finally {
    busy = false;
    renderAttachment();
  }
}
async function act(command) {
  if (busy || !data) return false;
  busy = true;
  reviewGeneration++;
  renderAttachment();
  try {
    rememberDraft();
    data = await api("/api/action", { ...command, token: data.token });
    render();
    return true;
  } catch (error) {
    showFailure(`${error.message} Refresh to review the latest state.`);
    return false;
  } finally {
    busy = false;
    renderAttachment();
  }
}
function select(id) {
  rememberDraft();
  selected = id;
  snippetSelection = null;
  change = 0;
  since = data.items.find((item) => item.id === id)?.state === "stale";
  render();
}
function render() {
  const item = data.items.find((item) => item.id === selected);
  if (!item && !["Unplanned", "Ambiguous", "Accepted"].includes(selected)) {
    selected = data.items[0]?.id || "Unplanned";
    return render();
  }
  $("repository").textContent = data.repository;
  $("issue").textContent =
    `#${data.plan.issue} ${data.plan.summary} · r${data.plan.revision}`;
  $("progress").textContent =
    `${data.approved} of ${data.items.length} approved`;
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
      .join("");
  document
    .querySelectorAll("[data-select]")
    .forEach((button) =>
      button.addEventListener("click", () => select(button.dataset.select)),
    );
  $("item-id").textContent = item?.id || "REVIEW EXCEPTIONS";
  $("item-title").textContent = item?.title || selected;
  $("item-details").innerHTML = item
    ? `<p>${esc(item.intent)}</p>${item.reasons.map((reason) => `<p class="warn">! Stale: ${esc(reason)}</p>`).join("")}`
    : "";
  $("approve").hidden = !item;
  $("approve").textContent = item?.ambiguousCount
    ? "Resolve ambiguous changes"
    : item?.count
      ? `Approve ${item.id}`
      : "Confirm no change needed";
  $("approve").disabled = item?.state === "approved";
  $("view-toggle").innerHTML =
    item?.state === "stale"
      ? `<button data-since="true" aria-pressed="${since}">Since approval</button><button data-since="false" aria-pressed="${!since}">Full change</button>`
      : "";
  document.querySelectorAll("[data-since]").forEach((button) =>
    button.addEventListener("click", () => {
      since = button.dataset.since === "true";
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
  $("message").disabled = !item;
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
  if (since && item?.state === "stale" && item.before) {
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
        const provenance =
          segment.row === "Accepted" ? "Accepted" : segment.row;
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
          content = `<div class="file-card"><div class="provenance ${provenance === "Unplanned" ? "unplanned" : ""}">${esc(provenance)}</div><div class="file-values"><strong>▧ ${label}</strong><dl><dt>Path</dt><dd><code>${esc(meta.oldPath || "Absent")} → ${esc(meta.newPath || "Absent")}</code></dd><dt>Mode</dt><dd><code>${esc(meta.oldMode || "Absent")} → ${esc(meta.newMode || "Absent")}</code></dd></dl><p class="muted">Size: ${segment.file?.oldSize ?? "N/A"} → ${segment.file?.newSize ?? "N/A"} bytes</p>${segment.file?.beforePreview || segment.file?.afterPreview ? `<div class="image-previews">${segment.file.beforePreview ? `<figure><figcaption>Before</figcaption><img alt="Previous image in ${esc(segment.path)}" src="${esc(segment.file.beforePreview)}"></figure>` : ""}${segment.file.afterPreview ? `<figure><figcaption>After</figcaption><img alt="Current image in ${esc(segment.path)}" src="${esc(segment.file.afterPreview)}"></figure>` : ""}</div>` : '<p class="muted">No preview available</p>'}<details><summary>Details · content IDs</summary><pre>${esc(JSON.stringify(meta, null, 2))}</pre></details></div></div>`;
        } else {
          const lines = segment.content.split("\n");
          if (lines.at(-1) === "") lines.pop();
          const start =
            segment.operation === "+" ? segment.newLine : segment.oldLine;
          content = `<div class="diff ${segment.operation === "+" ? "added" : "removed"}" data-segment="${segment.key}"><div class="provenance ${provenance === "Unplanned" ? "unplanned" : ""}">${esc(provenance)}</div><div class="line-numbers">${lines.map((_, i) => `<button type="button" class="line-number" data-line="${start + i}" aria-label="Select ${segment.operation === "+" ? "added" : "removed"} line ${start + i}">${start + i}</button>`).join("")}</div><div class="sign">${esc(segment.operation)}</div><pre class="code-lines">${lines.map((line,i) => `<span data-code-line="${start+i}">${esc(line) || "&#8203;"}</span>`).join("\n")}</pre></div>`;
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
        String((button.dataset.since === "true") === since),
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
  $("message").value = drafts.get(`${selected}:${mode}`) || "";
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
$("review-link").onclick = (event) => {
  event.preventDefault();
  refresh();
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
  const attached = attachments.get(`${item}:${kind}`);
  if (attached && (attached.head !== data.snapshot.head || attached.base !== data.snapshot.base)) return;
  $("saved").textContent = kind === "change" ? "Saving change request…" : "Asking agent…";
  if (await act({ action: "note", item, kind, text: $("message").value, ...(attached ? {reference:{key:attached.key,start:attached.start,end:attached.end}} : {}) })) {
    $("notes").lastElementChild?.scrollIntoView({ block: "nearest" });
    drafts.delete(`${item}:${kind}`);
    attachments.delete(`${item}:${kind}`);
    renderAttachment();
    $("message").value = "";
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
  if(answer?.status==="complete") return `<section class="agent-answer"><strong>${answer.provider === "claude" ? "Claude Code" : answer.provider === "codex" ? "Codex" : "Agent"}</strong><p>${esc(answer.text)}</p>${note.answerOutdated ? '<small>! Answer refers to an earlier review snapshot.</small>' : ""}</section>`;
  if(note.answerOutdated) return '<p class="warn">This question refers to an earlier review. Ask again against the current code.</p>';
  if(answer?.status==="pending" && answer.expiresAt>Date.now()) return '<p role="status">Agent · Answering…</p>';
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
setInterval(async()=>{
  if(pollingQuestions || busy || !data || !data.notes.some(n=>n.answer?.status==="pending")) return;
  if(data.notes.every(n=>n.answer?.status!=="pending" || n.answer.expiresAt<=Date.now())) {
    data.notes=data.notes.map(n=>n.answer?.status==="pending"?{...n,answer:{...n.answer,status:"failed",error:"Agent was interrupted or timed out. Retry the question."}}:n);
    renderNotes({ follow: true });return;
  }
  pollingQuestions=true;
  const generation = reviewGeneration;
  try {const response=await api("/api/questions");if(data && generation === reviewGeneration){data.notes=response.notes;renderNotes({ follow: true });}}
  catch { if (generation === reviewGeneration) $("saved").textContent="Could not refresh agent answers. Use Refresh to reconnect."; }
  finally {pollingQuestions=false;}
},2000);
$("settings").onclick=async()=>{
  showDialog('<h2>Settings</h2><p>Loading…</p>');
  try {
    const settings=await api("/api/settings");
    $("dialog-body").innerHTML=`<h2>Settings</h2><label for="question-provider">Question agent</label><select id="question-provider"><option value="">Not configured</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select><p>Ask sends the question, selected code, plan item, and conversation to this provider using your local CLI login. Answers cannot edit source files. This choice is saved for this review database.</p><button id="save-settings">Save settings</button><p id="settings-status" role="status"></p>`;
    $("question-provider").value=settings.questionProvider||"";
    $("save-settings").onclick=async()=>{try{await api("/api/settings",{questionProvider:$("question-provider").value||null});$("settings-status").textContent="Settings saved.";}catch(error){$("settings-status").textContent=error.message;}};
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

await refresh();
