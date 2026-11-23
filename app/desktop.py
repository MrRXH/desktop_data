#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
毕业设计文献检索与分类助手 - Mac / Windows 独立桌面软件入口 (V4 完整论文版)
支持：完整 PDF 论文归档至 data/pdfs/、一键系统默认阅读器打开原文、手机随身版固定目录导出。
"""

import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview


def get_resource_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def get_user_data_root() -> Path:
    desktop = Path.home() / "Desktop"
    root = (desktop / "文献检索软件") if desktop.exists() else (Path.home() / "文献检索软件")
    root.mkdir(parents=True, exist_ok=True)
    return root


RESOURCE_DIR = get_resource_dir()
USER_ROOT = get_user_data_root()
DATA_DIR = USER_ROOT / "data"
NOTES_DIR = DATA_DIR / "notes"
PDF_DIR = DATA_DIR / "pdfs"
WORKSPACE_DIR = USER_ROOT / "writing_workspace"
EXPORT_DIR = USER_ROOT / "mobile_export"
LIBRARY_FILE = DATA_DIR / "library.json"


def reveal_file(target: Path) -> None:
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        elif sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", str(target)])
    except Exception:
        pass


def open_file_default(target: Path) -> None:
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        elif sys.platform == "win32":
            os.startfile(str(target))
    except Exception:
        pass


def sanitize_pdf_filename(raw_name: str) -> str:
    name = Path(str(raw_name or "paper.pdf")).name
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip()
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name or "paper.pdf"


def init_user_workspace() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    guide_src = RESOURCE_DIR / "AI_GUIDE.md"
    guide_dst = USER_ROOT / "AI_GUIDE.md"
    if guide_src.exists() and not guide_dst.exists():
        try:
            shutil.copy2(guide_src, guide_dst)
        except OSError:
            pass

    if not LIBRARY_FILE.exists():
        default_data = {
            "version": "1.0",
            "updated_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "categories": [
                {"id": "cat_bg", "name": "研究背景与问题"},
                {"id": "cat_review", "name": "文献综述"},
                {"id": "cat_theory", "name": "理论基础与模型"},
                {"id": "cat_empirical", "name": "实证与案例分析"},
                {"id": "cat_policy", "name": "政策与对策建议"},
            ],
            "tags": ["核心文献", "精读", "待读", "方法参考", "支持论点", "反方观点"],
            "ai_config": {
                "enabled": False,
                "provider": "gemini",
                "base_url": "",
                "model": "gemini-2.5-flash",
                "api_key": "",
            },
            "papers": [],
        }
        LIBRARY_FILE.write_text(json.dumps(default_data, ensure_ascii=False, indent=2), encoding="utf-8")


def sync_all_notes(data: dict) -> None:
    cat_map = {c.get("id", ""): c.get("name", "未分类") for c in data.get("categories", [])}
    valid_files = set()
    for p in data.get("papers", []):
        pid = re.sub(r"[^a-zA-Z0-9_\-]", "_", str(p.get("id", "unknown")))
        fname = f"{pid}.md"
        valid_files.add(fname)
        authors = ("、" if p.get("language") == "zh" else ", ").join(p.get("authors", [])) or "未知"
        cat_name = cat_map.get(p.get("category_id", ""), "未分类")
        tags = ", ".join(p.get("tags", [])) or "无"
        pdf_file = p.get("pdf_file", "") or "未绑定"
        n = p.get("notes") or {}
        md = f"""# {p.get("title", "未命名文献")}

- **ID**：`{p.get("id", "")}`
- **作者**：{authors}
- **期刊/来源**：{p.get("journal", "未知")} ({p.get("year", "未知")})
- **卷/期/页码**：卷 {p.get("volume", "-")} / 期 {p.get("issue", "-")} / 页码 {p.get("pages", "-")}
- **文献类型**：{p.get("doc_type", "J")} ｜ **语言**：{p.get("language", "zh")} ｜ **来源库**：{p.get("source", "手动录入")}
- **分类**：{cat_name}
- **标签**：{tags}
- **阅读状态**：{p.get("status", "待读")}
- **PDF 原文**：`{pdf_file}`

## 摘要
{p.get("abstract", "") or "（暂无摘要）"}

## 核心观点
{n.get("core_viewpoint", "") or "（待补充）"}

## 研究方法
{n.get("methodology", "") or "（待补充）"}

## 主要局限
{n.get("limitations", "") or "（待补充）"}

## 个人启发与引用位置
{n.get("personal_notes", "") or "（待补充）"}
"""
        (NOTES_DIR / fname).write_text(md, encoding="utf-8")

    for old_md in NOTES_DIR.glob("*.md"):
        if old_md.name not in valid_files:
            try:
                old_md.unlink()
            except OSError:
                pass


class DesktopLitHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(RESOURCE_DIR), **kwargs)

    def log_message(self, format, *args):
        pass

    def _send_json(self, obj: dict, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/health":
            self._send_json({"ok": True, "folder": USER_ROOT.name})
            return

        if path == "/api/library":
            if LIBRARY_FILE.exists():
                data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
                sync_all_notes(data)
                self._send_json(data)
            else:
                self._send_json({"error": "未找到 library.json"}, 404)
            return

        if path == "/api/workspace":
            files = []
            for f in sorted(WORKSPACE_DIR.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
                files.append(
                    {
                        "name": f.name,
                        "updated_at": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
                    }
                )
            self._send_json({"files": files})
            return

        if path.startswith("/api/workspace/"):
            fname = urllib.parse.unquote(path[len("/api/workspace/") :])
            if "/" in fname or "\\" in fname or ".." in fname:
                self._send_json({"error": "非法文件名"}, 400)
                return
            target = WORKSPACE_DIR / fname
            if not target.exists():
                self._send_json({"error": "文件不存在"}, 404)
                return
            self._send_json({"name": fname, "content": target.read_text(encoding="utf-8")})
            return

        if path == "/":
            self.path = "/" + urllib.parse.quote("文献检索软件.html")
        return super().do_GET()

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/library":
            data = self._read_json()
            LIBRARY_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            sync_all_notes(data)
            self._send_json({"ok": True})
            return
        self._send_json({"error": "未知接口"}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/export-mobile":
            payload = self._read_json()
            filename = Path(str(payload.get("filename") or "文献随身版.html")).name
            if not filename.endswith(".html"):
                filename += ".html"
            html_content = str(payload.get("html") or "")
            EXPORT_DIR.mkdir(parents=True, exist_ok=True)
            target = EXPORT_DIR / filename
            target.write_text(html_content, encoding="utf-8")
            reveal_file(target)
            self._send_json({"ok": True, "filename": filename, "path": str(target)})
            return

        if path == "/api/upload-pdf":
            payload = self._read_json()
            safe_name = sanitize_pdf_filename(payload.get("filename", "paper.pdf"))
            b64 = str(payload.get("base64") or "")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            pdf_bytes = base64.b64decode(b64)
            PDF_DIR.mkdir(parents=True, exist_ok=True)
            stem = Path(safe_name).stem
            target = PDF_DIR / safe_name
            counter = 2
            while target.exists():
                target = PDF_DIR / f"{stem}_{counter}.pdf"
                counter += 1
            target.write_bytes(pdf_bytes)
            self._send_json(
                {"ok": True, "pdf_file": f"data/pdfs/{target.name}", "filename": target.name}
            )
            return

        if path == "/api/open-pdf":
            payload = self._read_json()
            rel = str(payload.get("pdf_file") or "").strip()
            if not rel:
                self._send_json({"error": "未指定 PDF 路径"}, 400)
                return
            target = (USER_ROOT / rel).resolve()
            if not str(target).startswith(str(PDF_DIR.resolve())) or not target.exists():
                self._send_json({"error": "未找到对应的 PDF 文件"}, 404)
                return
            open_file_default(target)
            self._send_json({"ok": True})
            return

        self._send_json({"error": "未知接口"}, 404)


def pick_port(start: int = 18765) -> int:
    for p in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0


def main():
    init_user_workspace()
    port = pick_port(18765)
    server = ThreadingHTTPServer(("127.0.0.1", port), DesktopLitHandler)
    actual_port = server.server_address[1]
    url = f"http://127.0.0.1:{actual_port}/"

    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    try:
        webview.create_window(
            title="毕业设计文献检索与分类助手",
            url=url,
            width=1320,
            height=840,
            min_size=(960, 620),
        )
        webview.start()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
