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

## Extraction & Excel pipeline

Uploaded files → document type detection → text extraction / OCR → deterministic transaction parsing → deterministic validation → AI categorization → Excel.

- **PDFs:** digital text is read with `pdftotext -layout` (Poppler). Only pages with no usable text (scanned) or mostly-image pages are rendered and OCR'd with an installed Ollama vision model. Mixed PDFs are handled page by page. No page is skipped.
- **Models:** detected from Ollama `/api/tags` + `/api/show` capabilities; no model names in code. An already-loaded model is preferred so a second model is not loaded. Pick a model manually in the header dropdown if needed.
- **Column mapping:** table columns come from the PDF's real header positions (`pdftotext -bbox` word coordinates), so each amount lands under the header it sits beneath. Text is never written into amount columns.
- **Chat:** when a bank statement is attached, chat gets the deterministic table, and **Download validated Excel** builds the validated workbook (not the AI's text).
- **Bank statements:** rows are parsed without AI (dates, descriptions, withdrawals, deposits, balances, page and line numbers). Node validates with integer-cent arithmetic: running balances, debit/credit placement, duplicates, summary totals, opening/closing balances, and "Page X of Y" completeness. The workbook contains Summary, Transactions, Validation, Discrepancies, Category Summary and Source Text sheets. A workbook is marked verified only when every check passes. The AI only assigns categories.
- **Other documents:** AI designs the workbook from extracted text; numbers not found in the source are highlighted.
- **Persistence:** extractions are cached by SHA-256 in `~/.kad-local-ai-workbooks/extractions/` (override with `KAD_DATA_DIR`). Revisions reuse the cache. Workbook records store model, timestamps, sources and validation results.
- **Progress:** the Create Excel dialog polls `/api/jobs/:id`; there are no server-side response timeouts.

Run tests: `npm test` (parser/validator/extraction/model/regeneration; Poppler and Ollama are mocked).

**Limits:** 5 MB per file, 5 files per operation. AI categorization and OCR'd values still require review.
