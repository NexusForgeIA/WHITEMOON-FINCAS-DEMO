-- =====================================================================
-- Acceso controlado a los datos protegidos (IBAN y presidente)
-- =====================================================================
-- `fincas_privado` no está expuesto por PostgREST, así que la tabla no se
-- puede nombrar desde la API con ninguna clave. Estas dos funciones son la
-- ÚNICA puerta, y sólo `service_role` puede ejecutarlas: ni anon, ni un
-- usuario autenticado, ni el rol público.
--
-- Quien las usa es la Edge Function fincas-privado, que antes comprueba
-- que quien llama es un administrador con perfil activo. El agente de IA
-- no las llama: no tiene herramienta para ello y, además, su cliente de
-- base de datos lleva una lista blanca que no las incluye.

create or replace function public.fincas_privado_leer(p_comunidad uuid)
returns table (
  presidente_nombre text,
  presidente_contacto text,
  iban text,
  notas text,
  actualizado_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, fincas_privado
as $$
  select d.presidente_nombre, d.presidente_contacto, d.iban, d.notas, d.actualizado_at
  from fincas_privado.datos_comunidad d
  where d.comunidad_id = p_comunidad;
$$;

create or replace function public.fincas_privado_guardar(
  p_comunidad uuid,
  p_presidente_nombre text,
  p_presidente_contacto text,
  p_iban text,
  p_notas text,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, fincas_privado
as $$
begin
  insert into fincas_privado.datos_comunidad as d
    (comunidad_id, presidente_nombre, presidente_contacto, iban, notas, actualizado_at)
  values
    (p_comunidad, coalesce(p_presidente_nombre, ''), coalesce(p_presidente_contacto, ''),
     coalesce(p_iban, ''), coalesce(p_notas, ''), now())
  on conflict (comunidad_id) do update
    set presidente_nombre   = excluded.presidente_nombre,
        presidente_contacto = excluded.presidente_contacto,
        iban                = excluded.iban,
        notas               = excluded.notas,
        actualizado_at      = now();

  -- En la auditoría se deja constancia de QUE se tocó el dato protegido y
  -- de quién lo tocó. Nunca el valor: un registro de auditoría legible por
  -- todo el equipo no es sitio para un IBAN.
  insert into fincas_auditoria (actor, accion, entidad, detalle)
  values (coalesce(nullif(p_actor, ''), 'servicio'),
          'datos_protegidos_actualizados',
          'fincas_privado.datos_comunidad',
          jsonb_build_object('comunidad_id', p_comunidad,
                             'iban_presente', coalesce(p_iban, '') <> ''));
end;
$$;

revoke execute on function public.fincas_privado_leer(uuid)                      from public, anon, authenticated;
revoke execute on function public.fincas_privado_guardar(uuid, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.fincas_privado_leer(uuid)                      to service_role;
grant  execute on function public.fincas_privado_guardar(uuid, text, text, text, text, text) to service_role;
