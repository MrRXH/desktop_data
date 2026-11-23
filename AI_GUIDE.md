# AI 协作交接说明书（AI_GUIDE.md）

本文件夹是一个面向**人文社科 / 经管毕业论文**的本地文献检索与分类知识库。
当用户在新的对话中连接本文件夹，并请你“整理文献、提炼观点、重新分类、生成文献综述、对比多篇论文、梳理大纲或整理参考文献”时，请严格遵循以下目录结构与数据规范。

---

## 1. 目录结构

- `data/library.json`：**核心主数据库**。软件界面展示的所有文献、分类、标签、PDF 路径（`pdf_file`）与结构化笔记均以此文件为准。
- `data/pdfs/`：**完整 PDF 论文原文归档目录**。当文献条目包含 `pdf_file`（例如 `"data/pdfs/xxx.pdf"`）时，请优先直接读取该完整 PDF 原文进行深度提炼、方法分析与精准引用，而不仅依赖摘要。
- `data/notes/<id>.md`：每篇文献对应的可读 Markdown 笔记副本。每次通过软件保存时会自动更新；如果你在对话中直接修改了 `data/library.json`，请同时更新对应的 `data/notes/<id>.md`（或提醒用户在软件中点击「刷新同步」）。
- `writing_workspace/`：**论文写作产出区**。当你为用户生成「主题文献综述草稿」「多篇论文观点/方法/局限对比表」「论文大纲」「参考文献汇总」时，请以清晰的 `.md` 文件保存到此目录（例如 `文献综述_数字经济与中小企业.md`），用户可在软件的「论文产出区」中直接查看和复制。
- `文献检索软件.html`：本地网页软件主界面。可通过 `app/server.py` 启动本地服务在 Safari / 任意浏览器中打开（推荐，自动实时读写本目录），也可直接双击用 Chrome / Edge 打开。
- `app/`：软件界面样式（`styles.css`）、前端逻辑（`app.js`）与纯本机 Python 服务（`server.py`）。

---

## 2. `data/library.json` 数据规范

顶层结构：
```json
{
  "version": "1.0",
  "updated_at": "2026-11-23T16:30:00",
  "categories": [
    { "id": "cat_bg", "name": "研究背景与问题" }
  ],
  "tags": ["核心文献", "精读", "待读", "方法参考", "支持论点", "反方观点"],
  "ai_config": {
    "enabled": false,
    "provider": "gemini",
    "base_url": "",
    "model": "gemini-2.5-flash",
    "api_key": ""
  },
  "papers": [
    {
      "id": "paper_001",
      "title": "文献标题",
      "authors": ["作者一", "作者二"],
      "journal": "期刊名称 / 学位授予单位 / 出版社",
      "year": "2024",
      "volume": "40",
      "issue": "3",
      "pages": "45-62",
      "doc_type": "J",
      "language": "zh",
      "source": "知网 CNKI",
      "doi": "",
      "url": "",
      "abstract": "文献摘要",
      "category_id": "cat_review",
      "tags": ["核心文献", "精读"],
      "status": "精读",
      "starred": true,
      "notes": {
        "core_viewpoint": "核心观点与主要结论",
        "methodology": "研究方法、样本数据与模型设定",
        "limitations": "主要局限与可拓展的研究缺口",
        "personal_notes": "个人启发与计划引用的论文章节"
      },
      "created_at": "2026-11-23T16:30:00",
      "updated_at": "2026-11-23T16:30:00"
    }
  ]
}
```

### 字段说明
- `doc_type`：遵循国标 GB/T 7714 文献类型标识：
  - `J`：期刊文章（最常用）
  - `D`：学位论文（硕士/博士论文）
  - `M`：专著/图书
  - `C`：会议论文
  - `R`：研究报告
- `language`：`"zh"`（中文）或 `"en"`（英文），用于自动切换中英文标点与 APA/GB/T 7714 格式。
- `status`：`"待读"` | `"在读"` | `"精读"`。

---

## 3. 修改与协作注意事项

1. **只增改需要变动的条目**：修改 `data/library.json` 时务必保持合法 JSON 格式与 UTF-8 编码，不要随意删除已有文献的 `id` 或用户手写的 `personal_notes`。
2. **新增分类/标签时同步注册**：若给文献赋予新的 `category_id` 或 `tags`，请确保在顶层 `categories` / `tags` 列表中也存在对应项。
3. **写论文输出规范**：
   - 生成**文献综述**时，尽量按主题脉络归纳（而非简单流水账），并在文中标注 `(作者, 年份)`，文末附上对应的 GB/T 7714 参考文献列表。
   - 生成**多篇对比**时，优先用 Markdown 表格对比「作者与年份 / 核心观点 / 研究方法与样本 / 主要局限」。
4. **完成后提醒用户**：修改完 `data/library.json` 或在 `writing_workspace/` 新增文件后，提醒用户在软件右上角点击**「刷新同步」**即可立刻看到最新结果。
