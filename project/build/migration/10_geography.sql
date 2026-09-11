-- =====================================================================
-- 10 · GEOGRAPHY — Crux Zone → State → City → Branch.
-- The old sheet held 36 Zone values mixing compass points, states and cities,
-- with 'Goa' and 'GOA' as separate rows. The unique index on
-- (parent, lower(name)) makes that impossible; this script decides the
-- mapping and sends every case it cannot decide to migration_review.
-- Rules: G-01 canonical zones · G-02 ROMG · G-03 Indore-MPCG · G-04 unknown.
-- =====================================================================

-- G-01 · the six canonical zones are seeded, not derived
insert into geo_node (parent_id, level, name)
select null, 'ZONE', z from (values ('North'),('South'),('East'),('West'),('Central'),('North East')) v(z)
on conflict do nothing;

-- the state → zone table is explicit. Nothing is guessed from a name.
create table stg.state_zone (state text primary key, zone text not null);
insert into stg.state_zone values
 ('Delhi','North'),('Haryana','North'),('Punjab','North'),('Himachal Pradesh','North'),
 ('Jammu & Kashmir','North'),('Uttarakhand','North'),('Uttar Pradesh','North'),('Rajasthan','North'),
 ('Maharashtra','West'),('Gujarat','West'),('Goa','West'),('Dadra & Nagar Haveli','West'),
 ('Karnataka','South'),('Tamil Nadu','South'),('Kerala','South'),('Andhra Pradesh','South'),
 ('Telangana','South'),('Puducherry','South'),
 ('West Bengal','East'),('Bihar','East'),('Jharkhand','East'),('Odisha','East'),
 ('Madhya Pradesh','Central'),('Chhattisgarh','Central'),
 ('Assam','North East'),('Meghalaya','North East'),('Tripura','North East'),('Manipur','North East'),
 ('Nagaland','North East'),('Mizoram','North East'),('Arunachal Pradesh','North East'),('Sikkim','North East');

insert into geo_node (parent_id, level, name)
select z.id, 'STATE', sz.state
from stg.state_zone sz join geo_node z on z.level = 'ZONE' and z.name = sz.zone
on conflict do nothing;

-- G-02 · ROMG is "Rest of Maharashtra & Goa" in the sheet but the owner's
-- definition is Maharashtra excluding Mumbai and Pune. Mumbai and Pune are
-- ordinary cities under West → Maharashtra; ROMG is therefore NOT a node —
-- it resolves to Maharashtra and the city carries the distinction.
-- G-03 · Indore-MPCG is two states. The city decides which.
create table stg.city_state (city text primary key, state text not null);
insert into stg.city_state values
 ('Mumbai','Maharashtra'),('Navi Mumbai','Maharashtra'),('Thane','Maharashtra'),('Pune','Maharashtra'),
 ('Nashik','Maharashtra'),('Nagpur','Maharashtra'),('Aurangabad','Maharashtra'),('Kolhapur','Maharashtra'),
 ('Solapur','Maharashtra'),('Amravati','Maharashtra'),('Panaji','Goa'),('Margao','Goa'),
 ('Indore','Madhya Pradesh'),('Bhopal','Madhya Pradesh'),('Jabalpur','Madhya Pradesh'),
 ('Gwalior','Madhya Pradesh'),('Ujjain','Madhya Pradesh'),('Sagar','Madhya Pradesh'),
 ('Raipur','Chhattisgarh'),('Bilaspur','Chhattisgarh'),('Durg','Chhattisgarh'),
 ('Bhilai','Chhattisgarh'),('Korba','Chhattisgarh'),('Raigarh','Chhattisgarh');

-- cities present in the sheet are created under their state; case-collapsed
insert into geo_node (parent_id, level, name)
select s.id, 'CITY', stg.norm_name(cs.city)
from stg.city_state cs
join geo_node s on s.level = 'STATE' and s.name = cs.state
on conflict do nothing;

-- every distinct city string in BRANCHES that we can place
insert into geo_node (parent_id, level, name)
select distinct s.id, 'CITY'::geo_level, stg.norm_name(b.city)
from stg.branches b
join stg.city_state cs on lower(cs.city) = lower(btrim(b.city))
join geo_node s on s.level = 'STATE' and s.name = cs.state
where stg.present(b.city)
on conflict do nothing;

-- G-04 · anything unplaceable becomes a question for a human, with the
-- address as context. No branch is guessed into a state.
insert into migration_review (entity_type, entity_ref, question, context)
select 'branch',
       'BRANCHES!' || b.row_no,
       case when not stg.present(b.city) and not stg.present(b.state)
              then 'No city or state on this branch — which state?'
            when lower(coalesce(b.zone,'')) like '%mpcg%'
              then 'Madhya Pradesh or Chhattisgarh?'
            else 'City "' || btrim(coalesce(b.city, b.state, b.zone)) || '" is not in the state table — which state?' end,
       concat_ws(' | ', nullif(btrim(b.address),''), nullif(btrim(b.zone),''), nullif(btrim(b.state),''), nullif(btrim(b.city),''))
from stg.branches b
where stg.present(b.code) or stg.present(b.name)
  and not exists (select 1 from stg.city_state cs where lower(cs.city) = lower(btrim(b.city)));
