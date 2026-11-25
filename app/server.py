#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
毕业设计文献检索与分类助手 - 纯本机服务 (仅监听 127.0.0.1，不连外网)
仅使用 Mac 自带 Python 3 标准库，无任何第三方依赖。
"""

import json
import os
import re
import socket
import sys
import threading
import urllib.parse
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
NOTES_DIR = DATA_DIR / "notes"
WORKSPACE_DIR = BASE_DIR / "writing_workspace"
LIBRARY_FILE = DATA_DIR / "library.json"
AI_SECRETS_FILE = DATA_DIR / "ai_secrets.local.json"


def strip_ai_secrets(data: dict) -> dict:
    ai_cfg = data.get("ai_config")
    if isinstance(ai_cfg, dict) and "api_key" in ai_cfg:
        ai_cfg.pop("api_key", None)
    return data

DATA_DIR.mkdir(parents=True, exist_ok=True)
NOTES_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)


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


class LocalLitHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

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

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/health":
            self._send_json({"ok": True, "folder": BASE_DIR.name})
            return

        if path == "/api/ai-secrets":
            if AI_SECRETS_FILE.exists():
                try:
                    secrets = json.loads(AI_SECRETS_FILE.read_text(encoding="utf-8"))
                    self._send_json({"api_key": str(secrets.get("api_key") or "")})
                except Exception:
                    self._send_json({"api_key": ""})
            else:
                self._send_json({"api_key": ""})
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
        if path == "/api/ai-secrets":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw)
            api_key = str(payload.get("api_key") or "").strip()
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            AI_SECRETS_FILE.write_text(
                json.dumps({"api_key": api_key}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            if sys.platform != "win32":
                try:
                    os.chmod(AI_SECRETS_FILE, 0o600)
                except OSError:
                    pass
            self._send_json({"ok": True})
            return

        if path == "/api/library":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            data = strip_ai_secrets(json.loads(raw))
            LIBRARY_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            sync_all_notes(data)
            self._send_json({"ok": True})
            return
        self._send_json({"error": "未知接口"}, 404)


def pick_port(start: int = 8765) -> int:
    for p in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0


def main():
    port = pick_port(8765)
    server = ThreadingHTTPServer(("127.0.0.1", port), LocalLitHandler)
    actual_port = server.server_address[1]
    url = f"http://127.0.0.1:{actual_port}"

    print("=" * 50)
    print("  毕业设计文献助手 - 本机服务已启动（仅限本机访问）")
    print(f"  浏览器地址：{url}")
    print("  提示：用完直接关闭此窗口即可停止服务")
    print("=" * 50)

    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已安全停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
