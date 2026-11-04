# WBFC equipment rental scheduled integration

Board: https://wbfc.monday.com/boards/18438455065

## Setup
1. Review the code and merge the feature branch after approval.
2. In GitHub repository Settings > Secrets and variables > Actions, create repository secret `MONDAY_API_TOKEN` with a monday.com API token authorized for the WBFC board.
3. Manually dispatch **WBFC Equipment Rental Daily Check** with `apply_changes=false` to review dry-run output.
4. After validating against test rental records, set Actions repository variable `WBFC_EQUIPMENT_ENABLED=true` to enable scheduled writes. Until then, scheduled runs are dry-run.
5. Run a manual `apply_changes=true` test only with controlled test items and verify dates/alerts.

The scheduled cron runs at 14:15 UTC (08:15 CST / 09:15 CDT). All date comparisons use America/Chicago.

## Rules
- Only rentals with status On Rent or Call-Off Requested are processed.
- Calendar-month anniversaries are anchored to original rental start, clamped to the final day of shorter months. Vendor-specific override takes precedence.
- Keep the current anniversary through the +1-day native reminder before advancing it.
- Over-plan notifications begin at 3 days late and repeat no more often than every 3 days; sent only while On Rent and not called off or returned.
- Alerts go to all people assigned to Rental Coordinator / Alert Recipients.
- Existing native 5-day call-off and monthly anniversary alerts remain in monday.com.
- Actual vendor billing is recorded separately in the board; this integration never invents invoice amounts.

## Caveats
- GitHub Actions scheduled runs may be delayed. An external scheduled runner may be needed for strict delivery SLAs.
- Billing cycle semantics for monthly rentals and the month-end policy should be confirmed against vendor contracts.
- Date-triggered native anniversary automations and auto-advancing dates require a controlled integration test to ensure no missed or duplicate notifications.
- This integration uses the monday.com GraphQL API and requires an appropriately scoped token. Never commit secrets.
