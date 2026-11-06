-- =============================================================================
-- Material procurement flows — enum additions ONLY.
--
-- New mr_status values for the Purchase Request flow (A) and the shared
-- 'received' status (both flows). Kept in their own migration because a value
-- added with `alter type ... add value` cannot be used until the transaction
-- that added it has committed; 20261030000002_mr_flows.sql uses them.
-- See docs/research/procurement-lookahead.md §3, §4, §6.
-- =============================================================================

alter type public.mr_status add value if not exists 'reviewed_by_coordinator' after 'reviewed';
alter type public.mr_status add value if not exists 'approved_by_management' after 'approved';
alter type public.mr_status add value if not exists 'with_procurement' after 'approved_by_management';
alter type public.mr_status add value if not exists 'delivery_expected' after 'ordered';
alter type public.mr_status add value if not exists 'partially_received' after 'delivery_expected';
alter type public.mr_status add value if not exists 'received' after 'issued';
