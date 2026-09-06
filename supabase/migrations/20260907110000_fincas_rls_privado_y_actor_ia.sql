-- =====================================================================
-- 1 · RLS en el esquema privado — defensa en profundidad
-- =====================================================================
-- `fincas_privado` no está entre los esquemas que expone PostgREST, así que
-- hoy la tabla es inalcanzable desde la API. Pero eso es una línea de
-- configuración: si alguien añadiera el esquema a la lista expuesta (por
-- error, o buscando otra cosa), el IBAN quedaría al alcance de cualquiera
-- con la clave anon.
--
-- Se activa RLS **sin ninguna política**. Sin políticas, RLS deniega todo
-- por defecto: anon y authenticated no leerían ni una fila aunque el
-- esquema se expusiera mañana. Los que siguen entrando son los que tienen
-- BYPASSRLS —`service_role`— y el propietario de la tabla, que es quien
-- ejecuta las funciones SECURITY DEFINER `fincas_privado_leer` y
-- `fincas_privado_guardar`. Es decir: el único camino sigue siendo el que
-- ya existía, y ahora hay una cerradura más por debajo.
alter table fincas_privado.datos_comunidad enable row level security;


-- =====================================================================
-- 2 · La auditoría distingue a la IA de un proceso backend cualquiera
-- =====================================================================
-- Antes, todo lo que escribía una Edge Function con service role quedaba
-- como 'servicio', incluido lo que abría el agente. Para la pregunta que de
-- verdad se le hace a un registro de auditoría —"¿esto lo decidió una
-- persona o una máquina?"— 'servicio' respondía a medias: decía que no fue
-- una persona, pero no si fue la IA o el pipeline de correo.
--
-- CÓMO SE DISTINGUE
-- PostgREST publica las cabeceras de la petición en el GUC
-- `request.headers`. El agente manda `x-fincas-actor: agente-ia` en cada
-- escritura, y esta función la lee. El resto de procesos backend no la
-- mandan y siguen siendo 'servicio'.
--
-- POR QUÉ NO ES UN AGUJERO
-- La cabecera sólo se mira cuando NO hay persona detrás: si hay perfil o
-- un JWT con email, ganan esos. Y sólo se acepta el valor exacto
-- 'agente-ia'; cualquier otra cosa cae a 'servicio'. Es decir, nadie puede
-- firmar la auditoría con un nombre inventado, y quien pudiera mandar esa
-- cabecera ya necesita service role — que es justo lo que tiene el agente.
create or replace function public.fincas_actor()
returns text
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_email    text;
  v_cabecera text;
begin
  -- 1 · Persona del equipo, identificada por su perfil.
  select p.email into v_email
  from fincas_perfiles p
  where p.user_id = auth.uid();
  if v_email is not null then
    return v_email;
  end if;

  -- 2 · Cualquier otro JWT que traiga email.
  v_email := nullif(current_setting('request.jwt.claim.email', true), '');
  if v_email is not null then
    return v_email;
  end if;

  -- 3 · Proceso backend. Sólo el agente se identifica, y sólo con este
  --     valor exacto. Fuera de PostgREST el GUC no existe y esto es null.
  begin
    v_cabecera := current_setting('request.headers', true)::json ->> 'x-fincas-actor';
  exception when others then
    v_cabecera := null;
  end;

  if v_cabecera = 'agente-ia' then
    return 'agente-ia';
  end if;

  return 'servicio';
end;
$$;
