const collectorDialogs = new Map();

function closeCollectorDialogs() {
  for (const cancel of [...collectorDialogs.values()]) cancel();
}

// The owner is a Zotero chrome window. Its document can default to the XUL
// namespace, so explicitly create HTML form controls and a native HTML dialog.
function openCollectorDialog(win, title, cancelled, build) {
  if (!win || win.closed || collectorDialogs.has(win)) return Promise.resolve(cancelled);
  return new Promise((resolve, reject) => {
    const doc = win.document;
    function element(tag, text) {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    const dialog = element("dialog");
    dialog.id = "citation-collector-dialog";
    dialog.setAttribute("aria-labelledby", "citation-collector-dialog-title");
    const heading = element("h2", title);
    heading.id = "citation-collector-dialog-title";
    const style = element("style", `
      #citation-collector-dialog {
        box-sizing: border-box; width: min(32rem, 92vw); max-height: 88vh; overflow: auto;
        padding: 1.1rem 1.25rem; margin: auto; border: 1px solid GrayText; border-radius: .6rem;
        color: CanvasText; background: Canvas; font: menu; box-shadow: 0 6px 30px #0003;
      }
      #citation-collector-dialog::backdrop { background: rgba(0, 0, 0, .25); }
      #citation-collector-dialog [hidden] { display: none !important; }
      #citation-collector-dialog h2 { margin: 0 0 1rem; font-size: 1.15em; font-weight: 600; }
      #citation-collector-dialog .collector-field { display: grid; gap: .3rem; margin-bottom: .75rem; }
      #citation-collector-dialog select, #citation-collector-dialog input[type=text] {
        box-sizing: border-box; width: 100%; min-height: 2rem; font: inherit; padding: .2rem .4rem;
      }
      #citation-collector-dialog button { font: inherit; padding: .25rem .75rem; min-height: 1.9rem; }
      #citation-collector-dialog .collector-actions { display: flex; justify-content: end; gap: .5rem; margin-top: 1rem; }
      #citation-collector-dialog p { white-space: pre-line; overflow-wrap: anywhere; margin: .5rem 0; }
      #citation-collector-dialog .collector-options { max-height: 36vh; overflow-y: auto; }
      #citation-collector-dialog .collector-option { display: flex; align-items: start; gap: .45rem; padding: .4rem .2rem; overflow-wrap: anywhere; }
      #citation-collector-dialog .collector-option input { flex: none; margin-top: .1rem; }
      #citation-collector-dialog .collector-paper-title { font-weight: 600; margin-block: 0 1rem; }
      #citation-collector-dialog textarea {
        box-sizing: border-box; width: 100%; min-height: 5.5rem; resize: vertical;
        font: inherit; padding: .35rem .45rem;
      }
      #citation-collector-dialog .collector-rating { margin: 0; padding: 0; border: 0; }
      #citation-collector-dialog .collector-rating legend { margin-bottom: .25rem; padding: 0; }
      #citation-collector-dialog .collector-rating-options { display: flex; flex-wrap: wrap; gap: .25rem .6rem; }
      #citation-collector-dialog .collector-rating-options label { display: inline-flex; align-items: center; gap: .15rem; cursor: pointer; }
    `);
    const form = element("form");
    const body = element("div");
    const footer = element("div");
    footer.className = "collector-actions";
    const cancel = element("button", "取消");
    cancel.type = "button";
    const submit = element("button", "确定");
    submit.type = "submit";
    footer.append(cancel, submit);
    form.append(body, footer);
    dialog.append(style, heading, form);

    let settled = false;
    let openTimer = null;
    function cleanup() {
      if (settled) return false;
      settled = true;
      if (openTimer !== null) win.clearTimeout(openTimer);
      collectorDialogs.delete(win);
      win.removeEventListener("unload", dismiss);
      // The owner might already be tearing down its document.
      try { if (dialog.open) dialog.close(); } catch (_) {}
      dialog.remove();
      return true;
    }
    function finish(value) {
      if (cleanup()) resolve(value);
    }
    function dismiss() { finish(cancelled); }
    collectorDialogs.set(win, dismiss);
    win.addEventListener("unload", dismiss);
    cancel.addEventListener("click", dismiss);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      dismiss();
    });
    dialog.addEventListener("close", dismiss);
    try {
      const { initialFocus, accept } = build({ element, body, submit, finish });
      form.addEventListener("submit", event => {
        event.preventDefault();
        accept();
      });
      // The command can originate from an open reader context menu. Let its
      // dismissal finish before taking focus in the Zotero window.
      openTimer = win.setTimeout(() => {
        openTimer = null;
        if (settled) return;
        if (win.closed) return dismiss();
        try {
          doc.documentElement.append(dialog);
          dialog.showModal();
          initialFocus.focus();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }, 0);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function chooseDestination(win, annotate = false) {
  const rows = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true)
    .filter(collection => !collection.deleted)
    .map(collection => ({ key: collection.key, path: collectionPath(collection) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const previous = lastDestination();
  return openCollectorDialog(win, "收藏到分类", null, ({ element, body, submit, finish }) => {
    function addField(parent, label, control) {
      const field = element("label");
      field.className = "collector-field";
      field.append(element("span", label), control);
      parent.append(field);
    }
    function collectionList(includeRoot) {
      const select = element("select");
      function addOption(value, name) {
        const option = element("option", name);
        option.value = value;
        select.append(option);
      }
      if (includeRoot) addOption("", "我的文库");
      for (const row of rows) addOption(row.key, row.path);
      return select;
    }

    const existing = element("div");
    const destination = collectionList(false);
    if (previous && rows.some(row => row.key === previous.key)) destination.value = previous.key;
    addField(existing, "目标分类", destination);
    const newButton = element("button", "新建分类…");
    newButton.type = "button";
    existing.append(newButton);

    const create = element("div");
    const parent = collectionList(true);
    const name = element("input");
    name.type = "text";
    name.autocomplete = "off";
    addField(create, "上级分类", parent);
    addField(create, "分类名称", name);
    const error = element("p");
    error.setAttribute("role", "alert");
    error.id = "citation-collector-name-error";
    error.hidden = true;
    name.setAttribute("aria-describedby", error.id);
    name.addEventListener("input", () => {
      error.hidden = true;
      name.removeAttribute("aria-invalid");
    });
    const back = element("button", "返回已有分类");
    back.type = "button";
    back.hidden = !rows.length;
    create.append(error, back);
    const reviewLabel = element("label");
    reviewLabel.className = "collector-option";
    const review = element("input");
    review.type = "checkbox";
    review.checked = annotate;
    reviewLabel.append(review, element("span", "收藏前填写阅读说明或评分"));
    body.append(existing, create, reviewLabel);

    function select(plan) {
      if (review.checked) plan.annotate = true;
      finish(plan);
    }

    function setMode(creating) {
      existing.hidden = creating;
      create.hidden = !creating;
      submit.textContent = creating ? "新建并收藏" : "收藏到此分类";
    }
    newButton.addEventListener("click", () => {
      parent.value = destination.value;
      setMode(true);
      name.focus();
    });
    back.addEventListener("click", () => {
      setMode(false);
      destination.focus();
    });
    setMode(!rows.length);
    return {
      initialFocus: rows.length ? destination : name,
      accept() {
        if (create.hidden) {
          if (destination.value) select({ key: destination.value });
          return;
        }
        const trimmed = name.value.trim();
        if (!trimmed) {
          error.textContent = "请输入分类名称。";
          error.hidden = false;
          name.setAttribute("aria-invalid", "true");
          name.focus();
          return;
        }
        select({ parentKey: parent.value || null, name: trimmed });
      }
    };
  });
}

function editCitationReview(win, { title, initial = {} }) {
  return openCollectorDialog(win, "标注并收藏", null, ({ element, body, submit, finish }) => {
    const paper = element("p", title);
    paper.className = "collector-paper-title";
    const noteLabel = element("label");
    noteLabel.className = "collector-field";
    const note = element("textarea");
    note.rows = 4;
    note.value = initial.note ?? "";
    // HTML text controls normalize line endings. Compare the displayed value
    // so submitting an unchanged note never rewrites what Zotero stored.
    const initialNote = note.value;
    noteLabel.append(element("span", "阅读说明"), note);

    const group = element("fieldset");
    group.className = "collector-rating";
    group.append(element("legend", "重要性"));
    const options = element("div");
    options.className = "collector-rating-options";
    const initialRating = initial.rating ?? 0;
    const ratings = [];
    for (let rating = 0; rating <= 5; rating++) {
      const label = element("label");
      const radio = element("input");
      radio.type = "radio";
      radio.name = "citation-collector-review-rating";
      radio.value = String(rating);
      radio.checked = rating === initialRating;
      const accessibleLabel = rating ? rating + " 星" : "未评分";
      radio.setAttribute("aria-label", accessibleLabel);
      label.title = accessibleLabel;
      label.append(radio, element("span", rating ? "★".repeat(rating) : "未评分"));
      options.append(label);
      ratings.push(radio);
    }
    group.append(options);
    body.append(paper, noteLabel, group);
    submit.textContent = "保存并收藏";
    return {
      initialFocus: note,
      accept() {
        const patch = {};
        if (note.value !== initialNote) patch.note = note.value;
        const selected = ratings.find(radio => radio.checked);
        if (selected && Number(selected.value) !== initialRating) patch.rating = Number(selected.value);
        finish(patch);
      },
    };
  });
}

async function chooseCandidateIndex(win, message, labels) {
  if (!labels.length) return -1;
  return openCollectorDialog(win, "核对要收藏的论文", -1, ({ element, body, submit, finish }) => {
    body.append(element("p", message));
    const list = element("div");
    list.className = "collector-options";
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "候选论文");
    const radios = labels.map((label, index) => {
      const row = element("label");
      row.className = "collector-option";
      const radio = element("input");
      radio.type = "radio";
      radio.name = "citation-collector-candidate";
      radio.checked = index === 0;
      row.append(radio, element("span", label));
      list.append(row);
      return radio;
    });
    body.append(list);
    submit.textContent = "收藏这篇";
    return {
      initialFocus: radios[0],
      accept() { finish(radios.findIndex(radio => radio.checked)); }
    };
  });
}
