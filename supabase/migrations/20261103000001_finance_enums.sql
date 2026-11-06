-- Finance officer: pays approved subcontractor certificates and labour payrolls (20261103000010_payments.sql).
-- Enum values cannot be used in the transaction that adds them, so this file holds ONLY the enum change.
alter type public.app_role add value if not exists 'finance';
