# KAD Local AI — Persistent Uploads (Original v5 UI)

The `static/index.html` and `static/style.css` files are unchanged from the original v5 UI.

## Setup

```bash
sudo apt install -y poppler-utils
cd ~/kad-local-ai-persistent
npm install
npm start
```

Open http://127.0.0.1:3000. Ollama must be running; the app auto-detects installed models (vision model used for images/PDFs). Optional overrides: `OLLAMA_MODEL` (vision), `OLLAMA_TEXT_MODEL`, `OLLAMA_URL`.

## Behavior

- Choosing, dropping, or pasting a file immediately POSTs to `/api/files/upload`.
- `express-fileupload` saves the file to `uploads/<UUID>.<ext>` and metadata to `uploads/<UUID>.json`.
- Chat and workbook endpoints accept JSON `fileIds` and read saved paths.
- Uploaded files are **not deleted** after use, nor on restart. Generated workbooks are retained.
- Attachments are associated with the current browser conversation and reused in follow-ups (up to 5 most recent).
- The original UI is preserved, with upload status added inside the existing attachment chips.

**Security:** Intended for local/trusted network use only. Add authentication and per-user file ownership before internet exposure. Uploads accumulate indefinitely; monitor disk space. No automatic deletion is implemented.

**Limits:** 5 MB per file, 5 files per operation; PDFs are rendered as images and processed by Ollama. Existing generator has 12-page per-PDF and 450-record safeguards. AI outputs require review.
