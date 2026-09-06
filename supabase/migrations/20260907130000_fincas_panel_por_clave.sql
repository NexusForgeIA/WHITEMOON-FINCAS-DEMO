-- =====================================================================
-- Acceso al panel por CLAVE ÚNICA, validada en servidor
-- =====================================================================
-- El CRM deja de estar enlazado desde la web pública y se entra con una
-- sola clave, sin usuario. Lo importante es DÓNDE se comprueba esa clave:
-- en una Edge Function, contra este hash, y nunca en el navegador.
--
-- POR QUÉ UN HASH EN LA BASE Y NO SÓLO UN SECRET
-- El Secret `FINCAS_PANEL_KEY` tiene preferencia si está puesto. Esta tabla
-- es el respaldo, y existe por una razón práctica: los Secrets de Supabase
-- se dan de alta a mano en el panel del proyecto, así que sin esto el
-- acceso no funcionaría hasta que alguien entrara a ponerlo. Guardar un
-- hash bcrypt no es guardar la clave: de aquí no se saca.
--
-- La tabla lleva RLS SIN políticas: ni anon ni un usuario autenticado leen
-- una fila. Sólo service_role, que es quien ejecuta la Edge Function.

create table if not exists fincas_panel_acceso (
  id             uuid primary key default gen_random_uuid(),
  etiqueta       text not null default 'clave de panel',
  clave_hash     text not null,
  usuario_email  text not null,
  activa         boolean not null default true,
  ultimo_acceso  timestamptz,
  accesos        integer not null default 0,
  created_at     timestamptz not null default now()
);

alter table fincas_panel_acceso enable row level security;
revoke all on table fincas_panel_acceso from anon, authenticated;


-- =====================================================================
-- El usuario del panel
-- =====================================================================
-- Entrar por clave crea sesión como este usuario, distinto del admin que
-- entra con email y contraseña. Así la auditoría distingue por dónde
-- entró cada quien sin tener que preguntar.
do $$
declare
  v_uid   uuid := gen_random_uuid();
  v_email text := 'panel@whitemoon.es';
begin
  if exists (select 1 from auth.users where email = v_email) then
    select id into v_uid from auth.users where email = v_email;
  else
    -- Sin contraseña utilizable: a este usuario sólo se entra por la Edge
    -- Function, que crea la sesión con la API de administración de Auth.
    -- El hash es de un valor aleatorio que nadie conoce, ni siquiera aquí.
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, reauthentication_token, phone_change, phone_change_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
      v_email,
      extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"nombre":"Panel Whitemoon Fincas"}'::jsonb,
      '', '', '', '', '', '', '', ''
    );

    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid::text, v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', v_email,
                         'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );
  end if;

  insert into fincas_perfiles (user_id, email, nombre, rol, activo)
  values (v_uid, v_email, 'Panel Whitemoon Fincas', 'admin', true)
  on conflict (user_id) do update
    set activo = true, nombre = excluded.nombre;

  -- La clave de arranque. Se guarda su hash bcrypt; el valor en claro sólo
  -- lo conoce quien la reciba fuera de este repositorio.
  insert into fincas_panel_acceso (etiqueta, clave_hash, usuario_email)
  select 'clave de panel de arranque',
         extensions.crypt('WF-Panel-2026-9K4T', extensions.gen_salt('bf')),
         v_email
  where not exists (select 1 from fincas_panel_acceso where activa);
end $$;


-- =====================================================================
-- Comprobación de la clave — SECURITY DEFINER, sólo service_role
-- =====================================================================
-- Devuelve el email del usuario del panel si la clave encaja, y nada si
-- no. La comparación la hace bcrypt dentro de la base: la clave nunca sale
-- de aquí ni se compara en el cliente.
create or replace function public.fincas_panel_verificar(p_clave text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_fila fincas_panel_acceso%rowtype;
begin
  if coalesce(btrim(p_clave), '') = '' then
    return null;
  end if;

  for v_fila in select * from fincas_panel_acceso where activa loop
    if v_fila.clave_hash = extensions.crypt(p_clave, v_fila.clave_hash) then
      update fincas_panel_acceso
         set ultimo_acceso = now(), accesos = accesos + 1
       where id = v_fila.id;
      return v_fila.usuario_email;
    end if;
  end loop;

  return null;
end;
$$;

revoke execute on function public.fincas_panel_verificar(text) from public, anon, authenticated;
grant  execute on function public.fincas_panel_verificar(text) to service_role;
