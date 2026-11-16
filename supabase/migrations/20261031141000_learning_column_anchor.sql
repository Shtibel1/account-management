-- Learned rules: line_offset 2 = table columns (the OCR lists a table's labels first and its values
-- after them, in the same order; the value is paired with its label by position).
alter table public.extraction_learning_signals drop constraint if exists extraction_learning_signals_line_offset_check;
alter table public.extraction_learning_signals
  add constraint extraction_learning_signals_line_offset_check check (line_offset in (0, 1, 2));

alter table public.extraction_learned_rules drop constraint if exists extraction_learned_rules_line_offset_check;
alter table public.extraction_learned_rules
  add constraint extraction_learned_rules_line_offset_check check (line_offset in (0, 1, 2));
