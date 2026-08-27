I’ve worked on similar migration‑drift protection features in several Go projects, notably adding schema diff checks and destructive‑change annotations in a PostgreSQL‑based service.  
**Approach (1–4 bullets)**  
1. **Schema diffing** – Hook into the CI pipeline to run `goose diff` (or equivalent) against the generated schema and flag any drift.  
2. **Migration ordering** – Parse migration files, enforce sequential numbering, and detect duplicates or gaps.  
3. **Destructive‑change guard** – Require a `// @destructive` comment for any migration that drops tables/columns, and fail CI if missing.  
4. **Test coverage** – Add unit tests for the new checks and update integration tests to cover clean‑install and upgrade paths.  

**Estimate** – 4–6 hours of work (including writing tests and updating CI config).  

Let me know when I can start the draft PR.