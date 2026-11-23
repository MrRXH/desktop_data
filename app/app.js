/* 毕业设计文献检索与分类助手 - V4 核心逻辑（完整 PDF 论文导入 + 原文打开 + 固定目录手机版导出 + 查重 + 正文夹注） */
(function () {
  "use strict";

  const STORAGE_KEY = "thesis_lit_app_v1_library";

  const DEFAULT_LIBRARY = {
    version: "1.0",
    updated_at: new Date().toISOString().slice(0, 19),
    categories: [
      { id: "cat_bg", name: "研究背景与问题" },
      { id: "cat_review", name: "文献综述" },
      { id: "cat_theory", name: "理论基础与模型" },
      { id: "cat_empirical", name: "实证与案例分析" },
      { id: "cat_policy", name: "政策与对策建议" }
    ],
    tags: ["核心文献", "精读", "待读", "方法参考", "支持论点", "反方观点"],
    ai_config: {
      enabled: false,
      provider: "gemini",
      base_url: "",
      model: "gemini-2.5-flash",
      api_key: ""
    },
    papers: []
  };

  const state = {
    library: null,
    serverMode: false,
    dirHandle: null,
    filterType: "all",
    filterCategoryId: "",
    filterStatus: "",
    filterTag: "",
    searchQuery: "",
    sortBy: "updated_desc",
    selectedPaperId: null,
    checkedIds: new Set(),
    editingPaperId: null,
    batchCiteMode: "gbt",
    wsViewMode: "preview",
    currentWsRaw: ""
  };

  const $ = (id) => document.getElementById(id);

  function nowIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
  }

  function detectLanguage(text) {
    return /[\u4e00-\u9fff]/.test(text || "") ? "zh" : "en";
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeTitle(title) {
    return String(title || "")
      .toLowerCase()
      .replace(/[\s\-—–_·:：,，.。;；!！?？()（）【】\[\]《》“”"'‘’]+/g, "");
  }

  function findDuplicatePaper(title, excludeId = null) {
    const norm = normalizeTitle(title);
    if (!norm) return null;
    return state.library.papers.find((p) => p.id !== excludeId && normalizeTitle(p.title) === norm) || null;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ==================== V4 新增：PDF 原文归档与一键打开 ==================== */
  async function uploadPdfToLibrary(file) {
    if (state.serverMode) {
      const b64 = await fileToDataUrl(file);
      const res = await fetch("/api/upload-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, base64: b64 })
      });
      if (!res.ok) throw new Error("上传 PDF 失败");
      return await res.json();
    }
    if (state.dirHandle) {
      const dataDir = await state.dirHandle.getDirectoryHandle("data", { create: true });
      const pdfDir = await dataDir.getDirectoryHandle("pdfs", { create: true });
      const safeName = file.name.replace(/[\\/:*?"<>|]+/g, "_");
      const fh = await pdfDir.getFileHandle(safeName, { create: true });
      const writable = await fh.createWritable();
      await writable.write(file);
      await writable.close();
      return { ok: true, pdf_file: `data/pdfs/${safeName}`, filename: safeName };
    }
    throw new Error("请使用桌面软件（或先连接本地文件夹）后再导入完整 PDF 论文");
  }

  async function openAttachedPdf(pdfFile) {
    if (!pdfFile) return;
    if (state.serverMode) {
      try {
        const res = await fetch("/api/open-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdf_file: pdfFile })
        });
        if (res.ok) {
          showToast("已用系统默认阅读器打开 PDF 原文");
          return;
        }
        const err = await res.json();
        showToast(err.error || "打开 PDF 失败");
      } catch (_) {
        showToast("打开 PDF 失败，请检查文件是否存在");
      }
      return;
    }
    showToast(`PDF 原文保存在桌面文件夹：${pdfFile}`);
  }

  /* ==================== Markdown 排版渲染 ==================== */
  function formatInlineMd(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }

  function renderMarkdown(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (!trimmed) { i++; continue; }

      const hMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
      if (hMatch) {
        html.push(`<h${hMatch[1].length}>${formatInlineMd(hMatch[2])}</h${hMatch[1].length}>`);
        i++;
        continue;
      }

      if (trimmed.startsWith(">")) {
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(formatInlineMd(lines[i].trim().replace(/^>\s?/, "")));
          i++;
        }
        html.push(`<blockquote>${quoteLines.join("<br/>")}</blockquote>`);
        continue;
      }

      if (
        trimmed.includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?\s*[:\-]+\s*(\|\s*[:\-]+\s*)+\|?\s*$/.test(lines[i + 1].trim())
      ) {
        const splitRow = (row) =>
          row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => formatInlineMd(c.trim()));
        const headers = splitRow(trimmed);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let tableHtml = '<div class="table-scroll"><table><thead><tr>';
        headers.forEach((h) => (tableHtml += `<th>${h}</th>`));
        tableHtml += "</tr></thead><tbody>";
        rows.forEach((r) => {
          tableHtml += "<tr>";
          for (let c = 0; c < headers.length; c++) tableHtml += `<td>${r[c] || ""}</td>`;
          tableHtml += "</tr>";
        });
        tableHtml += "</tbody></table></div>";
        html.push(tableHtml);
        continue;
      }

      if (/^[-*+]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          items.push(`<li>${formatInlineMd(lines[i].trim().replace(/^[-*+]\s+/, ""))}</li>`);
          i++;
        }
        html.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          items.push(`<li>${formatInlineMd(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>`);
          i++;
        }
        html.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.test(lines[i].trim())) {
        para.push(formatInlineMd(lines[i].trim()));
        i++;
      }
      html.push(`<p>${para.join("<br/>")}</p>`);
    }

    return html.join("\n") || '<p class="muted">（空白文档）</p>';
  }

  /* ==================== 本地存储与同步 ==================== */
  function loadLocalCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.papers)) return parsed;
      }
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_LIBRARY));
  }

  function saveLocalCache() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.library)); } catch (_) {}
  }

  function buildNoteMarkdown(paper) {
    const cat = state.library.categories.find((c) => c.id === paper.category_id);
    const catName = cat ? cat.name : "未分类";
    const authors = (paper.authors || []).join(paper.language === "zh" ? "、" : ", ") || "未知";
    const tags = (paper.tags || []).join(", ") || "无";
    const n = paper.notes || {};
    return `# ${paper.title || "未命名文献"}

- **ID**：\`${paper.id}\`
- **作者**：${authors}
- **期刊/来源**：${paper.journal || "未知"} (${paper.year || "未知"})
- **卷/期/页码**：卷 ${paper.volume || "-"} / 期 ${paper.issue || "-"} / 页码 ${paper.pages || "-"}
- **文献类型**：${paper.doc_type || "J"} ｜ **语言**：${paper.language || "zh"} ｜ **来源库**：${paper.source || "手动录入"}
- **分类**：${catName}
- **标签**：${tags}
- **阅读状态**：${paper.status || "待读"}
- **PDF 原文**：\`${paper.pdf_file || "未绑定"}\`

## 摘要
${paper.abstract || "（暂无摘要）"}

## 核心观点
${n.core_viewpoint || "（待补充）"}

## 研究方法
${n.methodology || "（待补充）"}

## 主要局限
${n.limitations || "（待补充）"}

## 个人启发与引用位置
${n.personal_notes || "（待补充）"}
`;
  }

  async function writeFileText(dirHandle, filename, text) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async function persistLibrary(singleUpdatedPaper = null) {
    state.library.updated_at = nowIso();
    saveLocalCache();

    if (state.serverMode) {
      try {
        const res = await fetch("/api/library", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.library)
        });
        if (!res.ok) throw new Error("保存接口返回异常");
      } catch (_) {
        showToast("同步到本机服务失败，请重新打开软件");
      }
      return;
    }

    if (!state.dirHandle) return;
    try {
      const dataDir = await state.dirHandle.getDirectoryHandle("data", { create: true });
      await writeFileText(dataDir, "library.json", JSON.stringify(state.library, null, 2));
      const notesDir = await dataDir.getDirectoryHandle("notes", { create: true });
      if (singleUpdatedPaper) {
        const safeId = String(singleUpdatedPaper.id).replace(/[^a-zA-Z0-9_\-]/g, "_");
        await writeFileText(notesDir, `${safeId}.md`, buildNoteMarkdown(singleUpdatedPaper));
      } else {
        for (const p of state.library.papers) {
          const safeId = String(p.id).replace(/[^a-zA-Z0-9_\-]/g, "_");
          await writeFileText(notesDir, `${safeId}.md`, buildNoteMarkdown(p));
        }
      }
    } catch (_) {
      showToast("写入本地文件夹失败，请重新点击「连接文件夹」授权");
    }
  }

  async function readLibraryFromDisk() {
    if (state.serverMode) {
      try {
        const res = await fetch("/api/library", { cache: "no-store" });
        if (!res.ok) return false;
        const parsed = await res.json();
        if (parsed && Array.isArray(parsed.papers)) {
          state.library = parsed;
          state.library.categories = state.library.categories || [];
          state.library.tags = state.library.tags || [];
          state.library.ai_config = state.library.ai_config || DEFAULT_LIBRARY.ai_config;
          saveLocalCache();
          return true;
        }
      } catch (_) {
        showToast("无法连接本机服务");
      }
      return false;
    }

    if (!state.dirHandle) {
      showToast("请先连接本地文件夹");
      return false;
    }
    try {
      const dataDir = await state.dirHandle.getDirectoryHandle("data", { create: true });
      try {
        const libHandle = await dataDir.getFileHandle("library.json");
        const file = await libHandle.getFile();
        const parsed = JSON.parse(await file.text());
        if (parsed && Array.isArray(parsed.papers)) {
          state.library = parsed;
          state.library.categories = state.library.categories || [];
          state.library.tags = state.library.tags || [];
          state.library.ai_config = state.library.ai_config || DEFAULT_LIBRARY.ai_config;
          saveLocalCache();
          return true;
        }
      } catch (_) {
        await persistLibrary();
        return true;
      }
    } catch (err) {
      showToast("读取文件夹失败：" + err.message);
    }
    return false;
  }

  async function connectLocalFolder() {
    if (state.serverMode) {
      showToast("当前已通过本机服务自动同步桌面文件夹，无需手动连接");
      return;
    }
    if (!window.showDirectoryPicker) {
      showToast("当前浏览器不支持直接连接文件夹");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      state.dirHandle = handle;
      const ok = await readLibraryFromDisk();
      if (ok) {
        const statusEl = $("syncStatusText");
        statusEl.textContent = `已直连本地文件夹「${handle.name}」· 实时同步中`;
        statusEl.classList.add("connected");
        $("btnConnectFolder").textContent = "已连接文件夹";
        renderAll();
        showToast(`已成功连接「${handle.name}」`);
      }
    } catch (err) {
      if (err.name !== "AbortError") showToast("连接文件夹未完成");
    }
  }

  /* ==================== 引文生成与解析 ==================== */
  function extractEnSurname(name) {
    const s = String(name || "").trim();
    if (!s) return "";
    if (s.includes(",")) return s.split(",")[0].trim();
    const parts = s.split(/\s+/);
    return parts[parts.length - 1];
  }

  function formatInlineCitation(p) {
    const isZh = p.language === "zh";
    const authors = p.authors || [];
    const year = p.year || (isZh ? "无年份" : "n.d.");
    if (isZh) {
      if (authors.length === 0) return `(佚名, ${year})`;
      if (authors.length === 1) return `(${authors[0]}, ${year})`;
      if (authors.length === 2) return `(${authors[0]}、${authors[1]}, ${year})`;
      return `(${authors[0]}等, ${year})`;
    }
    const surnames = authors.map(extractEnSurname).filter(Boolean);
    if (surnames.length === 0) return `(Anonymous, ${year})`;
    if (surnames.length === 1) return `(${surnames[0]}, ${year})`;
    if (surnames.length === 2) return `(${surnames[0]} & ${surnames[1]}, ${year})`;
    return `(${surnames[0]} et al., ${year})`;
  }

  function formatGbt7714(p) {
    const isZh = p.language === "zh";
    const authors = p.authors || [];
    let authorStr = "";
    if (authors.length === 0) authorStr = isZh ? "佚名" : "Anonymous";
    else if (authors.length <= 3) authorStr = authors.join(", ");
    else authorStr = authors.slice(0, 3).join(", ") + (isZh ? ", 等" : ", et al");

    const docType = p.doc_type || "J";
    let tail = "";
    if (p.journal) tail += p.journal;
    if (p.year) tail += (tail ? ", " : "") + p.year;
    if (p.volume) {
      tail += `, ${p.volume}`;
      if (p.issue) tail += `(${p.issue})`;
    } else if (p.issue) tail += `(${p.issue})`;
    if (p.pages) tail += `: ${p.pages}`;
    return `${authorStr}. ${p.title}[${docType}]. ${tail ? tail + "." : ""}`;
  }

  function formatApa(p) {
    const isZh = p.language === "zh";
    const authors = p.authors || [];
    let authorStr = "";
    if (authors.length === 0) authorStr = isZh ? "佚名" : "Anonymous";
    else if (authors.length === 1) authorStr = authors[0];
    else if (authors.length === 2) authorStr = isZh ? `${authors[0]}、${authors[1]}` : `${authors[0]}, & ${authors[1]}`;
    else if (authors.length <= 20)
      authorStr = isZh ? authors.join("、") : `${authors.slice(0, -1).join(", ")}, & ${authors[authors.length - 1]}`;
    else authorStr = `${authors.slice(0, 19).join(", ")}, ... ${authors[authors.length - 1]}`;

    const yearStr = p.year ? `(${p.year})` : "(n.d.)";
    let volIssue = "";
    if (p.volume) {
      volIssue = `, ${p.volume}`;
      if (p.issue) volIssue += `(${p.issue})`;
    } else if (p.issue) volIssue = `, (${p.issue})`;
    const pagesStr = p.pages ? `, ${p.pages}` : "";
    const doiStr = p.doi ? ` https://doi.org/${p.doi.replace(/^https?:\/\/doi\.org\//i, "")}` : "";
    return `${authorStr} ${yearStr}. ${p.title}. ${p.journal || ""}${volIssue}${pagesStr}.${doiStr}`.replace(/\s+\./g, ".");
  }

  function parseBibtex(raw) {
    const entries = [];
    const blocks = raw.trim().split(/(?=@\w+\s*\{)/);
    const typeMap = { article: "J", phdthesis: "D", mastersthesis: "D", book: "M", inproceedings: "C", conference: "C", techreport: "R" };
    for (const b of blocks) {
      const block = b.trim();
      if (!block.startsWith("@")) continue;
      const head = block.match(/^@(\w+)\s*\{([^,]*),([\s\S]*)\}\s*$/);
      if (!head) continue;
      const entryType = head[1].toLowerCase();
      const body = head[3];
      const fields = {};
      const re = /(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        fields[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\s+/g, " ").trim();
      }
      const title = (fields.title || "").replace(/^\{+|\}+$/g, "").trim();
      if (!title) continue;
      const authors = (fields.author || "").split(/\s+and\s+|[;；]/).map((s) => s.trim()).filter(Boolean);
      const journal = fields.journal || fields.booktitle || fields.school || fields.publisher || "";
      const lang = detectLanguage(title + " " + journal);
      entries.push({
        title, authors, journal,
        year: fields.year || "", volume: fields.volume || "", issue: fields.number || "",
        pages: (fields.pages || "").replace("--", "-"),
        doc_type: typeMap[entryType] || "J", language: lang,
        source: lang === "zh" ? "知网 CNKI" : "Google Scholar",
        doi: fields.doi || "", url: fields.url || "", abstract: fields.abstract || ""
      });
    }
    return entries;
  }

  function parseRefworksOrRis(raw) {
    const lines = raw.split(/\r?\n/);
    const results = [];
    let cur = {};
    const flush = () => {
      if (!cur.title) return;
      const lang = detectLanguage(cur.title + " " + (cur.journal || ""));
      const rt = (cur.rt || "").toLowerCase();
      let docType = "J";
      if (rt.includes("dissertation") || rt.includes("thesis") || rt.includes("学位")) docType = "D";
      else if (rt.includes("book") || rt.includes("专著")) docType = "M";
      else if (rt.includes("conf") || rt.includes("会议")) docType = "C";
      results.push({
        title: cur.title, authors: cur.authors || [], journal: cur.journal || "",
        year: cur.year || "", volume: cur.volume || "", issue: cur.issue || "", pages: cur.pages || "",
        doc_type: docType, language: lang,
        source: lang === "zh" ? "知网 CNKI" : "学术引文导入",
        doi: cur.doi || "", url: cur.url || "", abstract: cur.abstract || ""
      });
    };

    for (const line of lines) {
      const s = line.trim();
      if (!s) { if (cur.title) { flush(); cur = {}; } continue; }
      const m = s.match(/^([A-Z0-9]{2})\s*(?:-\s*|\s+)(.*)$/);
      if (!m) continue;
      const tag = m[1], val = m[2].trim();
      if (tag === "RT" || tag === "TY") { if (cur.title) { flush(); cur = {}; } cur.rt = val; }
      else if (tag === "ER") { flush(); cur = {}; }
      else if (tag === "T1" || tag === "TI") cur.title = val;
      else if (tag === "A1" || tag === "AU") {
        cur.authors = cur.authors || [];
        val.split(/[;；,，]/).map((a) => a.trim()).filter(Boolean).forEach((a) => cur.authors.push(a));
      } else if (tag === "JF" || tag === "JO" || tag === "T2" || tag === "PB") { if (!cur.journal) cur.journal = val; }
      else if (tag === "YR" || tag === "PY") { const ym = val.match(/\d{4}/); cur.year = ym ? ym[0] : val; }
      else if (tag === "VO" || tag === "VL") cur.volume = val;
      else if (tag === "IS") cur.issue = val;
      else if (tag === "OP" || tag === "SP") cur.pages = val;
      else if (tag === "EP" && cur.pages) cur.pages = `${cur.pages}-${val}`;
      else if (tag === "AB") cur.abstract = val;
      else if (tag === "DO") cur.doi = val;
      else if (tag === "UR" || tag === "LK") cur.url = val;
    }
    if (cur.title) flush();
    return results;
  }

  function parseGbtLines(raw) {
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim().replace(/^\[\d+\]\s*/, "");
      if (!s || !/\[[JDMCR]\]/.test(s)) continue;
      const m = s.match(/^([^.．]+)[.．]\s*([^[]+)\[([JDMCR])\][.．]\s*(.*)$/);
      if (!m) continue;
      const authors = m[1].split(/[,，、;；]/).map((a) => a.trim()).filter(Boolean);
      const title = m[2].trim(), docType = m[3].trim(), rest = m[4].trim();
      const ym = rest.match(/(19|20)\d{2}/);
      const journal = rest.split(/[,，]/)[0].trim();
      const vi = rest.match(/,\s*(\d+)\((\d+)\)/);
      const pm = rest.match(/[:：]\s*([\d\-–]+)/);
      const lang = detectLanguage(title + " " + journal);
      entries.push({
        title, authors, journal,
        year: ym ? ym[0] : "", volume: vi ? vi[1] : "", issue: vi ? vi[2] : "",
        pages: pm ? pm[1].replace("–", "-") : "",
        doc_type: docType, language: lang,
        source: lang === "zh" ? "知网 CNKI" : "引文导入",
        doi: "", url: "", abstract: ""
      });
    }
    return entries;
  }

  function parseCitations(raw) {
    const txt = (raw || "").trim();
    if (!txt) return [];
    if (txt.includes("@") && txt.includes("{")) {
      const bib = parseBibtex(txt);
      if (bib.length) return bib;
    }
    const ref = parseRefworksOrRis(txt);
    if (ref.length) return ref;
    return parseGbtLines(txt);
  }

  /* ==================== 手机离线随身版导出 ==================== */
  async function collectWorkspaceDocs() {
    const docs = [];
    if (state.serverMode) {
      try {
        const res = await fetch("/api/workspace", { cache: "no-store" });
        const data = await res.json();
        for (const item of data.files || []) {
          const r = await fetch(`/api/workspace/${encodeURIComponent(item.name)}`, { cache: "no-store" });
          const d = await r.json();
          docs.push({ name: item.name, html: renderMarkdown(d.content || "") });
        }
      } catch (_) {}
    } else if (state.dirHandle) {
      try {
        const wsDir = await state.dirHandle.getDirectoryHandle("writing_workspace", { create: true });
        for await (const [name, handle] of wsDir.entries()) {
          if (handle.kind === "file" && name.endsWith(".md")) {
            const f = await handle.getFile();
            docs.push({ name, html: renderMarkdown(await f.text()) });
          }
        }
      } catch (_) {}
    }
    return docs;
  }

  async function exportMobileOfflineHtml() {
    showToast("正在打包手机离线随身版...");
    const catMap = Object.fromEntries(state.library.categories.map((c) => [c.id, c.name]));
    const workspaceDocs = await collectWorkspaceDocs();

    const payload = {
      exportedAt: nowIso().replace("T", " "),
      categories: state.library.categories,
      papers: state.library.papers.map((p) => ({
        id: p.id,
        title: p.title,
        authors: (p.authors || []).join(p.language === "zh" ? "、" : ", ") || "未知作者",
        journal: p.journal || "",
        year: p.year || "",
        status: p.status || "待读",
        starred: Boolean(p.starred),
        category_id: p.category_id || "",
        category_name: catMap[p.category_id] || "未分类",
        tags: p.tags || [],
        abstract: p.abstract || "",
        inlineCite: formatInlineCitation(p),
        gbt: formatGbt7714(p),
        notes: p.notes || {}
      })),
      workspaceDocs
    };

    const safeJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
    const dateStr = nowIso().slice(0, 10);
    const filename = `文献随身版_${dateStr}.html`;

    const mobileHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
<title>文献随身版 (${dateStr})</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f9;color:#0f172a;font-size:15px;line-height:1.6;padding-bottom:36px;}
.hdr{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #e2e8f0;padding:12px 14px 10px;}
.hdr-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;}
.hdr h1{font-size:17px;font-weight:700;}
.hdr-meta{font-size:11px;color:#64748b;}
.tabs{display:flex;gap:8px;margin-bottom:8px;}
.tab{flex:1;border:1px solid #e2e8f0;background:#f8fafc;color:#475569;padding:7px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;}
.tab.active{background:#2563eb;border-color:#2563eb;color:#fff;}
.search{width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:14px;background:#f8fafc;}
.cats{display:flex;gap:6px;overflow-x:auto;padding:10px 14px 2px;-webkit-overflow-scrolling:touch;}
.cats::-webkit-scrollbar{display:none;}
.pill{flex-shrink:0;border:1px solid #e2e8f0;background:#fff;color:#475569;padding:5px 12px;border-radius:999px;font-size:12.5px;cursor:pointer;}
.pill.active{background:#eff6ff;border-color:#2563eb;color:#2563eb;font-weight:600;}
.wrap{padding:10px 14px;display:flex;flex-direction:column;gap:10px;}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:13px 14px;box-shadow:0 1px 2px rgba(15,23,42,.04);}
.card-title{font-size:15.5px;font-weight:600;line-height:1.45;}
.card-sub{font-size:12.5px;color:#64748b;margin-top:4px;}
.badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;}
.b{font-size:11px;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#475569;}
.b-cat{background:#eff6ff;color:#1d4ed8;}
.b-st{background:#dcfce7;color:#166534;}
.detail{margin-top:11px;padding-top:11px;border-top:1px dashed #e2e8f0;display:none;flex-direction:column;gap:8px;font-size:13.5px;}
.card.open .detail{display:flex;}
.blk{background:#f8fafc;padding:9px 10px;border-radius:8px;}
.blk-lbl{font-size:12px;font-weight:600;color:#2563eb;margin-bottom:2px;}
.cite{font-size:12px;color:#334155;background:#f1f5f9;padding:8px 10px;border-radius:8px;word-break:break-all;}
.md h1{font-size:17px;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:6px;}
.md h2{font-size:15px;margin:14px 0 6px;}
.md h3{font-size:14px;margin:10px 0 4px;}
.md p,.md li{font-size:13.5px;margin:5px 0;}
.md ul,.md ol{margin-left:18px;}
.md blockquote{border-left:3px solid #2563eb;background:#f8fafc;padding:6px 10px;margin:8px 0;color:#475569;}
.table-scroll{overflow-x:auto;margin:8px 0;}
.md table{border-collapse:collapse;min-width:480px;width:100%;font-size:12.5px;}
.md th,.md td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top;}
.md th{background:#f8fafc;}
.hidden{display:none!important;}
.empty{text-align:center;color:#64748b;padding:36px 12px;font-size:14px;}
</style>
</head>
<body>
<div class="hdr">
  <div class="hdr-top">
    <h1>毕业设计文献随身版</h1>
    <span class="hdr-meta" id="metaInfo"></span>
  </div>
  <div class="tabs">
    <button class="tab active" id="tabPapers">文献笔记</button>
    <button class="tab" id="tabDocs">论文产出区</button>
  </div>
  <input class="search" id="q" type="search" placeholder="搜索标题、作者、观点或笔记..." />
</div>
<div class="cats" id="catsBar"></div>
<div class="wrap" id="papersWrap"></div>
<div class="wrap hidden" id="docsWrap"></div>
<script>
const DATA = ${safeJson};
let curCat = "all", query = "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
$("metaInfo").textContent = DATA.papers.length + " 篇 · " + DATA.exportedAt.slice(5,16);

function renderCats(){
  const bar = $("catsBar"); bar.innerHTML = "";
  const items = [{id:"all",name:"全部 ("+DATA.papers.length+")"},{id:"starred",name:"★ 核心收藏"}].concat(
    DATA.categories.map(c => ({id:c.id, name:c.name}))
  );
  items.forEach(c => {
    const b = document.createElement("button");
    b.className = "pill" + (curCat === c.id ? " active" : "");
    b.textContent = c.name;
    b.onclick = () => { curCat = c.id; renderCats(); renderPapers(); };
    bar.appendChild(b);
  });
}

function renderPapers(){
  const wrap = $("papersWrap"); wrap.innerHTML = "";
  const kw = query.trim().toLowerCase();
  const list = DATA.papers.filter(p => {
    if(curCat === "starred" && !p.starred) return false;
    if(curCat !== "all" && curCat !== "starred" && p.category_id !== curCat) return false;
    if(kw){
      const n = p.notes || {};
      const hay = [p.title,p.authors,p.journal,p.year,p.abstract,(p.tags||[]).join(" "),n.core_viewpoint,n.methodology,n.limitations,n.personal_notes].join(" ").toLowerCase();
      if(!hay.includes(kw)) return false;
    }
    return true;
  });
  if(!list.length){ wrap.innerHTML = '<div class="empty">没有匹配的文献</div>'; return; }
  list.forEach(p => {
    const n = p.notes || {};
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`
      <div class="card-title">\${p.starred ? "★ " : ""}\${esc(p.title)}</div>
      <div class="card-sub">\${esc(p.authors)} · \${esc(p.journal)} \${p.year ? "(" + esc(p.year) + ")" : ""}</div>
      <div class="badges">
        <span class="b b-cat">\${esc(p.category_name)}</span>
        <span class="b b-st">\${esc(p.status)}</span>
        \${(p.tags||[]).map(t => '<span class="b">' + esc(t) + '</span>').join("")}
      </div>
      <div class="detail">
        \${n.core_viewpoint ? '<div class="blk"><div class="blk-lbl">核心观点</div><div>' + esc(n.core_viewpoint) + '</div></div>' : ''}
        \${n.methodology ? '<div class="blk"><div class="blk-lbl">研究方法</div><div>' + esc(n.methodology) + '</div></div>' : ''}
        \${n.limitations ? '<div class="blk"><div class="blk-lbl">主要局限</div><div>' + esc(n.limitations) + '</div></div>' : ''}
        \${n.personal_notes ? '<div class="blk"><div class="blk-lbl">个人启发</div><div>' + esc(n.personal_notes) + '</div></div>' : ''}
        \${p.abstract ? '<div class="blk"><div class="blk-lbl">摘要</div><div>' + esc(p.abstract) + '</div></div>' : ''}
        <div class="cite"><strong>正文夹注：</strong>\${esc(p.inlineCite)}<br/><strong>国标：</strong>\${esc(p.gbt)}</div>
      </div>
    \`;
    card.onclick = () => card.classList.toggle("open");
    wrap.appendChild(card);
  });
}

function renderDocs(){
  const wrap = $("docsWrap"); wrap.innerHTML = "";
  if(!DATA.workspaceDocs.length){ wrap.innerHTML = '<div class="empty">暂无论文产出区文档</div>'; return; }
  DATA.workspaceDocs.forEach((d, idx) => {
    const card = document.createElement("div");
    card.className = "card" + (idx === 0 ? " open" : "");
    card.innerHTML = \`<div class="card-title">\${esc(d.name)}</div><div class="detail md">\${d.html}</div>\`;
    card.querySelector(".card-title").onclick = () => card.classList.toggle("open");
    wrap.appendChild(card);
  });
}

$("tabPapers").onclick = () => {
  $("tabPapers").classList.add("active"); $("tabDocs").classList.remove("active");
  $("q").classList.remove("hidden"); $("catsBar").classList.remove("hidden");
  $("papersWrap").classList.remove("hidden"); $("docsWrap").classList.add("hidden");
};
$("tabDocs").onclick = () => {
  $("tabDocs").classList.add("active"); $("tabPapers").classList.remove("active");
  $("q").classList.add("hidden"); $("catsBar").classList.add("hidden");
  $("papersWrap").classList.add("hidden"); $("docsWrap").classList.remove("hidden");
};
$("q").oninput = (e) => { query = e.target.value; renderPapers(); };
renderCats(); renderPapers(); renderDocs();
</script>
</body>
</html>`;

    if (state.serverMode) {
      try {
        const res = await fetch("/api/export-mobile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename, html: mobileHtml })
        });
        if (res.ok) {
          showToast(`已保存到桌面「文献检索软件/mobile_export/${filename}」并已打开文件夹`);
          return;
        }
      } catch (_) {}
    }

    const blob = new Blob([mobileHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出「${filename}」，发到手机浏览器即可离线查看`);
  }

  /* ==================== 筛选与主界面渲染 ==================== */
  function getFilteredPapers() {
    const q = state.searchQuery.trim().toLowerCase();
    const list = state.library.papers.filter((p) => {
      if (state.filterType === "starred" && !p.starred) return false;
      if (state.filterType === "category" && p.category_id !== state.filterCategoryId) return false;
      if (state.filterStatus && p.status !== state.filterStatus) return false;
      if (state.filterTag && !(p.tags || []).includes(state.filterTag)) return false;
      if (q) {
        const n = p.notes || {};
        const hay = [p.title, (p.authors || []).join(" "), p.journal, p.year, p.abstract, (p.tags || []).join(" "), n.core_viewpoint, n.methodology, n.limitations, n.personal_notes].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      if (state.sortBy === "year_desc") return (b.year || "").localeCompare(a.year || "");
      if (state.sortBy === "year_asc") return (a.year || "").localeCompare(b.year || "");
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
    return list;
  }

  function renderSidebar() {
    const papers = state.library.papers;
    $("countAll").textContent = papers.length;
    $("countStarred").textContent = papers.filter((p) => p.starred).length;

    document.querySelectorAll("#smartFilterList .nav-item").forEach((el) => {
      el.classList.toggle("active", state.filterType === el.dataset.filter);
    });

    const catList = $("categoryList");
    catList.innerHTML = "";
    state.library.categories.forEach((cat) => {
      const count = papers.filter((p) => p.category_id === cat.id).length;
      const li = document.createElement("li");
      li.className = "nav-item" + (state.filterType === "category" && state.filterCategoryId === cat.id ? " active" : "");
      li.innerHTML = `<span>${escapeHtml(cat.name)}</span><span class="nav-item-right"><button class="cat-del-btn" title="删除分类">×</button><span class="count-pill">${count}</span></span>`;
      li.addEventListener("click", (e) => {
        if (e.target.classList.contains("cat-del-btn")) {
          e.stopPropagation();
          if (!confirm(`确定删除分类「${cat.name}」吗？（文献不会被删除，仅变为未分类）`)) return;
          state.library.categories = state.library.categories.filter((c) => c.id !== cat.id);
          state.library.papers.forEach((p) => { if (p.category_id === cat.id) p.category_id = ""; });
          if (state.filterCategoryId === cat.id) { state.filterType = "all"; state.filterCategoryId = ""; }
          persistLibrary();
          renderAll();
          showToast("已删除分类");
          return;
        }
        state.filterType = "category";
        state.filterCategoryId = cat.id;
        renderAll();
      });
      catList.appendChild(li);
    });

    const allTags = new Set(state.library.tags || []);
    papers.forEach((p) => (p.tags || []).forEach((t) => allTags.add(t)));
    const tagWrap = $("tagFilterWrap");
    tagWrap.innerHTML = "";
    const allChip = document.createElement("button");
    allChip.className = "chip" + (!state.filterTag ? " active" : "");
    allChip.textContent = "全部标签";
    allChip.onclick = () => { state.filterTag = ""; renderAll(); };
    tagWrap.appendChild(allChip);

    allTags.forEach((tag) => {
      const btn = document.createElement("button");
      btn.className = "chip" + (state.filterTag === tag ? " active" : "");
      btn.textContent = tag;
      btn.onclick = () => { state.filterTag = state.filterTag === tag ? "" : tag; renderAll(); };
      tagWrap.appendChild(btn);
    });
  }

  function renderPaperList() {
    const filtered = getFilteredPapers();
    const listTitle =
      state.filterType === "starred" ? "核心收藏"
        : state.filterType === "category" ? (state.library.categories.find((c) => c.id === state.filterCategoryId)?.name || "分类文献")
        : "全部文献";
    $("listTitle").textContent = listTitle;
    $("listCountText").textContent = `${filtered.length} 篇`;
    $("btnBatchCite").disabled = state.checkedIds.size === 0;
    $("btnBatchCite").textContent = state.checkedIds.size > 0 ? `导出引文 (${state.checkedIds.size})` : "批量导出引文";

    const container = $("paperList");
    container.innerHTML = "";
    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state" style="padding:40px 10px;"><p class="muted">当前筛选条件下暂无文献</p></div>`;
      return;
    }

    filtered.forEach((p) => {
      const card = document.createElement("div");
      card.className = "paper-card" + (p.id === state.selectedPaperId ? " active" : "");
      const hasNotes = p.notes && (p.notes.core_viewpoint || p.notes.methodology || p.notes.limitations || p.notes.personal_notes);
      const authors = (p.authors || []).join("、") || "未知作者";
      card.innerHTML = `
        <div class="paper-card-top">
          <input type="checkbox" class="paper-chk" ${state.checkedIds.has(p.id) ? "checked" : ""} />
          <div class="paper-card-title">${p.starred ? "★ " : ""}${escapeHtml(p.title)}</div>
        </div>
        <div class="paper-card-meta">${escapeHtml(authors)} · ${escapeHtml(p.journal || "未知来源")} ${p.year ? `(${escapeHtml(p.year)})` : ""}</div>
        <div class="paper-card-foot">
          <span class="badge badge-status-${escapeHtml(p.status || "待读")}">${escapeHtml(p.status || "待读")}</span>
          ${p.pdf_file ? '<span class="badge badge-pdf">PDF</span>' : ""}
          ${hasNotes ? '<span class="badge badge-note">有笔记</span>' : ""}
          ${(p.tags || []).slice(0, 3).map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("")}
        </div>
      `;
      const chk = card.querySelector(".paper-chk");
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        if (chk.checked) state.checkedIds.add(p.id);
        else state.checkedIds.delete(p.id);
        $("btnBatchCite").disabled = state.checkedIds.size === 0;
        $("btnBatchCite").textContent = state.checkedIds.size > 0 ? `导出引文 (${state.checkedIds.size})` : "批量导出引文";
      });
      card.addEventListener("click", () => {
        state.selectedPaperId = p.id;
        renderPaperList();
        renderDetail();
      });
      container.appendChild(card);
    });
  }

  function renderDetail() {
    const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
    if (!p) {
      $("emptyDetail").classList.remove("hidden");
      $("detailContent").classList.add("hidden");
      return;
    }
    $("emptyDetail").classList.add("hidden");
    $("detailContent").classList.remove("hidden");

    $("detailTitle").textContent = p.title;
    $("btnToggleStar").textContent = p.starred ? "★" : "☆";
    const metaParts = [
      (p.authors || []).join(p.language === "zh" ? "、" : ", ") || "未知作者",
      p.journal || "未知期刊",
      p.year ? `${p.year}年` : "",
      p.volume ? `卷${p.volume}` : "",
      p.issue ? `期${p.issue}` : "",
      p.pages ? `页${p.pages}` : "",
      p.source || ""
    ].filter(Boolean);
    $("detailMetaLine").textContent = metaParts.join("  ｜  ");

    const catSel = $("detailCategorySelect");
    catSel.innerHTML = `<option value="">未分类</option>` + state.library.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    catSel.value = p.category_id || "";

    $("detailStatusSelect").value = p.status || "待读";
    $("detailTagsInput").value = (p.tags || []).join(", ");
    $("previewInline").textContent = formatInlineCitation(p);
    $("previewGbt").textContent = formatGbt7714(p);
    $("previewApa").textContent = formatApa(p);
    $("detailAbstract").textContent = p.abstract || "（暂无摘要，可点击上方「编辑信息」补充）";

    // V4 PDF 原文状态更新
    const pdfStatus = $("pdfStatusText");
    if (p.pdf_file) {
      pdfStatus.textContent = `已归档原文：${p.pdf_file}（AI 新对话可直接读取此 PDF 全文）`;
      pdfStatus.classList.add("attached");
      $("btnOpenPdf").classList.remove("hidden");
      $("btnUnlinkPdf").classList.remove("hidden");
    } else {
      pdfStatus.textContent = "尚未绑定 PDF 原文（上传后自动归档至 data/pdfs/，AI 新对话可直接读全文）";
      pdfStatus.classList.remove("attached");
      $("btnOpenPdf").classList.add("hidden");
      $("btnUnlinkPdf").classList.add("hidden");
    }

    const n = p.notes || {};
    $("noteCore").value = n.core_viewpoint || "";
    $("noteMethod").value = n.methodology || "";
    $("noteLimit").value = n.limitations || "";
    $("notePersonal").value = n.personal_notes || "";
  }

  function renderAll() {
    renderSidebar();
    renderPaperList();
    renderDetail();
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch (_) {
      showToast("复制失败，请手动选中文本复制");
    }
  }

  async function copyRichHtml(htmlContent, plainFallback, okMsg) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        const htmlBlob = new Blob(
          [`<meta charset="utf-8"><style>table{border-collapse:collapse;width:100%;}th,td{border:1px solid #999;padding:6px 8px;text-align:left;}th{background:#f2f2f2;}</style>${htmlContent}`],
          { type: "text/html" }
        );
        const textBlob = new Blob([plainFallback], { type: "text/plain" });
        await navigator.clipboard.write([new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob })]);
        showToast(okMsg);
        return;
      }
    } catch (_) {}
    await copyText(plainFallback, "已复制文本内容（可直接粘贴到 Word）");
  }

  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(id) { $(id).classList.add("hidden"); }

  function fillCategorySelect(selectId, selectedId = "") {
    const sel = $(selectId);
    sel.innerHTML = `<option value="">未分类</option>` + state.library.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    sel.value = selectedId || (state.library.categories[0]?.id || "");
  }

  function openPaperForm(paper = null) {
    state.editingPaperId = paper ? paper.id : null;
    $("paperFormTitle").textContent = paper ? "编辑文献信息" : "手动录入文献";
    $("fTitle").value = paper?.title || "";
    $("fAuthors").value = (paper?.authors || []).join(", ");
    $("fJournal").value = paper?.journal || "";
    $("fYear").value = paper?.year || String(new Date().getFullYear());
    $("fDocType").value = paper?.doc_type || "J";
    $("fVolume").value = paper?.volume || "";
    $("fIssue").value = paper?.issue || "";
    $("fPages").value = paper?.pages || "";
    $("fLanguage").value = paper?.language || "zh";
    $("fSource").value = paper?.source || "知网 CNKI";
    $("fAbstract").value = paper?.abstract || "";
    fillCategorySelect("fCategory", paper?.category_id || (state.filterType === "category" ? state.filterCategoryId : ""));
    openModal("modalPaperForm");
  }

  function openAiPromptsModal() {
    const checkedPapers = state.library.papers.filter((p) => state.checkedIds.has(p.id));
    const filteredPapers = getFilteredPapers();
    const targetPapers = checkedPapers.length > 0 ? checkedPapers : filteredPapers;
    const scopeLabel =
      checkedPapers.length > 0
        ? `当前勾选的 ${checkedPapers.length} 篇文献`
        : state.filterType === "category"
        ? `分类「${state.library.categories.find((c) => c.id === state.filterCategoryId)?.name || ""}」下的 ${filteredPapers.length} 篇文献`
        : `当前视图中的 ${filteredPapers.length} 篇文献`;

    const idList = targetPapers.map((p) => `${p.id}（${p.title}${p.pdf_file ? `，原文：${p.pdf_file}` : ""}）`).join("；");
    const emptyNotePapers = state.library.papers.filter(
      (p) => !p.notes || (!p.notes.core_viewpoint && !p.notes.methodology && !p.notes.limitations)
    );

    $("promptContextSummary").textContent = `当前作用范围：${scopeLabel}（已绑定 PDF 的文献会自动附带原文路径供 AI 深读）`;

    const cards = [
      {
        title: "1. 生成主题文献综述草稿",
        desc: "优先深读已绑定的完整 PDF 原文，按研究脉络串联观点并附国标引文。",
        prompt: `请先阅读当前文件夹中的 AI_GUIDE.md 和 data/library.json（若文献包含 pdf_file 请优先读取完整 PDF 原文）。针对以下文献：${idList}，帮我写一份结构清晰的主题文献综述草稿（按研究脉络与学术争议组织，文中标注作者和年份，文末附 GB/T 7714 参考文献），并将结果保存为新的 Markdown 文件放进 writing_workspace/ 目录。`
      },
      {
        title: "2. 多篇文献观点 / 方法 / 局限对比表",
        desc: "结合 PDF 全文细节生成标准对比表 + 毕业论文创新切入点。",
        prompt: `请先阅读当前文件夹中的 AI_GUIDE.md 和 data/library.json（有 pdf_file 的请优先读原文）。针对以下文献：${idList}，制作一份多维对比表（列：作者与年份、核心观点、研究方法与样本、主要局限），并在表后总结 2-3 个适合我毕业论文切入的研究缺口，保存到 writing_workspace/ 目录中。`
      },
      {
        title: "3. 结合文献库梳理毕业论文大纲",
        desc: "把现有文献精准映射到每一章，找出还缺哪类文献。",
        prompt: `请阅读当前文件夹中的 AI_GUIDE.md 和 data/library.json 中全部文献与笔记，结合人文社科/经管毕业论文规范，帮我梳理一份带二级标题的毕业论文大纲，注明每一章可引用哪些已有文献，并指出目前文献库中还缺少哪类支撑文献，结果保存到 writing_workspace/ 目录。`
      },
      {
        title: `4. 批量读 PDF / 摘要提炼笔记（待处理 ${emptyNotePapers.length} 篇）`,
        desc: "让 AI 自动读取 PDF 原文或摘要，补全四维笔记并写回本地库。",
        prompt:
          emptyNotePapers.length > 0
            ? `请阅读当前文件夹中的 AI_GUIDE.md 和 data/library.json。请帮我为以下尚未填写笔记的文献（有 pdf_file 的请直接读取完整 PDF 全文）提炼「核心观点」「研究方法」「主要局限」，直接更新写回 data/library.json 和 data/notes/ 对应文件：${emptyNotePapers.map((p) => `${p.id}（${p.title}${p.pdf_file ? `，原文：${p.pdf_file}` : ""}）`).join("；")}。`
            : `请阅读当前文件夹中的 AI_GUIDE.md 和 data/library.json，结合已绑定的 PDF 原文检查现有文献笔记，帮我补充更精准的学术表述并写回 data/library.json。`
      }
    ];

    const container = $("promptCardsContainer");
    container.innerHTML = "";
    cards.forEach((c) => {
      const div = document.createElement("div");
      div.className = "prompt-card";
      div.innerHTML = `
        <div><h4>${escapeHtml(c.title)}</h4><p>${escapeHtml(c.desc)}</p></div>
        <div class="prompt-preview">${escapeHtml(c.prompt)}</div>
        <button class="btn btn-sm btn-primary">一键复制给新对话</button>
      `;
      div.querySelector("button").addEventListener("click", () => {
        copyText(c.prompt, `已复制「${c.title}」指令，粘贴到新对话发送即可`);
      });
      container.appendChild(div);
    });

    openModal("modalAiPrompts");
  }

  function setWorkspaceContent(name, content) {
    state.currentWsRaw = content || "";
    $("workspaceFileTitle").textContent = name || "未选择文档";
    $("workspaceFileContent").textContent = state.currentWsRaw;
    $("workspaceRendered").innerHTML = renderMarkdown(state.currentWsRaw);
    applyWorkspaceViewMode();
  }

  function applyWorkspaceViewMode() {
    const isPreview = state.wsViewMode === "preview";
    $("btnWsPreviewMode").classList.toggle("active", isPreview);
    $("btnWsRawMode").classList.toggle("active", !isPreview);
    $("workspaceRendered").classList.toggle("hidden", !isPreview);
    $("workspaceFileContent").classList.toggle("hidden", isPreview);
  }

  async function openWorkspaceModal() {
    openModal("modalWorkspace");
    const listEl = $("workspaceFileList");
    listEl.innerHTML = "";

    if (state.serverMode) {
      try {
        const res = await fetch("/api/workspace", { cache: "no-store" });
        const data = await res.json();
        const files = data.files || [];
        if (files.length === 0) {
          listEl.innerHTML = `<li class="muted" style="padding:8px;">暂无文档</li>`;
          setWorkspaceContent("暂无文档", "在新对话中让 AI 生成文献综述、对比表或论文大纲后，文档会自动显示在这里。");
          return;
        }
        const loadFile = async (name) => {
          const r = await fetch(`/api/workspace/${encodeURIComponent(name)}`, { cache: "no-store" });
          const d = await r.json();
          setWorkspaceContent(d.name || name, d.content || "");
        };
        files.forEach((item, idx) => {
          const li = document.createElement("li");
          li.className = "nav-item" + (idx === 0 ? " active" : "");
          li.textContent = item.name;
          li.onclick = () => {
            listEl.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
            li.classList.add("active");
            loadFile(item.name);
          };
          listEl.appendChild(li);
        });
        await loadFile(files[0].name);
      } catch (err) {
        setWorkspaceContent("读取失败", "读取论文产出区失败：" + err.message);
      }
      return;
    }

    if (!state.dirHandle) {
      setWorkspaceContent("尚未连接本地文件夹", "连接本地文件夹后即可浏览 writing_workspace 目录下的所有论文文档。");
      return;
    }
    try {
      const wsDir = await state.dirHandle.getDirectoryHandle("writing_workspace", { create: true });
      const files = [];
      for await (const [name, handle] of wsDir.entries()) {
        if (handle.kind === "file" && name.endsWith(".md")) {
          const f = await handle.getFile();
          files.push({ name, handle, mtime: f.lastModified });
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) { listEl.innerHTML = `<li class="muted" style="padding:8px;">暂无文档</li>`; return; }
      files.forEach((item, idx) => {
        const li = document.createElement("li");
        li.className = "nav-item" + (idx === 0 ? " active" : "");
        li.textContent = item.name;
        li.onclick = async () => {
          listEl.querySelectorAll(".nav-item").forEach((x) => x.classList.remove("active"));
          li.classList.add("active");
          const f = await item.handle.getFile();
          setWorkspaceContent(item.name, await f.text());
        };
        listEl.appendChild(li);
      });
      const firstFile = await files[0].handle.getFile();
      setWorkspaceContent(files[0].name, await firstFile.text());
    } catch (err) {
      setWorkspaceContent("读取失败", "读取论文产出区失败：" + err.message);
    }
  }

  function updateBatchCiteText() {
    const selected = state.library.papers.filter((p) => state.checkedIds.has(p.id));
    const lines = selected.map((p, idx) =>
      state.batchCiteMode === "gbt" ? `[${idx + 1}] ${formatGbt7714(p)}` : formatApa(p)
    );
    $("batchCiteOutput").value = lines.join("\n");
  }

  function bindEvents() {
    document.querySelectorAll(".close-modal").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });

    $("btnConnectFolder").addEventListener("click", connectLocalFolder);
    $("btnRefreshSync").addEventListener("click", async () => {
      const ok = await readLibraryFromDisk();
      if (ok) {
        if (!state.library.papers.some((p) => p.id === state.selectedPaperId)) {
          state.selectedPaperId = state.library.papers[0]?.id || null;
        }
        renderAll();
        showToast("已从本地文件夹同步最新文献与笔记");
      }
    });

    $("searchInput").addEventListener("input", (e) => { state.searchQuery = e.target.value; renderPaperList(); });

    $("btnGoCnki").addEventListener("click", () => {
      const q = encodeURIComponent($("searchInput").value.trim());
      window.open(q ? `https://kns.cnki.net/kns8s/defaultresult/index?kw=${q}` : "https://www.cnki.net/", "_blank");
    });

    $("btnGoScholar").addEventListener("click", () => {
      const q = encodeURIComponent($("searchInput").value.trim());
      window.open(q ? `https://scholar.google.com/scholar?q=${q}` : "https://scholar.google.com/", "_blank");
    });

    // V4 批量导入完整 PDF 论文
    $("inputBatchPdf").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (!files.length) return;
      showToast(`正在归档导入 ${files.length} 篇完整 PDF 论文...`);
      const catId = state.filterType === "category" ? state.filterCategoryId : (state.library.categories[0]?.id || "");
      const existingSet = new Set(state.library.papers.map((p) => normalizeTitle(p.title)));
      const ts = nowIso();
      let added = 0;
      let skipped = 0;

      for (let idx = 0; idx < files.length; idx++) {
        const f = files[idx];
        const cleanTitle = f.name.replace(/\.pdf$/i, "").replace(/_/g, " ").trim() || "未命名 PDF 论文";
        const norm = normalizeTitle(cleanTitle);
        if (norm && existingSet.has(norm)) {
          skipped++;
          continue;
        }
        try {
          const uploaded = await uploadPdfToLibrary(f);
          if (norm) existingSet.add(norm);
          const paper = {
            id: `paper_${Date.now()}_${idx}`,
            title: cleanTitle,
            authors: [],
            journal: "",
            year: String(new Date().getFullYear()),
            volume: "",
            issue: "",
            pages: "",
            doc_type: "J",
            language: detectLanguage(cleanTitle),
            source: "PDF 原文导入",
            doi: "",
            url: "",
            pdf_file: uploaded.pdf_file,
            abstract: "",
            category_id: catId,
            tags: ["待读"],
            status: "待读",
            starred: false,
            notes: { core_viewpoint: "", methodology: "", limitations: "", personal_notes: "" },
            created_at: ts,
            updated_at: ts
          };
          state.library.papers.unshift(paper);
          state.selectedPaperId = paper.id;
          added++;
        } catch (err) {
          showToast(err.message || "PDF 导入失败");
          break;
        }
      }

      if (added > 0) await persistLibrary();
      renderAll();
      if (added > 0 && skipped > 0) showToast(`已导入 ${added} 篇 PDF 论文，跳过 ${skipped} 篇重复`);
      else if (added > 0) showToast(`成功导入 ${added} 篇完整 PDF 论文，已归档至 data/pdfs/`);
      else if (skipped > 0) showToast(`所选 ${skipped} 篇 PDF 论文已存在，已自动跳过`);
    });

    // V4 单篇文献上传/更换 PDF、打开原文、解除绑定
    $("inputAttachPdf").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      try {
        showToast("正在归档 PDF 原文...");
        const uploaded = await uploadPdfToLibrary(file);
        p.pdf_file = uploaded.pdf_file;
        p.updated_at = nowIso();
        await persistLibrary(p);
        renderAll();
        showToast(`已绑定 PDF 原文：${uploaded.filename}`);
      } catch (err) {
        showToast(err.message || "绑定 PDF 失败");
      }
    });

    $("btnOpenPdf").addEventListener("click", () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (p?.pdf_file) openAttachedPdf(p.pdf_file);
    });

    $("btnUnlinkPdf").addEventListener("click", async () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p || !p.pdf_file) return;
      if (!confirm("确定解除该文献的 PDF 原文绑定吗？（本地 data/pdfs/ 中的文件会保留）")) return;
      p.pdf_file = "";
      p.updated_at = nowIso();
      await persistLibrary(p);
      renderAll();
      showToast("已解除 PDF 绑定");
    });

    $("btnOpenImport").addEventListener("click", () => {
      fillCategorySelect("importCategorySelect", state.filterType === "category" ? state.filterCategoryId : "");
      $("importRawText").value = "";
      openModal("modalImport");
    });

    $("btnRunImport").addEventListener("click", async () => {
      const items = parseCitations($("importRawText").value);
      if (items.length === 0) {
        showToast("未识别到引文格式，请检查是否粘贴了完整的 RefWorks / BibTeX / 国标文本");
        return;
      }
      const existingSet = new Set(state.library.papers.map((p) => normalizeTitle(p.title)));
      const catId = $("importCategorySelect").value;
      const ts = nowIso();
      const baseMs = Date.now();
      let addedCount = 0;
      let skippedCount = 0;

      items.forEach((it, idx) => {
        const norm = normalizeTitle(it.title);
        if (norm && existingSet.has(norm)) { skippedCount++; return; }
        if (norm) existingSet.add(norm);
        const paper = {
          id: `paper_${baseMs}_${idx}`,
          ...it,
          pdf_file: "",
          category_id: catId,
          tags: ["待读"], status: "待读", starred: false,
          notes: { core_viewpoint: "", methodology: "", limitations: "", personal_notes: "" },
          created_at: ts, updated_at: ts
        };
        state.library.papers.unshift(paper);
        state.selectedPaperId = paper.id;
        addedCount++;
      });

      if (addedCount > 0) await persistLibrary();
      closeModal("modalImport");
      renderAll();

      if (addedCount === 0 && skippedCount > 0) showToast(`这 ${skippedCount} 篇文献均已存在，已自动跳过重复项`);
      else if (skippedCount > 0) showToast(`成功导入 ${addedCount} 篇，已自动跳过 ${skippedCount} 篇重复文献`);
      else showToast(`成功解析并导入 ${addedCount} 篇文献`);
    });

    $("btnAddPaper").addEventListener("click", () => openPaperForm(null));
    $("btnEditMeta").addEventListener("click", () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (p) openPaperForm(p);
    });

    $("btnSubmitPaperForm").addEventListener("click", async () => {
      const title = $("fTitle").value.trim();
      if (!title) { showToast("请填写文献标题"); return; }
      const dup = findDuplicatePaper(title, state.editingPaperId);
      if (dup && !confirm(`文献库中已存在标题相同的文献《${dup.title}》，确定仍要重复保存吗？`)) return;
      const authors = $("fAuthors").value.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
      const ts = nowIso();
      const payload = {
        title, authors,
        journal: $("fJournal").value.trim(), year: $("fYear").value.trim(),
        doc_type: $("fDocType").value, volume: $("fVolume").value.trim(),
        issue: $("fIssue").value.trim(), pages: $("fPages").value.trim(),
        language: $("fLanguage").value, source: $("fSource").value.trim() || "手动录入",
        category_id: $("fCategory").value, abstract: $("fAbstract").value.trim()
      };
      let savedPaper;
      if (state.editingPaperId) {
        savedPaper = state.library.papers.find((x) => x.id === state.editingPaperId);
        Object.assign(savedPaper, payload, { updated_at: ts });
      } else {
        savedPaper = {
          id: `paper_${Date.now()}`,
          ...payload, doi: "", url: "", pdf_file: "",
          tags: ["待读"], status: "待读", starred: false,
          notes: { core_viewpoint: "", methodology: "", limitations: "", personal_notes: "" },
          created_at: ts, updated_at: ts
        };
        state.library.papers.unshift(savedPaper);
        state.selectedPaperId = savedPaper.id;
      }
      await persistLibrary(savedPaper);
      closeModal("modalPaperForm");
      renderAll();
      showToast("文献已保存");
    });

    document.querySelectorAll("#smartFilterList .nav-item").forEach((el) => {
      el.addEventListener("click", () => { state.filterType = el.dataset.filter; state.filterCategoryId = ""; renderAll(); });
    });

    $("btnAddCategory").addEventListener("click", async () => {
      const name = prompt("请输入新分类名称（如：第三章 实证模型）：");
      if (!name || !name.trim()) return;
      state.library.categories.push({ id: `cat_${Date.now()}`, name: name.trim() });
      await persistLibrary();
      renderAll();
      showToast(`已添加分类「${name.trim()}」`);
    });

    document.querySelectorAll("#statusFilterWrap .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#statusFilterWrap .chip").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.filterStatus = btn.dataset.status;
        renderPaperList();
      });
    });

    $("sortSelect").addEventListener("change", (e) => { state.sortBy = e.target.value; renderPaperList(); });
    $("chkSelectAll").addEventListener("change", (e) => {
      const filtered = getFilteredPapers();
      if (e.target.checked) filtered.forEach((p) => state.checkedIds.add(p.id));
      else filtered.forEach((p) => state.checkedIds.delete(p.id));
      renderPaperList();
    });

    $("btnBatchCite").addEventListener("click", () => { updateBatchCiteText(); openModal("modalBatchCite"); });
    document.querySelectorAll("[data-cite-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-cite-tab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.batchCiteMode = btn.dataset.citeTab;
        updateBatchCiteText();
      });
    });
    $("btnCopyBatchCite").addEventListener("click", () => copyText($("batchCiteOutput").value, "已复制批量参考文献"));

    $("btnToggleStar").addEventListener("click", async () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      p.starred = !p.starred;
      p.updated_at = nowIso();
      await persistLibrary(p);
      renderAll();
    });

    $("btnDeletePaper").addEventListener("click", async () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      if (!confirm(`确定删除文献《${p.title}》吗？`)) return;
      state.library.papers = state.library.papers.filter((x) => x.id !== p.id);
      state.checkedIds.delete(p.id);
      state.selectedPaperId = state.library.papers[0]?.id || null;
      await persistLibrary();
      renderAll();
      showToast("文献已删除");
    });

    $("detailCategorySelect").addEventListener("change", async (e) => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      p.category_id = e.target.value;
      p.updated_at = nowIso();
      await persistLibrary(p);
      renderSidebar();
      showToast("已更新分类");
    });

    $("detailStatusSelect").addEventListener("change", async (e) => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      p.status = e.target.value;
      p.updated_at = nowIso();
      await persistLibrary(p);
      renderPaperList();
      showToast("已更新阅读进度");
    });

    $("detailTagsInput").addEventListener("change", async (e) => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      const tags = e.target.value.split(/[,，、;；]/).map((t) => t.trim()).filter(Boolean);
      p.tags = tags;
      tags.forEach((t) => { if (!state.library.tags.includes(t)) state.library.tags.push(t); });
      p.updated_at = nowIso();
      await persistLibrary(p);
      renderSidebar();
      renderPaperList();
      showToast("已更新标签");
    });

    $("btnCopyInline").addEventListener("click", () => copyText($("previewInline").textContent, "已复制正文夹注引用"));
    $("btnCopyGbt").addEventListener("click", () => copyText($("previewGbt").textContent, "已复制国标 GB/T 7714 格式"));
    $("btnCopyApa").addEventListener("click", () => copyText($("previewApa").textContent, "已复制 APA 格式"));

    $("btnCopyAiPrompt").addEventListener("click", () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      const pdfHint = p.pdf_file ? `请优先直接读取它的完整 PDF 原文（${p.pdf_file}），` : "";
      const promptText = `请阅读当前文件夹中的 AI_GUIDE.md 和 data/library.json。针对文献《${p.title}》（ID: ${p.id}），${pdfHint}帮我提炼「核心观点」「研究方法」「主要局限」，并直接写回 data/library.json 和 data/notes/${p.id}.md 中。`;
      copyText(promptText, "已复制 AI 协作指令，直接粘贴到新对话即可");
    });

    $("btnSaveNotes").addEventListener("click", async () => {
      const p = state.library.papers.find((x) => x.id === state.selectedPaperId);
      if (!p) return;
      p.notes = {
        core_viewpoint: $("noteCore").value.trim(),
        methodology: $("noteMethod").value.trim(),
        limitations: $("noteLimit").value.trim(),
        personal_notes: $("notePersonal").value.trim()
      };
      p.updated_at = nowIso();
      await persistLibrary(p);
      renderPaperList();
      showToast(state.serverMode || state.dirHandle ? "笔记已保存并同步到本地文件夹" : "笔记已暂存浏览器");
    });

    $("btnOpenAiPrompts").addEventListener("click", openAiPromptsModal);
    $("btnOpenWorkspace").addEventListener("click", openWorkspaceModal);
    $("btnExportMobile").addEventListener("click", exportMobileOfflineHtml);
    $("btnWsPreviewMode").addEventListener("click", () => { state.wsViewMode = "preview"; applyWorkspaceViewMode(); });
    $("btnWsRawMode").addEventListener("click", () => { state.wsViewMode = "raw"; applyWorkspaceViewMode(); });
    $("btnCopyWorkspaceContent").addEventListener("click", () => copyText(state.currentWsRaw, "已复制 Markdown 原文"));
    $("btnCopyWorkspaceRich").addEventListener("click", () =>
      copyRichHtml($("workspaceRendered").innerHTML, state.currentWsRaw, "已复制带表格排版内容，可直接粘贴到 Word / WPS")
    );

    $("btnOpenSettings").addEventListener("click", () => {
      const cfg = state.library.ai_config || DEFAULT_LIBRARY.ai_config;
      $("cfgAiEnabled").checked = Boolean(cfg.enabled);
      $("cfgAiProvider").value = cfg.provider || "gemini";
      $("cfgAiModel").value = cfg.model || "";
      $("cfgAiBaseUrl").value = cfg.base_url || "";
      $("cfgAiKey").value = cfg.api_key || "";
      openModal("modalSettings");
    });

    $("btnSaveSettings").addEventListener("click", async () => {
      state.library.ai_config = {
        enabled: $("cfgAiEnabled").checked,
        provider: $("cfgAiProvider").value,
        model: $("cfgAiModel").value.trim(),
        base_url: $("cfgAiBaseUrl").value.trim(),
        api_key: $("cfgAiKey").value.trim()
      };
      await persistLibrary();
      closeModal("modalSettings");
      showToast("设置已保存");
    });

    $("btnExportJson").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state.library, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "library.json";
      a.click();
      URL.revokeObjectURL(url);
      showToast("已导出 library.json");
    });

    $("inputImportJson").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || !Array.isArray(parsed.papers)) throw new Error("格式不正确");
          state.library = parsed;
          state.selectedPaperId = state.library.papers[0]?.id || null;
          await persistLibrary();
          renderAll();
          closeModal("modalSettings");
          showToast(`已导入 ${state.library.papers.length} 篇文献`);
        } catch (err) {
          showToast("导入失败：" + err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  async function init() {
    state.library = loadLocalCache();
    bindEvents();

    if (window.location.protocol.startsWith("http")) {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) {
          const info = await res.json();
          state.serverMode = true;
          const statusEl = $("syncStatusText");
          statusEl.textContent = `已直连本机服务「${info.folder || "文献检索软件"}」· 实时同步中`;
          statusEl.classList.add("connected");
          $("btnConnectFolder").textContent = "本机服务已连接";
          $("btnConnectFolder").disabled = true;
          await readLibraryFromDisk();
        }
      } catch (_) {}
    }

    state.selectedPaperId = state.library.papers[0]?.id || null;
    renderAll();
  }

  init();
})();
