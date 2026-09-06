-- =====================================================================
-- Persona de contacto del proveedor y contacto del presidente
-- =====================================================================
-- Dos altas que ganan un contacto, y cada una en el sitio que le toca:
--
--   · El contacto del PROVEEDOR es un dato de empresa —a quién llamar en el
--     mantenedor de ascensores— y va en `fincas_proveedores`, en el esquema
--     público, protegido por la RLS de siempre.
--
--   · El contacto del PRESIDENTE es un dato PERSONAL de un vecino, con su
--     nombre, su teléfono y su email. Ese va donde el IBAN: al esquema
--     `fincas_privado`, que PostgREST no expone, con RLS y sin políticas, y
--     al que sólo se llega por la Edge Function fincas-privado. El agente
--     de IA no tiene forma de verlo, igual que no ve una cuenta bancaria.
-- =====================================================================


-- =====================================================================
-- 1 · Proveedores: persona de contacto
-- =====================================================================
alter table fincas_proveedores
  add column if not exists contacto_nombre text not null default '';


-- =====================================================================
-- 2 · Presidente: nombre, teléfono y email, en el esquema protegido
-- =====================================================================
-- Hasta ahora había un único `presidente_contacto` de texto libre donde
-- cabía cualquier cosa. Se separa en teléfono y email porque son datos
-- distintos, se validan distinto y se usan distinto.
alter table fincas_privado.datos_comunidad
  add column if not exists presidente_telefono text not null default '',
  add column if not exists presidente_email    text not null default '';

-- Lo que hubiera en el campo antiguo se conserva en el teléfono, que es lo
-- que solía apuntarse ahí. Sólo después se retira la columna.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'fincas_privado' and table_name = 'datos_comunidad'
      and column_name = 'presidente_contacto'
  ) then
    update fincas_privado.datos_comunidad
       set presidente_telefono = presidente_contacto
     where coalesce(presidente_telefono, '') = ''
       and coalesce(presidente_contacto, '') <> '';

    alter table fincas_privado.datos_comunidad drop column presidente_contacto;
  end if;
end $$;


-- =====================================================================
-- 3 · Los accesores, con la firma nueva
-- =====================================================================
-- La firma cambia, así que se retiran las versiones anteriores: dejarlas
-- crearía sobrecargas y PostgREST no sabría cuál llamar.
drop function if exists public.fincas_privado_leer(uuid);
drop function if exists public.fincas_privado_guardar(uuid, text, text, text, text, text);

create or replace function public.fincas_privado_leer(p_comunidad uuid)
returns table (
  presidente_nombre   text,
  presidente_telefono text,
  presidente_email    text,
  iban                text,
  notas               text,
  actualizado_at      timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, fincas_privado
as $$
  select d.presidente_nombre, d.presidente_telefono, d.presidente_email,
         d.iban, d.notas, d.actualizado_at
  from fincas_privado.datos_comunidad d
  where d.comunidad_id = p_comunidad;
$$;

create or replace function public.fincas_privado_guardar(
  p_comunidad           uuid,
  p_presidente_nombre   text,
  p_presidente_telefono text,
  p_presidente_email    text,
  p_iban                text,
  p_notas               text,
  p_actor               text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, fincas_privado
as $$
begin
  insert into fincas_privado.datos_comunidad as d
    (comunidad_id, presidente_nombre, presidente_telefono, presidente_email,
     iban, notas, actualizado_at)
  values
    (p_comunidad, coalesce(p_presidente_nombre, ''), coalesce(p_presidente_telefono, ''),
     coalesce(p_presidente_email, ''), coalesce(p_iban, ''), coalesce(p_notas, ''), now())
  on conflict (comunidad_id) do update
    set presidente_nombre   = excluded.presidente_nombre,
        presidente_telefono = excluded.presidente_telefono,
        presidente_email    = excluded.presidente_email,
        iban                = excluded.iban,
        notas               = excluded.notas,
        actualizado_at      = now();

  -- En la auditoría queda QUE se tocó el dato protegido y QUIÉN lo tocó,
  -- nunca el valor: un registro que lee todo el equipo no es sitio para el
  -- teléfono de un vecino ni para un IBAN.
  insert into fincas_auditoria (actor, accion, entidad, detalle)
  values (coalesce(nullif(p_actor, ''), 'servicio'),
          'datos_protegidos_actualizados',
          'fincas_privado.datos_comunidad',
          jsonb_build_object(
            'comunidad_id',       p_comunidad,
            'iban_presente',      coalesce(p_iban, '') <> '',
            'presidente_presente', coalesce(p_presidente_nombre, '') <> ''
          ));
end;
$$;

revoke execute on function public.fincas_privado_leer(uuid) from public, anon, authenticated;
revoke execute on function public.fincas_privado_guardar(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.fincas_privado_leer(uuid) to service_role;
grant  execute on function public.fincas_privado_guardar(uuid, text, text, text, text, text, text)
  to service_role;
