#!/usr/bin/env python3
"""Ollama Local Helper MCP Server.

Provides GPU-accelerated local code analysis, file reading, codebase search,
and code generation using Qwen 2.5 Coder on RTX 3080 with 32k/128k context tiers.
Reduces cloud model token consumption by processing raw files directly on disk.
"""

import datetime
import fnmatch
import json
import os
import re
import subprocess
import sys
import urllib.request

# Ensure UTF-8 I/O
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

LOG_FILE = "/var/log/ollama_helper_mcp.log"


def log_debug(msg):
    """Write timestamped debug log message."""
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            f.write(f"[{now}] {msg}\n")
    except Exception:
        try:
            with open("/tmp/ollama_helper_mcp.log", "a", encoding="utf-8") as f:
                now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                f.write(f"[{now}] {msg}\n")
        except Exception:
            pass


OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_URL = f"{OLLAMA_HOST}/api/generate"
MODEL_NAME = os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")

# Threshold: ~24,000 estimated tokens (~84,000 characters)
THRESHOLD_CHARS = 84000

IGNORE_DIRS = {
    "node_modules", ".git", "bin", "obj", ".godot", ".gemini", "dist",
    "__pycache__", "venv", ".venv", ".vs", ".idea", "target", "build",
    ".nuget", "vendor"
}


def send_response(response_dict):
    payload = json.dumps(response_dict)
    log_debug(f"SEND: {payload}")
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()


def call_ollama(prompt, system_prompt="", file_path="", mode="auto"):
    """Query local Ollama instance on RTX 3080 with dynamic context tiers."""
    if file_path:
        if not os.path.isabs(file_path):
            file_path = os.path.abspath(file_path)
        if not os.path.exists(file_path):
            return f"Error: File not found at {file_path}"
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            prompt = f"Context from file '{file_path}':\n```\n{content}\n```\n\nTask / Instructions:\n{prompt}"
        except Exception as e:
            return f"Error reading file '{file_path}': {str(e)}"

    char_count = len(prompt) + len(system_prompt)

    if mode == "fast_32k":
        num_ctx = 32768
        tier = "32k (Forced Fast GPU)"
    elif mode == "deep_128k":
        num_ctx = 131072
        tier = "128k (Forced Deep Context - 64GB RAM)"
    else:
        if char_count > THRESHOLD_CHARS:
            num_ctx = 131072
            tier = f"128k (Auto Deep Context: ~{char_count // 3.5:.0f} tokens - 64GB RAM)"
        else:
            num_ctx = 32768
            tier = f"32k (Auto Fast GPU: ~{char_count // 3.5:.0f} tokens)"

    payload = {
        "model": MODEL_NAME,
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_ctx": num_ctx,
            "temperature": 0.2
        }
    }
    if system_prompt:
        payload["system"] = system_prompt

    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            result_text = data.get("response", "")
            return f"[{MODEL_NAME} | {tier}]\n\n{result_text}"
    except Exception as e:
        return f"Error calling Ollama ({MODEL_NAME} - {tier}): {str(e)}"


def scan_and_search_codebase(query, search_path="/projects", file_patterns=None, max_files=10):
    """Scan local codebase files on disk and synthesize findings via local Qwen Coder."""
    if not os.path.exists(search_path):
        return f"Error: Search directory not found at {search_path}"

    matches = []
    terms = [t.lower() for t in query.split() if len(t) > 2]

    # Try fast ripgrep if installed
    rg_found = False
    try:
        cmd = ["rg", "-i", "-l", "--max-count", "1", query, search_path]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=False)
        if proc.returncode == 0 and proc.stdout:
            for line in proc.stdout.splitlines():
                p = line.strip()
                if p and os.path.isfile(p):
                    matches.append(p)
            rg_found = True
    except Exception:
        rg_found = False

    # Fallback to Python file walking if rg didn't find enough or is absent
    if len(matches) < max_files:
        for root, dirs, files in os.walk(search_path):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
            for file in files:
                if len(matches) >= max_files:
                    break
                if file_patterns and not any(fnmatch.fnmatch(file, pat) for pat in file_patterns):
                    continue
                ext = os.path.splitext(file)[1].lower()
                if ext in {".png", ".jpg", ".jpeg", ".ico", ".dll", ".exe", ".bin", ".zip", ".tar", ".gz", ".pck"}:
                    continue
                full_path = os.path.join(root, file)
                if full_path in matches:
                    continue
                try:
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                        text = f.read(50000)
                    lower_text = text.lower()
                    if query.lower() in lower_text or (terms and any(t in lower_text for t in terms)):
                        matches.append(full_path)
                except Exception:
                    continue

    if not matches:
        return f"No files matching query '{query}' were found in '{search_path}'."

    # Build snippet context from matched files
    context_chunks = []
    for fpath in matches[:max_files]:
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            # If file is moderate size, include whole file; if large, extract relevant window
            if len(lines) <= 200:
                snippet = "".join(f"{i+1}: {line}" for i, line in enumerate(lines))
            else:
                matched_line_indices = []
                for i, line in enumerate(lines):
                    if query.lower() in line.lower() or any(t in line.lower() for t in terms):
                        matched_line_indices.append(i)
                if not matched_line_indices:
                    snippet = "".join(f"{i+1}: {line}" for i, line in enumerate(lines[:100]))
                else:
                    snippet_lines = []
                    included = set()
                    for idx in matched_line_indices[:15]:
                        start = max(0, idx - 5)
                        end = min(len(lines), idx + 6)
                        for k in range(start, end):
                            if k not in included:
                                included.add(k)
                                snippet_lines.append(f"{k+1}: {lines[k]}")
                    snippet = "".join(snippet_lines)
            context_chunks.append(f"### File: {fpath}\n```\n{snippet}\n```\n")
        except Exception as e:
            context_chunks.append(f"### File: {fpath} (Read error: {e})\n")

    combined_context = "\n".join(context_chunks)
    system_prompt = (
        "You are an expert code search and intelligence engine running on RTX 3080. "
        "Analyze the provided code snippets from the codebase and synthesize a clear, comprehensive answer. "
        "Always cite exact file paths, line numbers, function/class signatures, and explain how the components interact. "
        "Be concise, technical, and prioritize actionable code insights."
    )
    prompt = (
        f"User Query: {query}\n\n"
        f"Search Path: {search_path}\n\n"
        f"Discovered Code Context:\n{combined_context}\n\n"
        "Provide a detailed summary of findings with file paths, line references, and architectural analysis."
    )

    return call_ollama(prompt, system_prompt=system_prompt, mode="auto")


def summarize_files_locally(file_paths, task_instruction, mode="auto"):
    """Read multiple files from disk and distill them locally via Qwen Coder."""
    context_chunks = []
    for path in file_paths:
        if not os.path.isabs(path):
            path = os.path.abspath(path)
        if not os.path.exists(path):
            context_chunks.append(f"### File: {path}\n(Error: File not found)\n")
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            context_chunks.append(f"### File: {path}\n```\n{content}\n```\n")
        except Exception as e:
            context_chunks.append(f"### File: {path}\n(Error reading file: {e})\n")

    combined_context = "\n".join(context_chunks)
    system_prompt = (
        "You are a code distillation specialist running on local RTX 3080. "
        "Extract public interfaces, class structures, schemas, and concise explanations as requested. "
        "Do not repeat unnecessary filler."
    )
    prompt = f"Files Content:\n{combined_context}\n\nTask:\n{task_instruction}"
    return call_ollama(prompt, system_prompt=system_prompt, mode=mode)


def draft_code_locally(task, reference_files=None, mode="fast_32k"):
    """Draft code, boilerplate, test suites, or syntax conversions using Qwen Coder."""
    ref_context = ""
    if reference_files:
        chunks = []
        for ref in reference_files:
            if os.path.isfile(ref):
                try:
                    with open(ref, "r", encoding="utf-8", errors="replace") as f:
                        chunks.append(f"Reference File: {ref}\n```\n{f.read()}\n```")
                except Exception:
                    pass
        if chunks:
            ref_context = "\n\nReference Material:\n" + "\n".join(chunks)

    system_prompt = (
        "You are Qwen 2.5 Coder running on RTX 3080. "
        "Write clean, idiomatic, high-quality production code with proper error handling, types, and comments. "
        "Return complete code implementations."
    )
    prompt = f"Coding Task:\n{task}{ref_context}\n\nGenerate the complete solution:"
    return call_ollama(prompt, system_prompt=system_prompt, mode=mode)


def main():
    log_debug(f"ollama-helper MCP server starting. PID: {os.getpid()}, argv: {sys.argv}")
    while True:
        try:
            line = sys.stdin.readline()
        except Exception as e:
            log_debug(f"stdin readline error: {e}")
            break
        if not line:
            log_debug("stdin EOF encountered. Exiting main loop.")
            break
        line = line.strip()
        if not line:
            continue
        log_debug(f"RECV: {line}")
        try:
            req = json.loads(line)
        except Exception as e:
            log_debug(f"json decode error: {e}")
            continue

        method = req.get("method")
        msg_id = req.get("id")

        if method == "initialize":
            send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": req.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {
                        "tools": {"listChanged": False},
                        "prompts": {"listChanged": False},
                        "resources": {"subscribe": False, "listChanged": False}
                    },
                    "serverInfo": {"name": "ollama-helper", "version": "2.0.0"}
                }
            })
        elif method in ("notifications/initialized", "initialized"):
            log_debug("Client confirmed initialized.")
        elif method == "tools/list":
            send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "tools": [
                        {
                            "name": "ask_local_helper",
                            "description": (
                                "Reads one file or note on disk (code, markdown notes, logs) and answers a question about it "
                                "using local Qwen Coder on the RTX 3080 GPU with 0 cloud tokens. Good for digesting long logs "
                                "and large files. LIMITS: the answer is a 7B-model summary, not ground truth. It can hedge "
                                "('likely'), misattribute behaviour, and miss details. Verify anything you will act on or quote "
                                "by reading the cited lines yourself."
                            ),
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "prompt": {
                                        "type": "string",
                                        "description": "Task, question, or instruction for local Qwen Coder."
                                    },
                                    "file_path": {
                                        "type": "string",
                                        "description": "Optional path to local file or note on disk."
                                    },
                                    "system_prompt": {
                                        "type": "string",
                                        "description": "Optional system prompt."
                                    },
                                    "mode": {
                                        "type": "string",
                                        "enum": ["auto", "fast_32k", "deep_128k"],
                                        "description": "Context tier ('auto', 'fast_32k', 'deep_128k')."
                                    }
                                },
                                "required": ["prompt"]
                            }
                        },
                        {
                            "name": "local_code_search_and_scan",
                            "description": (
                                "Use to LOCATE candidate files and notes: searches codebase files or Obsidian Vault notes "
                                "directly on disk (e.g. in /projects/buddy, /projects/buddy-memory), picks relevant snippets, "
                                "and has local Qwen Coder on the RTX 3080 summarise them with 0 cloud tokens. LIMITS: it ranks "
                                "files by keyword relevance and does not follow call chains, so it can point at the wrong files, "
                                "miss the key one, or guess ('likely') about behaviour. Treat the file paths as leads and the "
                                "prose as unverified: open the cited files before drawing conclusions about how code behaves, "
                                "making decisions, or quoting line numbers."
                            ),
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "query": {
                                        "type": "string",
                                        "description": "Feature, person, fact, note topic, or logic to search for."
                                    },
                                    "path": {
                                        "type": "string",
                                        "description": "Directory or root to search (default '/projects'). For vault notes, use '/projects/buddy-memory'."
                                    },
                                    "file_patterns": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "Optional list of file globs, e.g. ['*.cs', '*.ts', '*.py', '*.md', '*.gd']."
                                    },
                                    "max_files": {
                                        "type": "integer",
                                        "description": "Max files to analyze (default 10)."
                                    }
                                },
                                "required": ["query"]
                            }
                        },
                        {
                            "name": "local_summarize_files",
                            "description": (
                                "Reads multiple files or notes directly from disk and uses local Qwen Coder with 32k/128k "
                                "context to distill information, schemas, or answers without consuming cloud tokens. "
                                "LIMITS: the result is a model summary and can be incomplete or wrong on behaviour. Good for "
                                "orientation; verify anything you will act on or quote by reading the files yourself."
                            ),
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "file_paths": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "List of file paths to inspect."
                                    },
                                    "task_instruction": {
                                        "type": "string",
                                        "description": "What to extract or summarize from these files."
                                    },
                                    "mode": {
                                        "type": "string",
                                        "enum": ["auto", "fast_32k", "deep_128k"],
                                        "description": "Context tier."
                                    }
                                },
                                "required": ["file_paths", "task_instruction"]
                            }
                        },
                        {
                            "name": "local_draft_code",
                            "description": (
                                "Drafts boilerplate, data models, test suites, or syntax translations using local Qwen Coder on GPU. "
                                "LIMITS: first drafts only. Review and test its output before applying it."
                            ),
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "task": {
                                        "type": "string",
                                        "description": "The coding task to implement."
                                    },
                                    "reference_files": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "Optional paths to reference files for style or type definitions."
                                    },
                                    "mode": {
                                        "type": "string",
                                        "enum": ["fast_32k", "deep_128k"],
                                        "description": "Context tier."
                                    }
                                },
                                "required": ["task"]
                            }
                        }
                    ]
                }
            })
        elif method == "tools/call":
            params = req.get("params", {})
            tool_name = params.get("name", "")
            args = params.get("arguments", {})

            if tool_name == "ask_local_helper":
                prompt = args.get("prompt", "")
                file_path = args.get("file_path", "")
                system_prompt = args.get("system_prompt", "")
                mode = args.get("mode", "auto")
                output = call_ollama(prompt, system_prompt, file_path, mode)
            elif tool_name == "local_code_search_and_scan":
                query = args.get("query", "")
                search_path = args.get("path", "/projects")
                file_patterns = args.get("file_patterns", None)
                max_files = args.get("max_files", 10)
                output = scan_and_search_codebase(query, search_path, file_patterns, max_files)
            elif tool_name == "local_summarize_files":
                file_paths = args.get("file_paths", [])
                task_instruction = args.get("task_instruction", "")
                mode = args.get("mode", "auto")
                output = summarize_files_locally(file_paths, task_instruction, mode)
            elif tool_name == "local_draft_code":
                task = args.get("task", "")
                reference_files = args.get("reference_files", None)
                mode = args.get("mode", "fast_32k")
                output = draft_code_locally(task, reference_files, mode)
            else:
                output = f"Unknown tool: {tool_name}"

            send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": output}],
                    "isError": False
                }
            })
        elif method == "ping":
            send_response({"jsonrpc": "2.0", "id": msg_id, "result": {}})
        elif method == "prompts/list":
            send_response({"jsonrpc": "2.0", "id": msg_id, "result": {"prompts": []}})
        elif method == "resources/list":
            send_response({"jsonrpc": "2.0", "id": msg_id, "result": {"resources": []}})
        elif method == "resources/templates/list":
            send_response({"jsonrpc": "2.0", "id": msg_id, "result": {"resourceTemplates": []}})
        elif method == "logging/setLevel":
            send_response({"jsonrpc": "2.0", "id": msg_id, "result": {}})
        else:
            log_debug(f"Unhandled method: '{method}', id: {msg_id}")
            if msg_id is not None:
                send_response({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method '{method}' not found"
                    }
                })


if __name__ == "__main__":
    main()
