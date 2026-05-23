# Contributing

Thanks for your interest!

## Quick start

1. Fork the repo, create a feature branch off `main`: `git checkout -b feat/your-feature`
2. Make your change. Keep it small and focused.
3. Run quality gates:
   - Backend: `pytest backend/tests/ -x` and `ruff check backend/`
   - Frontend: `cd web && npm run build`
4. Open a PR. Describe the WHY in the first paragraph.

## Conventions

- Real data only. No mock data, no placeholder content.
- No em dashes in user-facing copy.
- Karpathy guidelines: simple, no speculative abstractions, no premature error handling.
- Branch naming: `feat/<name>`, `fix/<name>`, `docs/<name>`.

## Questions

Open an issue. Tag with `question` label.

