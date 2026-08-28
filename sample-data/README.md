# Sample data (fabricated)

Everything in this folder is **invented for the demo**. No company, person,
address, phone number, or email here is real, and none of it came from any
campaign this engine has run.

- Domains use the reserved `.example` top-level domain, which cannot resolve.
- Message IDs generated during a dry run use `.invalid`, which is also reserved.
- Phone numbers are in the `555-01xx` block reserved for fiction.
- Names are made up. No real firm appears as a sample prospect.

One deliberate exception, and it is not in this folder: the ICP blocklists in
`config/industries/*.json` name real accounting and dental chains. That is what a
blocklist is for. A blocklist that only rejects invented firms would prove
nothing and protect nobody.

The sample set is shaped to exercise every branch of the routing rules, not to
look like a real prospect list:

| Sample company | What it demonstrates |
|---|---|
| Northgate Books | Named decision maker verifies clean, owner track, then a positive reply |
| Harborlight Tax Group | Personal address bounces, role mailbox is used instead, then an out-of-office auto reply |
| Quill CPA Studio | Personal address bounces with no fallback, so the lead is dropped and the domain remembered |
| Maple Ledger Associates | No enrichable contact, role mailbox verifies, negative reply |
| Bayonne Tax Services | Proves the blocklist matches whole words ("ey" must not reject "Bayonne"), then an unsubscribe |
| Grantham National Tax Partners | An invented national chain, rejected by the ICP blocklist before any credit is spent |
| Summit Books and Payroll | Risky verdict, held for a human instead of sent |
| Cedar Close CPA | Owner contact with no title, demoted to the general track so no hollow greeting is sent |
| Riverbend Tax Corner | Below the rating and review floor |
| Ironwood Accounting Co-op | No page content to research, held rather than sent with empty copy |
| Brightmile Family Dental, Oakframe Orthodontics | Only reachable by the dental profile, showing the industry swap |
