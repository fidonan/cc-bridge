# Bug: Relay JSON files with CJK content fail to parse

**Date**: 2026-03-29
**Severity**: Medium
**Status**: Identified (workaround: use python json.dump)

## Symptom

Daemon logs `JSON Parse error: Unrecognized token '虽'` when reading relay message files containing CJK characters with shell-written heredoc JSON.

## Root Cause

When writing relay messages manually via bash heredoc (`cat > file << EOF`), Chinese quotation marks `""` inside JSON string values are not escaped. The JSON parser interprets `"` (U+201C) as a standard double-quote `"` (U+0022), breaking the JSON structure.

Example broken content field:
```
"content": "讨论"虽有荣观，燕处超然"这句话"
```

The `"` before `虽` is parsed as closing the JSON string, and `虽` becomes an unexpected token.

## Fix

Always use a proper JSON serializer (e.g., `python3 json.dump` with `ensure_ascii=False`) instead of bash heredoc for relay message files containing non-ASCII content. The CLI `cc-bridge reply` command already uses proper JSON serialization via `JSON.stringify` and is not affected.

## Workaround

Replace bash heredoc with python:
```bash
python3 -c "
import json, time, os
msg = {'content': '中文内容', ...}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(msg, f, ensure_ascii=False)
"
```
