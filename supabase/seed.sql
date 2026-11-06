-- Reference data: activity sequences (FR-PG-01) and a starter material
-- catalogue with grades (FR-MD-05). Safe to re-run.

insert into public.activity_templates (element_type, seq, name, weight, is_hold_point) values
  ('footing',   1, 'Excavation / preparation', 10, false),
  ('footing',   2, 'Blinding',                  5, false),
  ('footing',   3, 'Rebar fixing',             25, false),
  ('footing',   4, 'Formwork',                 15, false),
  ('footing',   5, 'Rebar & formwork inspection', 5, true),
  ('footing',   6, 'Casting',                  30, false),
  ('footing',   7, 'Curing',                    5, false),
  ('footing',   8, 'Backfill',                  5, false),
  ('column',    1, 'Preparation',               5, false),
  ('column',    2, 'Rebar fixing',             25, false),
  ('column',    3, 'Formwork',                 20, false),
  ('column',    4, 'Rebar & formwork inspection', 5, true),
  ('column',    5, 'Casting',                  30, false),
  ('column',    6, 'Curing',                    5, false),
  ('column',    7, 'Stripping',                10, false),
  ('beam',      1, 'Formwork',                 25, false),
  ('beam',      2, 'Rebar fixing',             25, false),
  ('beam',      3, 'Rebar & formwork inspection', 5, true),
  ('beam',      4, 'Casting',                  30, false),
  ('beam',      5, 'Curing',                    5, false),
  ('beam',      6, 'Stripping',                10, false),
  ('slab',      1, 'Formwork / shoring',       25, false),
  ('slab',      2, 'Rebar fixing',             25, false),
  ('slab',      3, 'MEP sleeves & embeds',      5, false),
  ('slab',      4, 'Pre-pour inspection',       5, true),
  ('slab',      5, 'Casting',                  25, false),
  ('slab',      6, 'Curing',                    5, false),
  ('slab',      7, 'Stripping',                10, false),
  ('wall',      1, 'Setting out',               5, false),
  ('wall',      2, 'Blockwork / masonry',      60, false),
  ('wall',      3, 'Lintels & ties',           15, false),
  ('wall',      4, 'Plastering',               20, false),
  ('staircase', 1, 'Formwork',                 25, false),
  ('staircase', 2, 'Rebar fixing',             25, false),
  ('staircase', 3, 'Pre-pour inspection',       5, true),
  ('staircase', 4, 'Casting',                  30, false),
  ('staircase', 5, 'Curing & stripping',       15, false)
on conflict (element_type, seq) do nothing;

insert into public.materials (category, name, standard_ref) values
  ('Concrete',      'Concrete',          'ES / EBCS-2'),
  ('Reinforcement', 'Rebar',             'ES / EBCS-2'),
  ('Cement',        'Cement',            'ES 1177'),
  ('Blocks',        'HCB',               'ES 596'),
  ('Aggregate',     'Sand',              null),
  ('Aggregate',     'Coarse aggregate',  null),
  ('Accessories',   'Binding wire',      null),
  ('Formwork',      'Formwork timber',   null),
  ('Waterproofing', 'Bituminous membrane', null)
on conflict (category, name) do nothing;

with m as (select id, name from public.materials)
insert into public.material_specs (material_id, grade, uom, wastage_pct, lead_time_days, track_batches)
select m.id, v.grade, v.uom, v.wastage, v.lead, v.batches
from (values
  ('Concrete', 'C-20/25', 'm3', 2, 1, true),
  ('Concrete', 'C-25/30', 'm3', 2, 1, true),
  ('Concrete', 'C-30/37', 'm3', 2, 1, true),
  ('Rebar', 'S-400 Ø8',  'kg', 3, 7, true),
  ('Rebar', 'S-400 Ø10', 'kg', 3, 7, true),
  ('Rebar', 'S-400 Ø12', 'kg', 3, 7, true),
  ('Rebar', 'S-400 Ø14', 'kg', 3, 7, true),
  ('Rebar', 'S-400 Ø16', 'kg', 3, 7, true),
  ('Rebar', 'S-400 Ø20', 'kg', 3, 7, true),
  ('Rebar', 'S-400 Ø24', 'kg', 3, 7, true),
  ('Rebar', 'S-500 Ø16', 'kg', 3, 10, true),
  ('Rebar', 'S-500 Ø20', 'kg', 3, 10, true),
  ('Rebar', 'S-500 Ø32', 'kg', 3, 10, true),
  ('Cement', 'OPC 42.5', 'qtl', 2, 3, true),
  ('Cement', 'PPC 32.5', 'qtl', 2, 3, true),
  ('HCB', '20cm Class B', 'pcs', 5, 5, false),
  ('HCB', '15cm Class B', 'pcs', 5, 5, false),
  ('HCB', '10cm Class C', 'pcs', 5, 5, false),
  ('Sand', '', 'm3', 10, 2, false),
  ('Coarse aggregate', '02 (12–20mm)', 'm3', 8, 2, false),
  ('Binding wire', 'No. 18', 'kg', 5, 3, false),
  ('Formwork timber', 'Eucalyptus 4x5', 'pcs', 10, 5, false),
  ('Bituminous membrane', '4mm', 'm2', 8, 14, false)
) as v(material, grade, uom, wastage, lead, batches)
join m on m.name = v.material
on conflict (material_id, grade) do nothing;

-- Alternative units (FR-ST-12): bags of cement, bars of rebar (12 m lengths).
insert into public.spec_conversions (material_spec_id, alt_uom, factor)
select s.id, v.alt, v.factor
from public.material_specs s join public.materials m on m.id = s.material_id
join (values
  ('Cement', 'OPC 42.5', 'bag (50kg)', 0.5),
  ('Cement', 'PPC 32.5', 'bag (50kg)', 0.5),
  ('Rebar', 'S-400 Ø8',  'bar 12m', 4.74),
  ('Rebar', 'S-400 Ø10', 'bar 12m', 7.40),
  ('Rebar', 'S-400 Ø12', 'bar 12m', 10.66),
  ('Rebar', 'S-400 Ø14', 'bar 12m', 14.50),
  ('Rebar', 'S-400 Ø16', 'bar 12m', 18.94),
  ('Rebar', 'S-400 Ø20', 'bar 12m', 29.59),
  ('Rebar', 'S-400 Ø24', 'bar 12m', 42.62),
  ('Rebar', 'S-400 Ø8',  'tonne', 1000),
  ('Rebar', 'S-400 Ø16', 'tonne', 1000),
  ('Sand', '', 'truck (7m3)', 7),
  ('Coarse aggregate', '02 (12–20mm)', 'truck (7m3)', 7)
) as v(material, grade, alt, factor) on v.material = m.name and v.grade = s.grade
on conflict (material_spec_id, alt_uom) do nothing;
